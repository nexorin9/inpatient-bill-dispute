/**
 * Electron 主进程（Task 13）。
 *
 * 桌面常驻小工具：主窗口 + 系统托盘常驻（关窗不退出进程）、托盘显示未答复咨询数角标、
 * 点击托盘唤回窗口；渲染层只能经 preload 暴露的受限接口调用 core 能力，
 * 不直连 SQLite 驱动、不接触凭据；第二次启动聚焦已有窗口。
 *
 * --capture 模式（Task 46 / 14）：固定脱敏样例 + 固定窗口尺寸 + 渲染完成信号后 capturePage，
 * 产出 docs/screenshots/ 下的真实运行截图与 CLI 真实输出文本。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Electron 主进程的 `electron` 是运行时注入的内建模块，不是 npm 包。
// 在 ESM 入口里用 createRequire 取它，避免 Node 的 CJS 预解析器把内建模块当成 npm 包解析。
const require = createRequire(import.meta.url);
const electron = require('electron') as typeof import('electron');
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = electron;
// 类型侧仍需从 electron 包取（仅类型，编译后完全擦除，不产生运行时 ESM 导入）
import type { BrowserWindow as ElectronWindow, Tray as ElectronTray } from 'electron';

import { loadConfig, CATEGORY_LABELS, CHANNEL_LABELS } from '../core/config.ts';
import { createRepositories, openStore } from '../db/index.ts';
import { ensureSeeded } from '../cli/commands/ledger.ts';
import { runAttribution } from '../core/attribution/engine.ts';
import { ConfirmationGate } from '../core/dispatch/gate.ts';
import { ConsultationStateService } from '../core/workunit/state-machine.ts';
import { renderPrintDraft } from '../core/dispatch/print.ts';
import { LedgerService } from '../core/audit/ledger.ts';
import { WorkOrderAdapter } from '../core/adapters/workorder.ts';
import { ImAdapter } from '../core/adapters/im.ts';
import { HandoffService } from '../core/dispatch/handoff.ts';
import { HisBillingAdapter } from '../core/adapters/his.ts';
import { PricingAdapter } from '../core/adapters/pricing.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const RENDERER_INDEX = join(PROJECT_ROOT, 'dist/renderer/index.html');
const PRELOAD_PATH = join(PROJECT_ROOT, 'preload.cjs');
const SCREENSHOTS_DIR = join(PROJECT_ROOT, 'docs/screenshots');
const CAPTURE_MODE = process.argv.includes('--capture');

const env = process.env as NodeJS.ProcessEnv;
const config = loadConfig(env);
const repos = createRepositories(openStore());
const states = new ConsultationStateService(repos);
const gate = new ConfirmationGate(repos, states);
const ledger = new LedgerService(repos);

let mainWindow: ElectronWindow | null = null;
let tray: ElectronTray | null = null;

/** 16×16 托盘图标（内联生成，避免额外资源文件；不用 emoji 当图标） */
const TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXUlEQVR42mNkYPhfz0AEYBxVSFmFMSCG+9n8G1XAcqIjxI2qAhk1jChWMDAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMTAwMQAAGgQDc4PZjGMAAAAASUVORK5CYII=';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 冷启动：载入固定脱敏样例，并为样例咨询生成解释稿（确定性基线，不依赖外部模型） */
async function seedDemoData(): Promise<void> {
  ensureSeeded({ repos });
  const pending = repos.consultations.list({ limit: 10 });
  for (const record of pending) {
    if (repos.sessions.count(record.consultationNo) > 0) continue;
    await runAttribution({
      consultationNo: record.consultationNo,
      encounterNo: record.encounterNo,
      requestText: record.requestText,
      channel: record.channel,
      operator: 'demo',
      config, env, repos, dataSource: 'samples',
    });
  }
}

function summary() {
  return repos.consultations.summary(today());
}

function toConsultationView(record: ReturnType<typeof repos.consultations.list>[number]) {
  return {
    consultationNo: record.consultationNo,
    channel: record.channel,
    status: record.status,
    amount: record.amount,
    encounterNoMasked: record.encounterNoMasked,
    createdAt: record.createdAt,
    assignedTo: record.assignedTo,
    overdue: Boolean(record.escalatedAt),
    category: record.disputeCategory,
    requestText: record.requestText,
  };
}

function toExplanationView(consultationNo: string) {
  const record = repos.consultations.find(consultationNo);
  const session = repos.sessions.latest(consultationNo);
  if (!record || !session) return null;
  const snapshot = session.snapshot ?? {};
  const parts = (snapshot.parts ?? []) as Array<{
    what: string; why: string; citationIndexes: number[]; needsHuman: boolean;
    lineNumbers: number[]; category: string; confidence?: number; text?: string;
  }>;
  const citations = (snapshot.citations ?? []) as Array<{
    index: number; type: string; code: string; label: string;
  }>;
  const canDispatch = Boolean(record.confirmedAt) && record.status !== 'withdrawn' &&
    record.disputeCategory !== 'needs_human';
  return {
    consultationNo,
    status: record.status,
    category: record.disputeCategory ?? 'internal_check',
    parts: parts.map((p) => ({
      what: p.what, why: p.why, citationIndexes: p.citationIndexes ?? [],
      needsHuman: p.needsHuman, lineNumbers: p.lineNumbers ?? [],
      category: p.category, confidence: p.confidence,
    })),
    citations,
    confirmedAt: record.confirmedAt,
    canDispatch,
    draftText: parts.map((p) => p.text ?? '').join('\n'),
  };
}

function connectivity() {
  const his = new HisBillingAdapter(env);
  const pricing = new PricingAdapter(env);
  const workorder = new WorkOrderAdapter(env);
  const im = new ImAdapter(env);
  return [
    { key: 'his', name: 'HIS 住院费用明细', state: his.isConfigured() ? 'configured' : 'missing', note: his.isConfigured() ? '凭据已配置' : '未配置，归因将读本地脱敏样例' },
    { key: 'pricing', name: '本院价目目录', state: pricing.isConfigured() ? 'configured' : 'missing', note: '仅显示是否已配置，不回显令牌' },
    { key: 'workorder', name: '科室交办工单', state: workorder.isConfigured() ? 'configured' : 'missing', note: '出站写路径，未配置时转办会显式失败' },
    { key: 'im', name: '院内 IM 群机器人', state: im.isConfigured() ? 'configured' : 'missing', note: '仅推送四个白名单字段' },
  ];
}

function registerIpc(): void {
  ipcMain.handle('desktop:getSummary', () => summary());
  ipcMain.handle('desktop:listConsultations', (_event, filter?: { status?: string; assignedTo?: string }) =>
    repos.consultations.list({
      ...(filter?.status ? { status: filter.status as 'pending_reply' } : {}),
      ...(filter?.assignedTo ? { assignedTo: filter.assignedTo } : {}),
      limit: 100,
    }).map(toConsultationView));
  ipcMain.handle('desktop:getExplanation', (_event, consultationNo: string) => toExplanationView(consultationNo));
  ipcMain.handle('desktop:confirm', (_event, consultationNo: string) => {
    try {
      gate.confirm(consultationNo, 'desktop');
      return { ok: true, message: `已确认 ${consultationNo}，外发通道已放行` };
    } catch (err) { return { ok: false, message: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle('desktop:print', (_event, consultationNo: string) => {
    try {
      gate.assertAllowed(consultationNo, 'print');
      const session = repos.sessions.latest(consultationNo);
      const snapshot = session?.snapshot ?? {};
      const record = repos.consultations.find(consultationNo)!;
      const draft = renderPrintDraft({
        consultationNo,
        encounterNoMasked: record.encounterNoMasked,
        parts: (snapshot.parts ?? []) as Parameters<typeof renderPrintDraft>[0]['parts'],
        citations: (snapshot.citations ?? []) as Parameters<typeof renderPrintDraft>[0]['citations'],
        category: record.disputeCategory ?? 'internal_check',
      });
      return { ok: true, filePath: draft.filePath, message: `打印稿已生成：${draft.filePath}` };
    } catch (err) { return { ok: false, message: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle('desktop:handoff', async (_event, consultationNo: string) => {
    const record = repos.consultations.find(consultationNo);
    const session = repos.sessions.latest(consultationNo);
    if (!record) return { ok: false, message: '咨询单不存在' };
    const service = new HandoffService(repos, gate, states, new WorkOrderAdapter(env), new ImAdapter(env));
    const outcome = await service.submit({
      consultationNo, reasonCode: 'INSURANCE_ATTRIBUTE_DISPUTE',
      draftSummary: `咨询 ${consultationNo} 的费用口径解释稿`,
      submittedBy: 'desktop', evidenceRefs: session?.citations ?? [],
    });
    return outcome.ok
      ? { ok: true, message: `转办成功，工单号 ${outcome.workOrderNo}` }
      : { ok: false, message: `转办失败待重试：${outcome.errorCode ?? 'unknown'}` };
  });
  ipcMain.handle('desktop:replay', (_event, consultationNo: string) => {
    try {
      const result = ledger.replay(consultationNo, 'desktop');
      const view = toExplanationView(consultationNo);
      return view ? { ...view, draftText: result.explanationText } : null;
    } catch { return null; }
  });
  ipcMain.handle('desktop:checkConnectivity', () => connectivity());
  ipcMain.handle('desktop:reportReady', () => true);
}

function createWindow(): ElectronWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 768,
    minHeight: 600,
    show: true,
    title: '住院费用争议解释系统',
    backgroundColor: '#F5F7FA',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.loadFile(RENDERER_INDEX).catch((err: unknown) => {
    console.error('渲染层加载失败：', err);
  });
  // 关窗不退出进程：隐藏窗口，托盘常驻
  win.on('close', (event) => {
    if (CAPTURE_MODE) return;
    event.preventDefault();
    win.hide();
  });
  return win;
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON);
  tray = new Tray(icon);
  const unanswered = summary().unanswered;
  tray.setToolTip(`住院费用争议解释系统 · 未答复 ${unanswered} 条`);
  // macOS 用标题显示角标数字；Windows/Linux 用悬浮提示
  if (process.platform === 'darwin') tray.setTitle(String(unanswered));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: `未答复 ${unanswered} 条`, enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => { if (CAPTURE_MODE) app.exit(0); else app.quit(); } },
  ]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

/** 等待渲染层发出 data-ready 信号（含兜底超时），之后才截图 */
async function waitForReady(win: ElectronWindow, timeoutMs = 15_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await win.webContents.executeJavaScript(
        "document.body?.dataset?.ready === 'true'", true,
      );
      if (ready) return true;
    } catch { /* 页面尚未加载完成 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function captureView(win: ElectronWindow, view: string, filename: string): Promise<void> {
  const url = `file://${RENDERER_INDEX}?view=${view}`;
  await win.loadURL(url);
  const ready = await waitForReady(win);
  if (!ready) console.warn(`[capture] ${view} 未收到渲染完成信号，仍按当前画面截图`);
  // 引用视图要展示「引用折叠展开态」，而引用清单位于解释稿面板下方、默认在视口之外。
  // 这里把引用区滚到可见位置再截图，避免 02-citations.png 与工作台截图几乎重合。
  if (view === 'citations') {
    const found = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.cite') ?? document.querySelector('[data-action="toggle-citations"]');
      if (el) el.scrollIntoView({ block: 'center' });
      return Boolean(el);
    })()`, true);
    if (!found) console.warn('[capture] 未找到引用折叠区，citations 视图按当前画面截图');
    await new Promise((r) => setTimeout(r, 300));
  }
  const image = await win.webContents.capturePage();
  writeFileSync(join(SCREENSHOTS_DIR, filename), image.toPNG());
  console.log(`[capture] ${filename} 已生成（${view}）`);
}

async function runCapture(win: ElectronWindow): Promise<void> {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  await seedDemoData();
  await captureView(win, 'workbench', '01-workbench.png');
  await captureView(win, 'citations', '02-citations.png');
  await captureView(win, 'settings', '03-connectivity.png');
  // CLI 通道真实输出（不伪造）
  try {
    const output = execFileSync(process.execPath, [
      '--experimental-strip-types', join(PROJECT_ROOT, 'src/cli/main.ts'),
      'explain', '--encounter', 'ZY2026000001', '--text', '上次多算了 3200',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', env: {
      ...process.env,
      // 桌面进程本身必须是 Electron app 模式；这里用同一个二进制以 Node 模式跑 CLI，
      // 否则子进程会误启动第二个 GUI 窗口而不是输出文本。
      ELECTRON_RUN_AS_NODE: '1',
      LEDGER_DB_PATH: join(PROJECT_ROOT, 'data/ledger.sqlite'),
    } });
    writeFileSync(join(SCREENSHOTS_DIR, '04-cli-explain.txt'), output, 'utf8');
    console.log('[capture] 04-cli-explain.txt 已生成（CLI 真实输出）');
  } catch (err) {
    console.error('[capture] CLI 输出采集失败：', err);
  }
  app.exit(0);
}

async function bootstrap(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  await app.whenReady();
  registerIpc();
  if (!existsSync(RENDERER_INDEX)) {
    console.error(`渲染层产物不存在：${RENDERER_INDEX}，请先运行 npm run build`);
    app.exit(1);
    return;
  }
  if (!CAPTURE_MODE) await seedDemoData();
  mainWindow = createWindow();
  if (!CAPTURE_MODE) createTray();
  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  if (CAPTURE_MODE) {
    mainWindow.webContents.once('did-finish-load', () => {
      void runCapture(mainWindow!);
    });
  }
}

void bootstrap();

// 供主进程自检脚本引用（不启动 GUI）
export const desktopInternals = {
  projectRoot: PROJECT_ROOT,
  rendererIndex: RENDERER_INDEX,
  preloadPath: PRELOAD_PATH,
  summary,
  connectivity,
  toConsultationView,
  toExplanationView,
  categories: CATEGORY_LABELS,
  channels: CHANNEL_LABELS,
  fileUrl: (p: string) => fileURLToPath(p),
};
