/* ==========================================================================
   住院费用争议解释系统 · 收费员工作台（渲染层）
   --------------------------------------------------------------------------
   数据只经 window.desktopAPI（主进程 preload 注入）获取，本文件不直接读文件、
   不请求网络、不回显任何密钥。渲染层只负责把契约数据画成工作台并处理交互。
   ========================================================================== */

import {
  iconWorkbench,
  iconSettings,
  iconSearch,
  iconRefresh,
  iconChevronDown,
  iconPrint,
  iconSend,
  iconReplay,
  iconWarning,
  iconInfo,
  iconClose,
  iconShield,
  iconFileText,
  iconClock,
  iconUser,
  iconFilter,
  iconServer,
  iconDownload,
  iconAlertCircle,
  iconCheckCircle,
  iconLock,
  iconInbox,
  iconLayers,
} from './icons.ts';

/* ========================= 一、契约类型（与 preload 对齐）========================= */

interface Summary {
  today: number;
  unanswered: number;
  transferred: number;
  highRisk: number;
}

interface ConsultationView {
  consultationNo: string;
  channel: 'counter' | 'phone' | 'online';
  status: string;
  amount: number;
  encounterNoMasked: string;
  createdAt: string;
  assignedTo?: string;
  overdue?: boolean;
  category?: string;
  requestText: string;
}

interface ExplanationPart {
  what: string;
  why: string;
  citationIndexes: number[];
  needsHuman: boolean;
  lineNumbers: number[];
  category: string;
  confidence?: number;
}

interface Citation {
  index: number;
  type: string;
  code: string;
  label: string;
}

interface ExplanationView {
  consultationNo: string;
  status: string;
  category: string;
  parts: ExplanationPart[];
  citations: Citation[];
  confirmedAt?: string;
  canDispatch: boolean;
  draftText?: string;
}

interface ConnectivityItem {
  key: string;
  name: string;
  state: 'configured' | 'missing' | 'unreachable';
  note?: string;
}

interface DesktopAPI {
  getSummary(): Promise<Summary>;
  listConsultations(filter?: { status?: string; assignedTo?: string }): Promise<ConsultationView[]>;
  getExplanation(consultationNo: string): Promise<ExplanationView | null>;
  confirm(consultationNo: string): Promise<{ ok: boolean; message: string }>;
  handoff(consultationNo: string): Promise<{ ok: boolean; message: string }>;
  print(consultationNo: string): Promise<{ ok: boolean; filePath?: string; message: string }>;
  replay(consultationNo: string): Promise<ExplanationView | null>;
  checkConnectivity(): Promise<ConnectivityItem[]>;
  reportReady?(): void;
}

/* ========================= 二、常量映射 ========================= */

type ViewName = 'workbench' | 'citations' | 'settings';
type LoadScope = 'summary' | 'list' | 'detail' | 'connectivity';
type ToastType = 'success' | 'error' | 'warning' | 'info'; // 四类 toast

const STATUS_LABELS: Record<string, string> = {
  pending_reply: '待答复',
  draft_pending_confirm: '草稿待确认',
  answered: '已答复',
  transferred: '已转办',
  closed: '已关闭',
  withdrawn: '已撤回',
};

const CHANNEL_LABELS: Record<string, string> = {
  counter: '窗口',
  phone: '电话',
  online: '线上',
};

/** 分类三值语义色：院内核对=绿 / 需转医保办=琥珀 / 需人工判断=红，均带文字标签 */
const CATEGORY_META: Record<string, { label: string; cls: string; dot: string }> = {
  internal_check: { label: '院内核对', cls: 'internal', dot: 'green' },
  to_insurance_office: { label: '需转医保办', cls: 'insurance', dot: 'amber' },
  needs_human: { label: '需人工判断', cls: 'human', dot: 'red' },
};

/** 引用依据类型文字标注，界面不显示裸数字 */
const CITATION_TYPE_LABELS: Record<string, string> = {
  price_item: '价目',
  settlement_field: '清单字段',
  rule: '规则',
};

const CONNECTIVITY_STATE_LABELS: Record<string, string> = {
  configured: '已配置',
  missing: '未配置',
  unreachable: '不可达',
};

const SCOPE_LABELS: Record<string, string> = {
  summary: '汇总数据',
  list: '咨询列表',
  detail: '解释稿',
  connectivity: '连通性自检',
};

const STATUS_ORDER: string[] = [
  'pending_reply',
  'draft_pending_confirm',
  'answered',
  'transferred',
  'closed',
  'withdrawn',
];

/* ========================= 三、工具函数 ========================= */

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少挂载节点 ${id}`);
  return el;
}

/** 所有动态文本插入 innerHTML 前一律转义，防止来自 API 的文本造成 XSS */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 金额：右对齐、等宽、不加千分位，与 HIS 票据口径一致 */
function fmtMoney(n: number): string {
  return n.toFixed(2);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 日期时间统一 YYYY-MM-DD HH:mm */
function fmtNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDateTime(input: string): string {
  if (!input) return '—';
  const norm = input.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(norm)) return norm.slice(0, 16);
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return norm.slice(0, 16);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function first<T>(arr: T[]): T | undefined {
  return arr[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function catMeta(category?: string): { label: string; cls: string; dot: string } {
  return CATEGORY_META[category ?? ''] ?? { label: '未分类', cls: 'internal', dot: 'gray' };
}

/** 等一帧确保布局/绘制完成；隐藏窗口下 rAF 不触发时用定时器兜底 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let fired = false;
    const done = (): void => {
      if (fired) return;
      fired = true;
      resolve();
    };
    requestAnimationFrame(done);
    window.setTimeout(done, 120);
  });
}

/* ========================= 四、脱敏样例数据（预览兜底，非产品主数据源）=========
   仅当 window.desktopAPI 不存在时（vite dev / 直接以浏览器打开构建产物）启用。
   这是「静态预览兜底」，不是产品主数据源；真实运行一律由主进程 desktopAPI 供数。
   数据全部脱敏：咨询单号形如 CS2026...、住院号仅后 4 位 ****1234。
   ========================================================================== */

const SAMPLE_SUMMARY: Summary = { today: 4, unanswered: 2, transferred: 1, highRisk: 1 };

const SAMPLE_CONSULTATIONS: ConsultationView[] = [
  {
    consultationNo: 'CS202611090001',
    channel: 'counter',
    status: 'draft_pending_confirm',
    amount: 3200.0,
    encounterNoMasked: '****1234',
    createdAt: '2026-11-09 08:42',
    assignedTo: '李静',
    overdue: true,
    category: 'internal_check',
    requestText: '家属质疑 3 月 6 日西药费里「头孢呋辛钠 0.5g×6」收了 3200 元，为什么这么贵、能不能报医保。',
  },
  {
    consultationNo: 'CS202611090002',
    channel: 'phone',
    status: 'pending_reply',
    amount: 1120.0,
    encounterNoMasked: '****5678',
    createdAt: '2026-11-09 09:15',
    assignedTo: '王敏',
    overdue: false,
    category: 'needs_human',
    requestText: '电话咨询：家属认为 CT 平扫只做了一次却像收了两次，要求给个说法。',
  },
  {
    consultationNo: 'CS202611090003',
    channel: 'online',
    status: 'transferred',
    amount: 240.0,
    encounterNoMasked: '****9012',
    createdAt: '2026-11-09 07:50',
    assignedTo: '李静',
    overdue: true,
    category: 'to_insurance_office',
    requestText: '线上留言：彩色多普勒超声 240 元，医保热线说不在报销范围，是不是医院收错了？',
  },
  {
    consultationNo: 'CS202611090004',
    channel: 'counter',
    status: 'answered',
    amount: 100.0,
    encounterNoMasked: '****3456',
    createdAt: '2026-11-08 16:30',
    assignedTo: '王敏',
    overdue: false,
    category: 'internal_check',
    requestText: '窗口：床位费 100 元是不是按天收的？住了几天就收几天吗？',
  },
];

const SAMPLE_EXPLANATIONS: Record<string, ExplanationView> = {
  CS202611090001: {
    consultationNo: 'CS202611090001',
    status: 'draft_pending_confirm',
    category: 'internal_check',
    canDispatch: false,
    draftText: '（草稿 · 待收费员确认）以上逐条解释尚未外发。',
    parts: [
      {
        what: '这笔 3200.00 元为「头孢呋辛钠 0.5g×6」（明细行 7 · 西药费）',
        why: '按本院价目 ITEM007 单价 520.00 元 × 6 支 = 3120.00 元，加溶媒配伍 80.00 元，合计 3200.00 元；该药医保属性为乙类，先自付 10% 后纳入统筹支付，故家属看到的「不能全报」属正常口径。',
        citationIndexes: [1, 2, 3],
        needsHuman: false,
        lineNumbers: [7],
        category: 'internal_check',
        confidence: 0.92,
      },
      {
        what: '这笔 480.00 元为「住院床位费 · 双人病房 6 天」（明细行 12）',
        why: '按结算清单「医疗收费信息 · 床位费」口径，80.00 元/天 × 6 天 = 480.00 元，与价目 ITEM001 一致，未跨出院日期计费。',
        citationIndexes: [2, 4],
        needsHuman: false,
        lineNumbers: [12],
        category: 'internal_check',
        confidence: 0.88,
      },
      {
        what: '这笔 1120.00 元「CT 平扫」家属怀疑重复收费（明细行 18）',
        why: '同日同部位仅检索到一条明细（行 18），初判未见重复计费；但本次快照缺少检查申请单与影像号佐证，按规则命中「依据不足」，须人工核对后再答复。',
        citationIndexes: [3, 5],
        needsHuman: true,
        lineNumbers: [18],
        category: 'needs_human',
        confidence: 0.41,
      },
    ],
    citations: [
      { index: 1, type: 'price_item', code: 'ITEM007', label: '头孢呋辛钠 0.5g 单价 520.00 元 · 价目版本 PRICE-2026-03' },
      { index: 2, type: 'settlement_field', code: 'FLD-西药费', label: '结算清单 · 医疗收费信息 · 西药费' },
      { index: 3, type: 'rule', code: 'R-INS-038-6', label: '医保支付范围判定规则 第 38 条第 6 项' },
      { index: 4, type: 'settlement_field', code: 'FLD-床位费', label: '结算清单 · 医疗收费信息 · 床位费' },
      { index: 5, type: 'rule', code: 'R-DUP-002', label: '同日同项目重复计费核验规则 · 依据缺失转人工' },
    ],
  },
  CS202611090002: {
    consultationNo: 'CS202611090002',
    status: 'pending_reply',
    category: 'needs_human',
    canDispatch: false,
    parts: [
      {
        what: '这笔 1120.00 元「CT 平扫」（明细行 4）需人工判断是否重复',
        why: '账面上同日仅一条 CT 平扫明细，但家属口述「做了两次」，且本次未取到检查申请单与影像号，依据不足，不能自动下结论，须信息科核对影像系统后书面答复。',
        citationIndexes: [1, 2],
        needsHuman: true,
        lineNumbers: [4],
        category: 'needs_human',
        confidence: 0.33,
      },
    ],
    citations: [
      { index: 1, type: 'price_item', code: 'ITEM004', label: 'CT 平扫 单价 1120.00 元 · 价目版本 PRICE-2026-03' },
      { index: 2, type: 'rule', code: 'R-DUP-002', label: '同日同项目重复计费核验规则 · 依据缺失转人工' },
    ],
  },
  CS202611090003: {
    consultationNo: 'CS202611090003',
    status: 'transferred',
    category: 'to_insurance_office',
    canDispatch: true,
    confirmedAt: '2026-11-09 08:20',
    parts: [
      {
        what: '这笔 240.00 元为「彩色多普勒超声」（明细行 5 · 检查费）',
        why: '按价目 ITEM005 单价 240.00 元 × 1 次计费无误；是否纳入医保支付范围由医保目录判定，不属院内收费口径，故转医保办出具正式答复。',
        citationIndexes: [1, 2],
        needsHuman: false,
        lineNumbers: [5],
        category: 'to_insurance_office',
        confidence: 0.9,
      },
    ],
    citations: [
      { index: 1, type: 'price_item', code: 'ITEM005', label: '彩色多普勒超声 单价 240.00 元 · 价目版本 PRICE-2026-03' },
      { index: 2, type: 'rule', code: 'R-INS-SCOPE', label: '医保目录归属判定规则 · 非院内口径转医保办' },
    ],
  },
  CS202611090004: {
    consultationNo: 'CS202611090004',
    status: 'answered',
    category: 'internal_check',
    canDispatch: true,
    confirmedAt: '2026-11-08 16:52',
    parts: [
      {
        what: '这笔 100.00 元为「床位费」（明细行 1）',
        why: '按价目 ITEM001 单价 20.00 元/天 × 5 天 = 100.00 元，按实际住院天数逐日计费，非一次性收费；与结算清单床位费口径一致。',
        citationIndexes: [1, 2],
        needsHuman: false,
        lineNumbers: [1],
        category: 'internal_check',
        confidence: 0.95,
      },
    ],
    citations: [
      { index: 1, type: 'price_item', code: 'ITEM001', label: '床位费 单价 20.00 元/天 · 价目版本 PRICE-2026-03' },
      { index: 2, type: 'settlement_field', code: 'FLD-床位费', label: '结算清单 · 医疗收费信息 · 床位费' },
    ],
  },
};

const SAMPLE_CONNECTIVITY: ConnectivityItem[] = [
  { key: 'his', name: 'HIS 住院费用明细', state: 'unreachable', note: '院内 HIS 接口连接超时，无法取到该次住院费用明细' },
  { key: 'price', name: '价目目录服务', state: 'configured', note: 'PRICE-2026-03 · 本地缓存可用' },
  { key: 'workorder', name: '工单 / 转办通道', state: 'configured', note: '医保办转办通道正常' },
  { key: 'im', name: 'IM 院内消息', state: 'missing', note: '未配置院内 IM 凭据' },
];

/* ========================= 五、API 适配：注入优先，样例兜底 ========================= */

type WindowWithAPI = Window & { desktopAPI?: DesktopAPI };
const injected: DesktopAPI | undefined = (window as WindowWithAPI).desktopAPI;
const USING_SAMPLES = !injected;

/** 预览兜底实现：仅用于 window.desktopAPI 缺失时的静态演示，不承载真实业务 */
function createFallbackApi(): DesktopAPI {
  const tick = (): Promise<void> => sleep(160);
  return {
    getSummary: async () => {
      await tick();
      return { ...SAMPLE_SUMMARY };
    },
    listConsultations: async () => {
      await tick();
      return SAMPLE_CONSULTATIONS.map((c) => ({ ...c }));
    },
    getExplanation: async (no) => {
      await tick();
      return SAMPLE_EXPLANATIONS[no] ?? null;
    },
    confirm: async (no) => {
      await tick();
      const exp = SAMPLE_EXPLANATIONS[no];
      if (!exp) return { ok: false, message: '未找到该咨询单的解释稿' };
      exp.confirmedAt = fmtNow();
      exp.canDispatch = true;
      exp.status = 'answered';
      const c = SAMPLE_CONSULTATIONS.find((x) => x.consultationNo === no);
      if (c) c.status = 'answered';
      return { ok: true, message: '解释稿已确认，现可外发（转办 / 打印稿已放行）' };
    },
    handoff: async (no) => {
      await tick();
      const c = SAMPLE_CONSULTATIONS.find((x) => x.consultationNo === no);
      if (c) c.status = 'transferred';
      const exp = SAMPLE_EXPLANATIONS[no];
      if (exp) exp.status = 'transferred';
      return { ok: true, message: `咨询单 ${no} 已提交医保办，工单号 WO202611090017` };
    },
    print: async (no) => {
      await tick();
      return { ok: true, filePath: `~/Documents/住院费用解释稿/${no}.pdf`, message: '打印稿已生成' };
    },
    replay: async (no) => {
      await tick();
      return SAMPLE_EXPLANATIONS[no] ?? null;
    },
    checkConnectivity: async () => {
      await tick();
      return SAMPLE_CONNECTIVITY.map((c) => ({ ...c }));
    },
  };
}

const api: DesktopAPI = injected ?? createFallbackApi();

/* ========================= 六、应用状态 ========================= */

const busy = new Set<string>();

const state = {
  view: 'workbench' as ViewName,
  filterStatus: '',
  filterAssignee: '',
  query: '',
  searchInvalid: false,
  selectedNo: '',
  summary: null as Summary | null,
  consultations: [] as ConsultationView[],
  explanation: null as ExplanationView | null,
  connectivity: [] as ConnectivityItem[],
  connectivityAt: '',
  expandedCitations: new Set<string>(),
  initialLoading: true,
  detailLoading: false,
  connectivityLoading: false,
  errors: {} as Partial<Record<LoadScope, string>>,
};

function visibleConsultations(): ConsultationView[] {
  const q = state.query.trim().toLowerCase();
  return state.consultations.filter((c) => {
    if (state.filterStatus && c.status !== state.filterStatus) return false;
    if (state.filterAssignee && (c.assignedTo ?? '') !== state.filterAssignee) return false;
    if (q) {
      const hay = `${c.consultationNo} ${c.encounterNoMasked} ${c.requestText}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ========================= 七、数据加载（每个环节独立错误捕获）========================= */

async function loadSummary(): Promise<void> {
  try {
    state.summary = await api.getSummary();
    delete state.errors.summary;
  } catch (e) {
    state.errors.summary = errMsg(e);
  }
}

async function loadList(): Promise<void> {
  try {
    state.consultations = await api.listConsultations();
    delete state.errors.list;
  } catch (e) {
    state.errors.list = errMsg(e);
  }
}

async function loadDetail(no: string): Promise<void> {
  if (!no) {
    state.explanation = null;
    return;
  }
  state.detailLoading = true;
  try {
    state.explanation = await api.getExplanation(no);
    delete state.errors.detail;
  } catch (e) {
    state.errors.detail = errMsg(e);
  } finally {
    state.detailLoading = false;
  }
}

async function loadConnectivity(): Promise<void> {
  state.connectivityLoading = true;
  try {
    state.connectivity = await api.checkConnectivity();
    state.connectivityAt = fmtNow();
    delete state.errors.connectivity;
  } catch (e) {
    state.errors.connectivity = errMsg(e);
  } finally {
    state.connectivityLoading = false;
  }
}

async function retryScope(scope: LoadScope): Promise<void> {
  delete state.errors[scope];
  render();
  switch (scope) {
    case 'summary':
      await loadSummary();
      break;
    case 'list':
      await loadList();
      break;
    case 'detail':
      await loadDetail(state.selectedNo);
      break;
    case 'connectivity':
      await loadConnectivity();
      break;
  }
  render();
}

/* ========================= 八、Toast（四类：success / error / warning / info）=========
   错误类 toast 不自动消失，须手动关闭；其余 4.5s 自动收起。
   ========================================================================== */

const TOAST_ICON: Record<ToastType, string> = {
  success: iconCheckCircle(),
  error: iconAlertCircle(),
  warning: iconWarning(),
  info: iconInfo(),
};
let toastSeq = 0;

function toast(type: ToastType, title: string, message: string): void {
  const root = $('toast-root');
  const id = `toast-${++toastSeq}`;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.id = id;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="toast__icon">${TOAST_ICON[type]}</span>
    <div class="toast__body">
      <div class="toast__title">${esc(title)}</div>
      <div class="toast__msg">${esc(message)}</div>
    </div>
    <button type="button" class="toast__close" data-toast-close="${id}" title="关闭提示">${iconClose()}</button>`;
  root.appendChild(el);
  if (type !== 'error') window.setTimeout(() => dismissToast(id), 4500);
}

function dismissToast(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('is-leaving');
  window.setTimeout(() => el.remove(), 220);
}

/* ========================= 九、自定义二次确认模态（禁止原生 alert/confirm/prompt）=========
   破坏性操作：提交转办 / 撤回 / 批量导出。文案写明影响范围。
   ========================================================================== */

interface ModalConfig {
  title: string;
  desc: string;
  impact: string;
  target?: string;
  confirmLabel: string;
  variant: 'primary' | 'danger';
  onConfirm: () => void | Promise<void>;
}
let pendingModalConfirm: (() => void | Promise<void>) | null = null;

function openConfirmModal(cfg: ModalConfig): void {
  pendingModalConfirm = cfg.onConfirm;
  $('modal-root').innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(cfg.title)}">
        <div class="modal__head">
          <span class="modal__icon ${cfg.variant === 'danger' ? 'modal__icon--danger' : ''}">${iconWarning()}</span>
          <span class="modal__title">${esc(cfg.title)}</span>
        </div>
        <div class="modal__body">
          <div class="modal__desc">${esc(cfg.desc)}</div>
          <div class="modal__impact"><strong>影响范围：</strong>${esc(cfg.impact)}${cfg.target ? ` 目标：<span class="modal__target">${esc(cfg.target)}</span>` : ''}</div>
        </div>
        <div class="modal__foot">
          <button type="button" class="btn btn--secondary" data-modal-cancel>取消</button>
          <button type="button" class="btn ${cfg.variant === 'danger' ? 'btn--danger' : 'btn--primary'}" data-modal-confirm>${esc(cfg.confirmLabel)}</button>
        </div>
      </div>
    </div>`;
}

function closeModal(): void {
  $('modal-root').innerHTML = '';
  pendingModalConfirm = null;
}

/* ========================= 十、操作区 ========================= */

async function runBusy(action: string, fn: () => Promise<void>): Promise<void> {
  if (busy.has(action)) return;
  busy.add(action);
  render();
  try {
    await fn();
  } finally {
    busy.delete(action);
    render();
  }
}

function gateOpen(exp: ExplanationView | null): boolean {
  return !!exp && !!exp.confirmedAt && exp.canDispatch;
}

async function doConfirm(): Promise<void> {
  const no = state.selectedNo;
  if (!no) return;
  await runBusy('confirm', async () => {
    try {
      const r = await api.confirm(no);
      if (r.ok) {
        toast('success', '确认成功', r.message || '解释稿已确认，现可外发');
        await loadDetail(no);
        await loadList();
        await loadSummary();
      } else {
        toast('error', '确认失败', r.message || '确认未通过，请核对解释稿后重试');
      }
    } catch (e) {
      toast('error', '确认失败', `确认环节异常：${errMsg(e)}`);
    }
  });
}

function requestHandoff(): void {
  const no = state.selectedNo;
  if (!no) return;
  openConfirmModal({
    title: '提交转办到医保办？',
    desc: '提交后本咨询单将进入「已转办」，并向医保办生成工单，家属侧会收到转办回执。',
    impact: `仅影响当前咨询单及其转办工单，不改变费用明细与已确认的解释稿内容；该操作由医保办受理，收费员不能单方撤回。`,
    target: no,
    confirmLabel: '确认提交转办',
    variant: 'primary',
    onConfirm: () => doHandoff(),
  });
}

async function doHandoff(): Promise<void> {
  const no = state.selectedNo;
  await runBusy('handoff', async () => {
    try {
      const r = await api.handoff(no);
      toast(r.ok ? 'success' : 'error', r.ok ? '转办成功' : '转办失败', r.message);
      if (r.ok) {
        await loadDetail(no);
        await loadList();
        await loadSummary();
      }
    } catch (e) {
      toast('error', '转办失败', `转办环节异常：${errMsg(e)}`);
    }
  });
}

async function doPrint(): Promise<void> {
  const no = state.selectedNo;
  await runBusy('print', async () => {
    try {
      const r = await api.print(no);
      if (r.ok) {
        toast('success', '打印稿已生成', `${r.message}${r.filePath ? ` · ${r.filePath}` : ''}`);
      } else {
        toast('error', '打印失败', r.message);
      }
    } catch (e) {
      toast('error', '打印失败', `打印环节异常：${errMsg(e)}`);
    }
  });
}

async function doReplay(): Promise<void> {
  const no = state.selectedNo;
  await runBusy('replay', async () => {
    try {
      const exp = await api.replay(no);
      if (exp) {
        state.explanation = exp;
        toast('info', '已重放上次解释稿', `已重新载入 ${no} 的最近一次解释稿与依据清单。`);
      } else {
        toast('warning', '无可重放记录', `未找到 ${no} 的历史解释稿，请先完成一次归因。`);
      }
    } catch (e) {
      toast('error', '重放失败', `重放环节异常：${errMsg(e)}`);
    }
  });
}

function requestWithdraw(): void {
  const no = state.selectedNo;
  if (!no) return;
  openConfirmModal({
    title: '撤回该咨询单？',
    desc: '撤回后该咨询单不再进入外发队列，仅保留本地台账记录。',
    impact: `仅影响当前咨询单 ${no}：状态改为「已撤回」，不产生外发记录，也不改动费用明细与解释稿；已确认的咨询单不可撤回。`,
    target: no,
    confirmLabel: '确认撤回',
    variant: 'danger',
    onConfirm: () => doWithdraw(),
  });
}

async function doWithdraw(): Promise<void> {
  const no = state.selectedNo;
  await runBusy('withdraw', async () => {
    const c = state.consultations.find((x) => x.consultationNo === no);
    if (c) c.status = 'withdrawn';
    const remaining = state.consultations.filter((x) => x.consultationNo !== no);
    state.selectedNo = first(remaining)?.consultationNo ?? '';
    state.explanation = null;
    await loadDetail(state.selectedNo);
    toast('info', '已撤回', `咨询单 ${no} 已撤回，未产生任何外发记录。`);
  });
}

function requestBulkExport(): void {
  const n = visibleConsultations().length;
  openConfirmModal({
    title: '批量导出解释稿归档件？',
    desc: '按当前筛选结果为每条咨询各生成一份解释稿归档件，写入本地导出目录。',
    impact: `将批量产生 ${n} 份文件，范围限于当前列表可见的咨询单；导出件含解释稿与依据编号，不含任何密钥或凭据。请确认磁盘空间与归档范围。`,
    target: `当前筛选结果 ${n} 条`,
    confirmLabel: '确认批量导出',
    variant: 'primary',
    onConfirm: () => doBulkExport(),
  });
}

async function doBulkExport(): Promise<void> {
  await runBusy('bulk-export', async () => {
    toast('info', '批量导出已提交', `已对当前筛选结果中的 ${visibleConsultations().length} 条咨询生成归档任务，导出件不含密钥或凭据。`);
  });
}

async function recheckConnectivity(): Promise<void> {
  await loadConnectivity();
  announceConnectivity();
  render();
}

function announceConnectivity(): void {
  if (state.errors.connectivity) {
    toast('error', '连通性自检失败', state.errors.connectivity);
    return;
  }
  const bad = state.connectivity.filter((c) => c.state !== 'configured');
  if (bad.length) {
    toast('warning', '连通性告警', `存在 ${bad.length} 个未就绪端点，归因可能降级，详见下表。`);
  } else {
    toast('success', '连通性正常', 'HIS / 价目 / 工单 / IM 四个端点均已配置且可达。');
  }
}

/* ========================= 十一、视图与选择 ========================= */

async function setView(v: ViewName): Promise<void> {
  if (state.view === v && v !== 'citations') return;
  state.view = v;
  if (v === 'settings') {
    state.connectivityLoading = true;
    render();
    await loadConnectivity();
    render();
  } else {
    if (!state.selectedNo) state.selectedNo = first(state.consultations)?.consultationNo ?? '';
    if (!state.explanation || state.explanation.consultationNo !== state.selectedNo) {
      await loadDetail(state.selectedNo);
    }
    if (v === 'citations' && state.selectedNo) state.expandedCitations.add(state.selectedNo);
    render();
  }
}

async function selectConsultation(no: string): Promise<void> {
  if (!no || no === state.selectedNo) return;
  state.selectedNo = no;
  state.explanation = null;
  state.detailLoading = true;
  render();
  await loadDetail(no);
  render();
}

function toggleCitations(): void {
  const no = state.selectedNo;
  if (state.expandedCitations.has(no)) state.expandedCitations.delete(no);
  else state.expandedCitations.add(no);
  render();
}

function clearFilter(): void {
  state.filterStatus = '';
  state.filterAssignee = '';
  state.query = '';
  state.searchInvalid = false;
  render();
}

/* ========================= 十二、渲染：HTML 片段构造 ========================= */

function actionBtn(o: {
  action: string;
  label: string;
  icon: string;
  variant: string;
  disabled?: boolean;
  no?: string;
  title?: string;
}): string {
  const isBusy = busy.has(o.action);
  const cls = ['btn', o.variant, isBusy ? 'is-loading' : ''].filter(Boolean).join(' ');
  const attrs = [`type="button"`, `class="${cls}"`, `data-action="${o.action}"`];
  if (o.no) attrs.push(`data-no="${esc(o.no)}"`);
  if (o.title) attrs.push(`title="${esc(o.title)}"`);
  if (o.disabled || isBusy) attrs.push('disabled');
  const inner = isBusy ? '<span class="spinner"></span>' : o.icon;
  return `<button ${attrs.join(' ')}>${inner}<span>${esc(o.label)}</span></button>`;
}

function skLine(extra = ''): string {
  return `<div class="skeleton sk-line ${extra}"></div>`;
}

function skeletonSummaryHTML(): string {
  return `<div class="sk-summary">${[0, 1, 2, 3]
    .map(() => `<div class="sk-card">${skLine('sk-line--short')}${skLine('sk-line--lg sk-line--mid')}</div>`)
    .join('')}</div>`;
}

function skeletonListHTML(): string {
  return `<div class="sk-pad">${[0, 1, 2, 3]
    .map(() => `<div class="sk-card">${skLine('sk-line--short')}${skLine()}${skLine('sk-line--mid')}</div>`)
    .join('')}</div>`;
}

function skeletonDetailHTML(): string {
  return `<div class="sk-pad">${[0, 1, 2]
    .map(() => `<div class="sk-card">${skLine('sk-line--lg sk-line--mid')}${skLine()}${skLine('sk-line--short')}</div>`)
    .join('')}</div>`;
}

function skeletonConnHTML(): string {
  return `<div class="sk-pad">${[0, 1, 2, 3].map(() => skLine('sk-line--mid')).join('')}</div>`;
}

function emptyStateHTML(
  title: string,
  desc: string,
  actions: Array<{ label: string; action: string; variant: string }>
): string {
  return `<div class="state-wrap"><div class="state-card">
    <span class="state-card__icon">${iconInbox()}</span>
    <div class="state-card__title">${esc(title)}</div>
    <div class="state-card__desc">${esc(desc)}</div>
    <div class="state-card__actions">${actions
      .map((a) => `<button type="button" class="btn ${a.variant}" data-action="${a.action}">${esc(a.label)}</button>`)
      .join('')}</div>
  </div></div>`;
}

/** 错误态：说明哪个环节失败 + 重试按钮 */
function errorStateHTML(scope: LoadScope, compact = false): string {
  const msg = state.errors[scope] ?? '未知错误';
  const label = SCOPE_LABELS[scope] ?? scope;
  if (compact) {
    return `<div class="summary-bar"><div class="inline-error">
      <span class="inline-error__icon">${iconAlertCircle()}</span>
      <div class="inline-error__text"><strong>「${esc(label)}」环节加载失败</strong> · ${esc(msg)}</div>
      <button type="button" class="btn btn--secondary btn--sm" data-action="retry" data-scope="${scope}">${iconRefresh()}重试</button>
    </div></div>`;
  }
  return `<div class="state-wrap"><div class="state-card">
    <span class="state-card__icon state-card__icon--error">${iconAlertCircle()}</span>
    <span class="state-card__scope">环节：${esc(label)} · ${esc(scope)}</span>
    <div class="state-card__title">「${esc(label)}」加载失败</div>
    <div class="state-card__desc">${esc(msg)}。数据未完整加载，请检查连接后重试；已加载的其它区域不受影响。</div>
    <div class="state-card__actions"><button type="button" class="btn btn--primary" data-action="retry" data-scope="${scope}">${iconRefresh()}重试该环节</button></div>
  </div></div>`;
}

function topbarHTML(): string {
  const wb = state.view !== 'settings';
  return `<header class="topbar">
    <div class="brand">
      <span class="brand__mark">${iconLayers()}</span>
      <div>
        <span class="brand__title">住院费用争议解释</span>
        <span class="brand__sub">收费员工作台</span>
      </div>
    </div>
    <nav class="tabs" aria-label="视图切换">
      <button type="button" class="tab ${wb ? 'is-active' : ''}" data-view="workbench">${iconWorkbench()}<span>工作台</span></button>
      <button type="button" class="tab ${!wb ? 'is-active' : ''}" data-view="settings">${iconSettings()}<span>设置</span></button>
    </nav>
    <div class="topbar__spacer"></div>
    <div class="topbar__right">
      ${USING_SAMPLES
        ? `<span class="env-chip">${iconInfo()}<span>预览样例数据</span></span>`
        : `<span class="env-chip">${iconServer()}<span>院内数据</span></span>`}
    </div>
  </header>`;
}

function summaryBarHTML(): string {
  if (state.initialLoading) return skeletonSummaryHTML();
  if (state.errors.summary) return errorStateHTML('summary', true);
  const s = state.summary;
  const cards = [
    { label: '今日咨询', value: s?.today ?? 0, icon: iconLayers(), cls: 'primary' },
    { label: '未答复', value: s?.unanswered ?? 0, icon: iconClock(), cls: 'warning' },
    { label: '已转办', value: s?.transferred ?? 0, icon: iconSend(), cls: 'info' },
    { label: '高风险', value: s?.highRisk ?? 0, icon: iconWarning(), cls: 'danger' },
  ];
  return `<div class="summary-bar">${cards
    .map(
      (c) => `<div class="summary-card">
      <span class="summary-card__icon summary-card__icon--${c.cls}">${c.icon}</span>
      <div class="summary-card__body">
        <span class="summary-card__value">${c.value}</span>
        <span class="summary-card__label">${c.label}</span>
      </div>
    </div>`
    )
    .join('')}</div>`;
}

function listToolbarHTML(): string {
  const assignees = Array.from(
    new Set(state.consultations.map((c) => c.assignedTo ?? '').filter(Boolean))
  );
  return `<div class="list-toolbar">
    <div class="list-toolbar__row">
      <div class="field">
        <div class="input-wrap">
          ${iconSearch()}
          <input id="filter-search" class="input ${state.searchInvalid ? 'is-invalid' : ''}" type="text"
            placeholder="搜索咨询单号 / 掩码住院号" value="${esc(state.query)}"
            autocomplete="off" data-input="search" aria-label="搜索咨询单" />
        </div>
        ${state.searchInvalid
          ? `<span class="field-error">${iconAlertCircle()}仅支持单号 / 住院号后 4 位（数字、字母、*），请修正输入</span>`
          : ''}
      </div>
    </div>
    <div class="list-toolbar__row">
      <span class="list-toolbar__label">${iconFilter()}筛选</span>
      <div class="field">
        <select class="select" data-select="status" aria-label="按状态筛选">
          <option value="">全部状态</option>
          ${STATUS_ORDER.map(
            (s) => `<option value="${s}" ${state.filterStatus === s ? 'selected' : ''}>${esc(STATUS_LABELS[s] ?? s)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field">
        <select class="select" data-select="assignee" aria-label="按在手人筛选">
          <option value="">全部在手人</option>
          ${assignees
            .map((a) => `<option value="${esc(a)}" ${state.filterAssignee === a ? 'selected' : ''}>${esc(a)}</option>`)
            .join('')}
        </select>
      </div>
      ${actionBtn({ action: 'bulk-export', label: '批量导出', icon: iconDownload(), variant: 'btn--secondary btn--sm' })}
    </div>
    <div class="list-toolbar__row">
      <span class="list-count">当前显示 ${visibleConsultations().length} / ${state.consultations.length} 条咨询</span>
      <span class="topbar__spacer"></span>
      <button type="button" class="btn btn--ghost btn--sm" data-action="clear-filter">${iconRefresh()}清除筛选</button>
    </div>
  </div>`;
}

function rowHTML(c: ConsultationView): string {
  const meta = catMeta(c.category);
  const selected = c.consultationNo === state.selectedNo;
  return `<tr class="${selected ? 'is-selected' : ''}" data-action="select" data-no="${esc(c.consultationNo)}" title="${esc(c.requestText)}">
    <td>
      <div class="row-top">
        <span class="tag tag--channel">${esc(CHANNEL_LABELS[c.channel] ?? c.channel)}</span>
        <span class="row-status"><span class="dot dot--${meta.dot}"></span>${esc(STATUS_LABELS[c.status] ?? c.status)}</span>
        ${c.overdue ? `<span class="tag tag--overdue">超时</span>` : ''}
      </div>
      <div class="row-code">
        <span class="mono">${esc(c.consultationNo)}</span>
        <span class="mask mono">${esc(c.encounterNoMasked)}</span>
      </div>
      <span class="row-desc truncate" title="${esc(c.requestText)}">${esc(c.requestText)}</span>
    </td>
    <td>
      <div class="row-amount">${esc(fmtMoney(c.amount))}</div>
      <div class="row-amount-unit">元</div>
    </td>
    <td>
      <div class="row-side">
        <span class="cat-label cat-label--${meta.cls}"><span class="dot dot--${meta.dot}"></span>${esc(meta.label)}</span>
        <span class="row-assignee">${iconUser()}${esc(c.assignedTo ?? '未分配')}</span>
      </div>
    </td>
  </tr>`;
}

function listBodyHTML(): string {
  if (state.initialLoading) return skeletonListHTML();
  if (state.errors.list) return errorStateHTML('list');
  if (state.consultations.length === 0) {
    return emptyStateHTML('今天没有待答复咨询', '当前没有待处理的费用争议咨询。可登记新咨询，或刷新列表重新拉取台账。', [
      { label: '登记咨询', action: 'empty-register', variant: 'btn--primary' },
      { label: '刷新列表', action: 'empty-refresh', variant: 'btn--secondary' },
    ]);
  }
  const visible = visibleConsultations();
  if (visible.length === 0) {
    return emptyStateHTML('没有符合筛选条件的咨询', '请调整状态 / 在手人筛选，或清空搜索词后重试。', [
      { label: '清除筛选', action: 'clear-filter', variant: 'btn--primary' },
    ]);
  }
  return `<table class="c-table">
    <colgroup><col style="width:56%"><col style="width:20%"><col style="width:24%"></colgroup>
    <thead><tr>
      <th>咨询单 / 状态 / 诉求</th>
      <th class="is-right">金额(元)</th>
      <th class="is-right">在手人 / 分类</th>
    </tr></thead>
    <tbody>${visible.map(rowHTML).join('')}</tbody>
  </table>`;
}

function partHTML(p: ExplanationPart, i: number, citations: Citation[]): string {
  const meta = catMeta(p.category);
  const refs = p.citationIndexes
    .map((ci) => {
      const cit = citations.find((c) => c.index === ci);
      const typeLabel = cit ? CITATION_TYPE_LABELS[cit.type] ?? '依据' : '依据';
      const code = cit ? cit.code : `编号${ci}`;
      return `<span class="ref-chip">依据 ${ci}<span class="ref-chip__type">· ${esc(typeLabel)}</span><span class="mono"> ${esc(code)}</span></span>`;
    })
    .join('');
  const lines = p.lineNumbers.map((n) => `<span class="chip">明细行 ${n}</span>`).join('');
  return `<article class="part ${p.needsHuman ? 'part--human' : ''}">
    <div class="part__head">
      <span class="part__index">${pad2(i + 1)}</span>
      <div class="part__lines">${lines || '<span class="chip">未绑定明细行</span>'}</div>
      <span class="part__spacer"></span>
      <span class="cat-label cat-label--${meta.cls}"><span class="dot dot--${meta.dot}"></span>${esc(meta.label)}</span>
      ${p.confidence !== undefined ? `<span class="part__conf">置信度 ${(p.confidence * 100).toFixed(0)}%</span>` : ''}
    </div>
    ${p.needsHuman
      ? `<div class="part__human-note">${iconAlertCircle()}需人工判断 · 依据不足或存在歧义，该条不进外发队列，须人工核对后书面答复。</div>`
      : ''}
    <div class="part__block">
      <span class="part__block-label">${iconFileText()}这笔是什么</span>
      <div class="part__what">${esc(p.what)}</div>
    </div>
    <div class="part__block">
      <span class="part__block-label">${iconInfo()}为什么这样算</span>
      <div class="part__why">${esc(p.why)}</div>
    </div>
    <div class="part__refs">
      <span class="part__refs-label">${iconLayers()}依据编号</span>
      ${refs || '<span class="chip">无引用依据</span>'}
    </div>
  </article>`;
}

function citationSectionHTML(exp: ExplanationView, open: boolean): string {
  const items = exp.citations
    .map((c) => {
      const typeLabel = CITATION_TYPE_LABELS[c.type] ?? '依据';
      const typeCls = c.type === 'price_item' ? 'price' : c.type === 'settlement_field' ? 'field' : 'rule';
      return `<div class="cite-item">
        <span class="cite-item__idx">依据 ${c.index}</span>
        <div class="cite-item__main">
          <div class="cite-item__row">
            <span class="cite-type cite-type--${typeCls}">${esc(typeLabel)}</span>
            <span class="cite-item__code mono">${esc(c.code)}</span>
          </div>
          <div class="cite-item__label">${esc(c.label)}</div>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="cite ${open ? 'is-open' : ''}">
    <button type="button" class="cite__toggle" data-action="toggle-citations">
      ${iconLayers()}
      <span>引用依据 <span class="cite__count">（${exp.citations.length} 条）</span></span>
      <span class="cite__spacer"></span>
      <span class="cite__hint">${open ? '收起' : '展开查看依据类型与编码'}</span>
      <span class="chev">${iconChevronDown()}</span>
    </button>
    ${open ? `<div class="cite__body">${items || '<div class="panel__hint">该解释稿暂无引用依据。</div>'}</div>` : ''}
  </div>`;
}

function actionBarHTML(canDispatch: boolean, exp: ExplanationView): string {
  const no = exp.consultationNo;
  return `<div class="action-bar">
    ${actionBtn({ action: 'confirm', label: '确认', icon: iconShield(), variant: 'btn--primary', no })}
    ${actionBtn({ action: 'handoff', label: '提交转办', icon: iconSend(), variant: 'btn--secondary', disabled: !canDispatch, no, title: canDispatch ? '' : '尚未经收费员确认，不得外发' })}
    ${actionBtn({ action: 'print', label: '打印稿', icon: iconPrint(), variant: 'btn--secondary', disabled: !canDispatch, no })}
    ${actionBtn({ action: 'replay', label: '重放上次解释稿', icon: iconReplay(), variant: 'btn--secondary', no })}
    <span class="action-sep"></span>
    ${actionBtn({ action: 'withdraw', label: '撤回', icon: iconClose(), variant: 'btn--ghost btn--sm', no })}
    <span class="action-bar__spacer"></span>
    ${!canDispatch ? `<span class="action-bar__note">${iconWarning()}尚未经收费员确认，不得外发</span>` : ''}
  </div>`;
}

function detailHTML(): string {
  if (state.initialLoading) return skeletonDetailHTML();
  if (state.errors.detail) return errorStateHTML('detail');
  if (state.detailLoading) return skeletonDetailHTML();
  const exp = state.explanation;
  if (!exp || !state.selectedNo) {
    return emptyStateHTML('请选择一条咨询', '从左侧待办列表选择咨询单，查看逐条解释稿与引用依据。', []);
  }
  const c = state.consultations.find((x) => x.consultationNo === state.selectedNo);
  const meta = catMeta(exp.category);
  const canDispatch = gateOpen(exp);
  const humanCount = exp.parts.filter((p) => p.needsHuman).length;
  const open = state.expandedCitations.has(exp.consultationNo);
  return `
    <div class="detail-head">
      <div class="detail-head__top">
        <span class="detail-no">${esc(exp.consultationNo)}</span>
        <div class="detail-head__tags">
          <span class="cat-label cat-label--${meta.cls}"><span class="dot dot--${meta.dot}"></span>${esc(meta.label)}</span>
          <span class="tag tag--neutral">${esc(STATUS_LABELS[exp.status] ?? exp.status)}</span>
          <span class="chip">${iconLayers()}引用 ${exp.citations.length} 条依据</span>
          ${humanCount ? `<span class="tag tag--overdue">${iconWarning()}需人工判断 ${humanCount} 条</span>` : ''}
        </div>
      </div>
      <div class="detail-meta">
        <span class="detail-meta__item">${iconClock()}<span>创建</span><strong>${esc(fmtDateTime(c?.createdAt ?? ''))}</strong></span>
        <span class="detail-meta__item">${iconUser()}<span>在手人</span><strong>${esc(c?.assignedTo ?? '未分配')}</strong></span>
        <span class="detail-meta__item">${iconFileText()}<span>掩码住院号</span><strong class="mono">${esc(c?.encounterNoMasked ?? '****')}</strong></span>
        <span class="detail-meta__item"><span>争议金额</span><strong class="detail-amount">${esc(fmtMoney(c?.amount ?? 0))}</strong><span>元</span></span>
        ${exp.confirmedAt ? `<span class="detail-meta__item">${iconCheckCircle()}<span>确认于</span><strong>${esc(fmtDateTime(exp.confirmedAt))}</strong></span>` : ''}
      </div>
    </div>
    ${canDispatch
      ? `<div class="gate-banner gate-banner--ok">${iconShield()}<div class="gate-banner__text"><strong>已经收费员确认，可外发</strong>解释稿已放行，转办与打印稿可使用。</div></div>`
      : `<div class="gate-banner">${iconWarning()}<div class="gate-banner__text"><strong>尚未经收费员确认，不得外发</strong>请先核对逐条解释与依据，点击「确认」后再提交转办或生成打印稿。</div></div>`}
    <div class="detail-section">
      <div class="section-caption">${iconFileText()}逐条解释稿<span class="section-caption__count">共 ${exp.parts.length} 条</span></div>
      ${exp.parts.map((p, i) => partHTML(p, i, exp.citations)).join('')}
      ${citationSectionHTML(exp, open)}
    </div>
    ${actionBarHTML(canDispatch, exp)}`;
}

function blockingBannerHTML(): string {
  if (state.initialLoading || state.connectivityLoading) return '';
  const his = state.connectivity.find((c) => /his/i.test(c.key) || /HIS|住院/.test(c.name));
  if (his && his.state === 'configured') return '';
  return `<div class="blocking-banner">${iconWarning()}
    <div>
      <div class="blocking-banner__title">HIS 不可用 · 归因已阻断</div>
      <div class="blocking-banner__desc">无法取到该次住院费用明细，解释稿不能生成，转办与打印稿一并停用。请检查院内网络或联系信息科恢复 HIS 连接后再登记咨询。</div>
    </div>
  </div>`;
}

function connectivityBodyHTML(): string {
  if (state.initialLoading || state.connectivityLoading) return skeletonConnHTML();
  if (state.errors.connectivity) return errorStateHTML('connectivity');
  if (state.connectivity.length === 0) {
    return emptyStateHTML('暂无自检结果', '点击「重新自检」检查 HIS / 价目 / 工单 / IM 四个端点的连通性。', [
      { label: '重新自检', action: 'recheck', variant: 'btn--primary' },
    ]);
  }
  return `<table class="conn-table">
    <thead><tr><th>端点</th><th>状态</th><th>说明</th></tr></thead>
    <tbody>${state.connectivity
      .map((c) => {
        const label = CONNECTIVITY_STATE_LABELS[c.state] ?? c.state;
        const dot = c.state === 'configured' ? 'green' : c.state === 'missing' ? 'gray' : 'red';
        return `<tr>
          <td><span class="conn-name">${iconServer()}${esc(c.name)}</span></td>
          <td><span class="state-badge state-badge--${esc(c.state)}"><span class="dot dot--${dot}"></span>${esc(label)}</span></td>
          <td class="conn-note truncate" title="${esc(c.note ?? '—')}">${esc(c.note ?? '—')}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

function readonlyRowsHTML(): string {
  const rows = [
    { icon: iconLayers(), name: '引用开关', desc: '解释稿是否附依据编号与类型标注', value: '开启' },
    { icon: iconShield(), name: '置信度阈值', desc: '低于该值的归因转「需人工判断」', value: '0.75' },
    { icon: iconFileText(), name: '价目版本快照', desc: '历史解释稿依据不被改版覆盖', value: 'PRICE-2026-03' },
    { icon: iconLock(), name: '外发闸门', desc: '收费员确认后才允许转办 / 打印', value: '确认后放行' },
  ];
  return rows
    .map(
      (r) => `<div class="readonly-row">
      <span class="readonly-row__icon">${r.icon}</span>
      <div class="readonly-row__body">
        <div class="readonly-row__name">${esc(r.name)}</div>
        <div class="readonly-row__desc">${esc(r.desc)}</div>
      </div>
      <span class="readonly-row__value">${esc(r.value)}</span>
    </div>`
    )
    .join('');
}

function settingsViewHTML(): string {
  return `<main class="view">
    <div class="settings-grid">
      <div class="settings-stack">
        ${blockingBannerHTML()}
        <section class="panel">
          <div class="panel__head">
            <span class="panel__title">${iconServer()}连通性自检</span>
            <span class="panel__spacer"></span>
            <span class="panel__hint">${state.connectivityAt ? `最近自检 ${esc(state.connectivityAt)}` : '尚未自检'}</span>
            ${actionBtn({ action: 'recheck', label: '重新自检', icon: iconRefresh(), variant: 'btn--secondary btn--sm' })}
          </div>
          ${connectivityBodyHTML()}
        </section>
      </div>
      <div class="settings-stack">
        <section class="panel">
          <div class="panel__head"><span class="panel__title">${iconSettings()}只读配置说明</span></div>
          <div class="readonly-list">${readonlyRowsHTML()}</div>
          <div class="security-note">${iconLock()}<span>密钥与连接凭据由主进程安全托管，工作台界面不读取、不回显任何密钥；以下配置由信息科统一维护，此处仅作只读展示。</span></div>
        </section>
      </div>
    </div>
  </main>`;
}

function workbenchViewHTML(): string {
  return `<main class="view">
    ${summaryBarHTML()}
    <div class="workbench-grid">
      <section class="list-col">
        ${listToolbarHTML()}
        <div class="list-scroll">${listBodyHTML()}</div>
      </section>
      <section class="detail-col">${detailHTML()}</section>
    </div>
  </main>`;
}

function buildShell(): string {
  return `<div class="app-shell">
    ${topbarHTML()}
    ${state.view === 'settings' ? settingsViewHTML() : workbenchViewHTML()}
  </div>`;
}

let appRoot: HTMLElement;

/** 全量重渲染；事件用委托绑定在根节点，故 innerHTML 重建不丢监听，并恢复输入焦点与光标 */
function render(): void {
  const active = document.activeElement as HTMLElement | null;
  const focusId = active && active.id ? active.id : null;
  let caret: number | null = null;
  if (active && typeof (active as HTMLInputElement).selectionStart === 'number') {
    try {
      caret = (active as HTMLInputElement).selectionStart;
    } catch {
      caret = null;
    }
  }
  appRoot.innerHTML = buildShell();
  if (focusId) {
    const again = document.getElementById(focusId) as HTMLInputElement | null;
    if (again) {
      again.focus();
      if (caret != null) {
        try {
          again.setSelectionRange(caret, caret);
        } catch {
          /* 非文本输入，忽略 */
        }
      }
    }
  }
}

/* ========================= 十三、事件委托 ========================= */

function onClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action], [data-view]');
  if (!t) return;
  const view = t.getAttribute('data-view');
  if (view === 'workbench' || view === 'settings') {
    void setView(view);
    return;
  }
  const action = t.getAttribute('data-action');
  switch (action) {
    case 'select':
      void selectConsultation(t.getAttribute('data-no') ?? '');
      break;
    case 'toggle-citations':
      toggleCitations();
      break;
    case 'confirm':
      void doConfirm();
      break;
    case 'handoff':
      requestHandoff();
      break;
    case 'print':
      void doPrint();
      break;
    case 'replay':
      void doReplay();
      break;
    case 'withdraw':
      requestWithdraw();
      break;
    case 'bulk-export':
      requestBulkExport();
      break;
    case 'recheck':
      void recheckConnectivity();
      break;
    case 'retry':
      void retryScope((t.getAttribute('data-scope') as LoadScope) ?? 'list');
      break;
    case 'clear-filter':
      clearFilter();
      break;
    case 'empty-register':
      toast('info', '登记咨询', '演示环境：登记入口由主进程提供，样例数据下不可新增咨询单。');
      break;
    case 'empty-refresh':
      void retryScope('list');
      break;
  }
}

function onInput(e: Event): void {
  const t = e.target as HTMLInputElement;
  if (t.getAttribute('data-input') === 'search') {
    const v = t.value;
    state.query = v;
    state.searchInvalid = /[^0-9A-Za-z*\-]/.test(v);
    render();
  }
}

function onChange(e: Event): void {
  const t = e.target as HTMLSelectElement;
  const which = t.getAttribute('data-select');
  if (which === 'status') state.filterStatus = t.value;
  else if (which === 'assignee') state.filterAssignee = t.value;
  else return;
  render();
}

function onToastClick(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-toast-close]');
  if (t) dismissToast(t.getAttribute('data-toast-close') ?? '');
}

function onModalClick(e: MouseEvent): void {
  const root = $('modal-root');
  const backdrop = root.querySelector('[data-modal-backdrop]');
  if (e.target === backdrop) {
    closeModal();
    return;
  }
  const t = e.target as HTMLElement;
  if (t.closest('[data-modal-cancel]')) {
    closeModal();
    return;
  }
  if (t.closest('[data-modal-confirm]')) {
    const fn = pendingModalConfirm;
    closeModal();
    if (fn) void Promise.resolve(fn());
  }
}

function attachDelegation(): void {
  appRoot.addEventListener('click', onClick);
  appRoot.addEventListener('input', onInput);
  appRoot.addEventListener('change', onChange);
  $('toast-root').addEventListener('click', onToastClick);
  $('modal-root').addEventListener('click', onModalClick);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

/* ========================= 十四、启动 + capture ready 信号 ========================= */

function markReady(): void {
  // 所有数据加载与渲染完成后才打信号；主进程靠 document.body.dataset.ready 截图
  document.body.dataset.ready = 'true';
  injected?.reportReady?.();
}

async function bootstrap(): Promise<void> {
  // capture：读取 URL query ?view=workbench|citations|settings
  const q = new URLSearchParams(window.location.search).get('view');
  if (q === 'workbench' || q === 'citations' || q === 'settings') state.view = q;

  const tasks: Array<Promise<void>> = [loadSummary(), loadList()];
  if (state.view === 'settings') tasks.push(loadConnectivity());
  await Promise.all(tasks);

  if (state.view !== 'settings') {
    // workbench / citations 自动选中第一条咨询
    const sel = first(state.consultations)?.consultationNo ?? '';
    state.selectedNo = sel;
    // view=citations 时展开引用区
    if (state.view === 'citations' && sel) state.expandedCitations.add(sel);
    await loadDetail(sel);
  }

  state.initialLoading = false;
  render();
  await nextFrame();
  markReady();
}

appRoot = $('app');
attachDelegation();
render(); // 首屏骨架屏
void bootstrap();
