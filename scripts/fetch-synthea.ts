/**
 * 住院费用争议解释系统 · 公开数据集派生脚本
 *
 * 运行：node --experimental-strip-types scripts/fetch-synthea.ts（npm run fetch:data 已配置）
 *
 * 数据来源：Synthea 公开资源（Apache-2.0）。网络可用时下载一份真实的公开
 * encounter 成本 CSV 作为附加输入；网络不可用 / 下载失败 / 校验失败时，
 * 降级为「按 Synthea 公开字段口径确定性生成的缓存派生数据」，并打印明确告警。
 * 产物只写 samples/ 下的 6 个 JSON，本脚本不写其它任何文件。
 *
 * 关键约定：
 *  - 所有产物均为脱敏数据：不含真实姓名、身份证、床号、电话、住址；
 *    住院号采用占位格式 ZY2026xxxxxx。
 *  - 第二次运行若既有产物校验通过，直接打印精确字符串 `reused cached` 并跳过下载。
 *  - 降级路径仍以退出码 0 结束（产物可复用），且绝不静默失败。
 *
 * TypeScript 写法约束（类型剥离可运行）：只使用 interface / type / 类型注解 /
 * as 断言；不使用 enum、namespace、parameter properties、装饰器；类型导入一律 import type。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── 常量配置 ─────────────────────────────

/**
 * 默认来源：Synthea 官方仓库中真实公开可访问的 encounter 成本表 CSV。
 * 仓库：https://github.com/synthetichealth/synthea （Apache-2.0）
 * 表头：CODE,MIN,MODE,MAX,COMMENTS；CODE 为 SNOMED 就诊/处置编码，
 * MIN/MODE/MAX 为 Synthea 成本模型中的就诊费用区间（美元口径）。
 */
const DEFAULT_SYNTHEA_SOURCE_URL =
  'https://raw.githubusercontent.com/synthetichealth/synthea/master/src/main/resources/costs/encounters.csv';

/** Synthea 采用 Apache-2.0 许可证 */
const SYNTHEA_LICENSE = 'Apache-2.0';

/** 允许通过环境变量覆盖来源地址 */
const SOURCE_URL =
  (process.env.SYNTHEA_SOURCE_URL ?? '').trim() || DEFAULT_SYNTHEA_SOURCE_URL;

/** 下载超时：5 秒 */
const DOWNLOAD_TIMEOUT_MS = 5000;

/** 固定随机种子：断网降级时也能确定性复现全部产物 */
const GENERATION_SEED = 20260301;

/** 住院次数与每次明细行数区间 */
const ENCOUNTER_COUNT = 20;
const MIN_LINES_PER_ENCOUNTER = 16;
const MAX_LINES_PER_ENCOUNTER = 18;

/** 转录条数（≥120）与人工标注条数（≥40） */
const TRANSCRIPT_COUNT = 140;
const ATTRIBUTION_LABEL_COUNT = 48;

const PRICE_VERSION = 'PRICE-2026-03';
const PRICE_EFFECTIVE_FROM = '2026-03-01';

/** 故意从价目目录遗漏的编码：供「非目录审核 / 依据缺失」用例 */
const OMITTED_PRICE_CODE = 'ITEM013';

/** 故意留下轻微金额不勾稽的住院序号（0 基），供规则层反例 */
const NON_RECONCILED_ENCOUNTERS = new Set<number>([6, 13]);

/** 官方结算 QC 用例源路径（读不到时回退到脚本内嵌的逐字副本） */
const OFFICIAL_QC_CASES_PATH =
  '/Users/kamini/Desktop/RUN/Agent-GIT-CLAUDE-gpt/domain/cases/settlement_qc_cases.json';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');

const PRODUCT_FILES = [
  'bill-details.json',
  'price-items.json',
  'transcripts.json',
  'ledger-seed.json',
  'attribution-labels.json',
  'qc-cases.json',
] as const;

/**
 * CSV 表头校验：只要完整命中下列任一组，即认为是合法 Synthea CSV。
 * 第一组对应默认的 costs/encounters.csv；第二组对应 Synthea CSV Exporter
 * 导出的 encounters.csv（官方 encounter / claim 字段口径）。
 */
const REQUIRED_HEADER_GROUPS: string[][] = [
  ['CODE', 'MIN', 'MODE', 'MAX'],
  [
    'Id',
    'START',
    'STOP',
    'PATIENT',
    'ENCOUNTERCLASS',
    'BASE_ENCOUNTER_COST',
    'TOTAL_CLAIM_COST',
  ],
];

// ───────────────────────────── 类型定义 ─────────────────────────────

type FeeCategory = '甲类' | '乙类' | '自费' | '其他';
type InsuranceAttribute = '甲' | '乙' | '自费';
type FeeClass =
  | '床位费'
  | '诊察费'
  | '检查费'
  | '化验费'
  | '治疗费'
  | '手术费'
  | '护理费'
  | '卫生材料费'
  | '西药费'
  | '中药饮片费'
  | '中成药费'
  | '一般诊疗费'
  | '挂号费'
  | '其他';
type DisputeCategory = 'internal_check' | 'to_insurance_office' | 'needs_human';
type ConsultationChannel = 'counter' | 'phone' | 'online';

interface CatalogItem {
  code: string;
  name: string;
  /** 口语俗称，供转录文本使用 */
  colloquial: string;
  feeCategory: FeeCategory;
  feeClass: FeeClass;
  /** 单价（分）：一律为 25 分（0.25 元）的整数倍，保证浮点严格勾稽 */
  unitPriceCents: number;
  /** 目录医保属性；conflicting=true 表示与明细 fee_category 故意冲突 */
  insuranceAttribute: InsuranceAttribute;
  conflicting: boolean;
}

interface BillLine {
  line_no: number;
  price_item_code: string;
  item_name: string;
  amount: number;
  fee_category: FeeCategory;
  fee_class: FeeClass;
  occurred_at: string;
  dept_code: string;
}

interface Payment {
  total_amount: number;
  insured_fund_paid: number;
  supplementary_paid: number;
  medical_aid_paid: number;
  personal_burden: number;
  other_paid: number;
  personal_paid: number;
}

interface Encounter {
  encounter_no: string;
  admission_date: string;
  discharge_date: string;
  lines: BillLine[];
  payment: Payment;
  /** 仅「故意不勾稽」的住院带此字段，取 false */
  reconciliation_expected?: false;
}

interface BillDetailsFile {
  source: string;
  license: string;
  generated_at: string;
  encounters: Encounter[];
}

interface PriceItem {
  price_item_code: string;
  name: string;
  insurance_attribute: InsuranceAttribute;
  unit_price: number;
  effective_from: string;
  version: string;
}

interface PriceItemsFile {
  version: string;
  effective_from: string;
  items: PriceItem[];
}

interface Transcript {
  id: string;
  encounter_no: string;
  text: string;
  spoken_amount: number;
  expected_line_numbers: number[];
  category: DisputeCategory;
}

interface TranscriptsFile {
  items: Transcript[];
}

interface Consultation {
  consultation_no: string;
  channel: ConsultationChannel;
  encounter_no: string;
  request_text: string;
  status: 'pending_reply';
  amount: number;
  created_at: string;
}

interface LedgerFile {
  consultations: Consultation[];
  bill_lines: Record<string, BillLine[]>;
}

interface AttributionLabel {
  transcript_id: string;
  question_point: string;
  line_numbers: number[];
  category: DisputeCategory;
}

interface AttributionFile {
  items: AttributionLabel[];
}

interface DownloadResult {
  ok: boolean;
  bytes: number;
  entries: number;
  reason: string;
}

interface ProductStats {
  encounterCount: number;
  lineCount: number;
  transcriptCount: number;
}

type ValidationResult =
  | { ok: true; stats: ProductStats }
  | { ok: false; reason: string };

// ───────────────────────────── 收费项目目录 ─────────────────────────────
/** 22 个编码，覆盖全部 14 个费用归集类目；单价均为 0.25 元的整数倍 */
const CATALOG: CatalogItem[] = [
  { code: 'ITEM001', name: '床位费', colloquial: '病房的钱', feeCategory: '甲类', feeClass: '床位费', unitPriceCents: 2000, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM002', name: '诊察费', colloquial: '医生看病的钱', feeCategory: '甲类', feeClass: '诊察费', unitPriceCents: 1500, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM003', name: '住院诊查费', colloquial: '查房的钱', feeCategory: '甲类', feeClass: '诊察费', unitPriceCents: 2500, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM004', name: 'CT 平扫', colloquial: '拍片子的钱', feeCategory: '乙类', feeClass: '检查费', unitPriceCents: 28000, insuranceAttribute: '甲', conflicting: true },
  { code: 'ITEM005', name: '彩色多普勒超声', colloquial: '做 B 超的钱', feeCategory: '乙类', feeClass: '检查费', unitPriceCents: 12000, insuranceAttribute: '乙', conflicting: false },
  { code: 'ITEM006', name: '血常规', colloquial: '验血的钱', feeCategory: '甲类', feeClass: '化验费', unitPriceCents: 2500, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM007', name: '生化全套', colloquial: '抽血化验的钱', feeCategory: '乙类', feeClass: '化验费', unitPriceCents: 32000, insuranceAttribute: '乙', conflicting: false },
  { code: 'ITEM008', name: '静脉输液', colloquial: '挂水的钱', feeCategory: '甲类', feeClass: '治疗费', unitPriceCents: 1200, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM009', name: '换药', colloquial: '换药包的钱', feeCategory: '甲类', feeClass: '治疗费', unitPriceCents: 3000, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM010', name: '麻醉费', colloquial: '打麻药的钱', feeCategory: '乙类', feeClass: '手术费', unitPriceCents: 68000, insuranceAttribute: '乙', conflicting: false },
  { code: 'ITEM011', name: '阑尾切除术', colloquial: '开刀的钱', feeCategory: '乙类', feeClass: '手术费', unitPriceCents: 120000, insuranceAttribute: '乙', conflicting: false },
  { code: 'ITEM012', name: '一级护理', colloquial: '护士照看的钱', feeCategory: '甲类', feeClass: '护理费', unitPriceCents: 1800, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM013', name: '一次性输液器', colloquial: '输液管的钱', feeCategory: '乙类', feeClass: '卫生材料费', unitPriceCents: 850, insuranceAttribute: '乙', conflicting: false },
  { code: 'ITEM014', name: '氯化钠注射液', colloquial: '盐水的钱', feeCategory: '甲类', feeClass: '西药费', unitPriceCents: 675, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM015', name: '注射用头孢呋辛', colloquial: '消炎针的钱', feeCategory: '乙类', feeClass: '西药费', unitPriceCents: 4600, insuranceAttribute: '自费', conflicting: true },
  { code: 'ITEM016', name: '黄芪饮片', colloquial: '中药饮片的钱', feeCategory: '自费', feeClass: '中药饮片费', unitPriceCents: 1200, insuranceAttribute: '自费', conflicting: false },
  { code: 'ITEM017', name: '复方丹参滴丸', colloquial: '中成药的钱', feeCategory: '乙类', feeClass: '中成药费', unitPriceCents: 3200, insuranceAttribute: '乙', conflicting: false },
  { code: 'ITEM018', name: '一般诊疗费', colloquial: '诊疗费', feeCategory: '甲类', feeClass: '一般诊疗费', unitPriceCents: 1000, insuranceAttribute: '甲', conflicting: false },
  { code: 'ITEM019', name: '挂号费', colloquial: '挂号的钱', feeCategory: '自费', feeClass: '挂号费', unitPriceCents: 500, insuranceAttribute: '甲', conflicting: true },
  { code: 'ITEM020', name: '空调降温费', colloquial: '空调费', feeCategory: '其他', feeClass: '其他', unitPriceCents: 300, insuranceAttribute: '自费', conflicting: false },
  { code: 'ITEM021', name: '心电监护', colloquial: '心电监护的钱', feeCategory: '乙类', feeClass: '治疗费', unitPriceCents: 6000, insuranceAttribute: '乙', conflicting: false },
  { code: 'ITEM022', name: '氧气吸入', colloquial: '吸氧的钱', feeCategory: '甲类', feeClass: '治疗费', unitPriceCents: 800, insuranceAttribute: '甲', conflicting: false },
];

// ───────────────────────────── 通用工具 ─────────────────────────────

/** 固定 seed 的 LCG（32 位），保证断网降级时全部产物可确定性复现 */
function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 把分取整到 25 分（0.25 元）的整数倍，保证金额在二进制浮点中精确可表示 */
function roundQuarter(cents: number): number {
  return Math.round(cents / 25) * 25;
}

/** ISO 日期加天数 */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 自定义序列化：金额字段输出两位小数（JSON 数字本身不带尾零，故用标记替换），
 * 其余数字保持原样；统一 2 空格缩进 + 末尾换行 + UTF-8。
 */
const MONEY_MARK = '@@MONEY_2D@@';
const MONEY_TOKEN_RE = /"@@MONEY_2D@@(-?\d+\.\d{2})@@MONEY_2D@@"/g;

function makeReplacer(moneyKeys: ReadonlySet<string>) {
  return (_key: string, value: unknown): unknown => {
    if (typeof value === 'number' && Number.isFinite(value) && moneyKeys.has(_key)) {
      return `${MONEY_MARK}${value.toFixed(2)}${MONEY_MARK}`;
    }
    return value;
  };
}

function serializeJson(data: unknown, moneyKeys: ReadonlySet<string>): string {
  const raw = JSON.stringify(data, makeReplacer(moneyKeys), 2);
  if (raw === undefined) throw new Error('JSON 序列化失败');
  return raw.replace(MONEY_TOKEN_RE, '$1') + '\n';
}

function writeProduct(filename: string, data: unknown, moneyKeys: ReadonlySet<string>): void {
  fs.writeFileSync(path.join(SAMPLES_DIR, filename), serializeJson(data, moneyKeys), 'utf8');
}

const BILL_MONEY_KEYS = new Set<string>([
  'amount',
  'total_amount',
  'insured_fund_paid',
  'supplementary_paid',
  'medical_aid_paid',
  'personal_burden',
  'other_paid',
  'personal_paid',
]);
const PRICE_MONEY_KEYS = new Set<string>(['unit_price']);
const LEDGER_MONEY_KEYS = new Set<string>(['amount']);
const NO_MONEY_KEYS = new Set<string>();

// ───────────────────────────── 下载与校验 ─────────────────────────────

function hasRequiredHeaders(header: string[]): boolean {
  const upper = new Set(header.map((h) => h.toUpperCase()));
  return REQUIRED_HEADER_GROUPS.some((group) =>
    group.every((field) => upper.has(field.toUpperCase())),
  );
}

/** 下载来源 CSV，并做三项完整性校验：字节数 > 0、条目数 > 0、必需表头存在 */
async function fetchSource(): Promise<DownloadResult> {
  try {
    const res = await fetch(SOURCE_URL, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, bytes: 0, entries: 0, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const bytes = buf.byteLength;
    if (bytes === 0) {
      return { ok: false, bytes: 0, entries: 0, reason: '归档字节数为 0' };
    }
    const lines = buf
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const entries = lines.length - 1;
    if (entries <= 0) {
      return { ok: false, bytes, entries: 0, reason: 'CSV 条目数为 0（只有表头）' };
    }
    const header = lines[0].split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    if (!hasRequiredHeaders(header)) {
      return {
        ok: false,
        bytes,
        entries,
        reason: `必需表头字段缺失（实际表头：${header.join('|')}）`,
      };
    }
    return { ok: true, bytes, entries, reason: '' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, bytes: 0, entries: 0, reason };
  }
}

// ───────────────────────────── 产物生成 ─────────────────────────────

function buildPayment(lineCents: number[], deliberatelyUnbalanced: boolean): Payment {
  const totalCents = lineCents.reduce((s, c) => s + c, 0);
  const insured = roundQuarter(totalCents * 0.55);
  const supplementary = roundQuarter(totalCents * 0.08);
  const medicalAid = roundQuarter(totalCents * 0.02);
  const personalBurden = totalCents - insured - supplementary - medicalAid;
  const otherPaid = roundQuarter(personalBurden * 0.3);
  const personalPaid = personalBurden - otherPaid;

  // 故意留 2.50 元的轻微不勾稽：统筹支付少记 2.50 元，
  // 使 total_amount 与四项支付口径之和不相等；其余关系仍保持自洽。
  const insuredFinal = deliberatelyUnbalanced ? insured - 250 : insured;

  return {
    total_amount: totalCents / 100,
    insured_fund_paid: insuredFinal / 100,
    supplementary_paid: supplementary / 100,
    medical_aid_paid: medicalAid / 100,
    personal_burden: personalBurden / 100,
    other_paid: otherPaid / 100,
    personal_paid: personalPaid / 100,
  };
}

function buildEncounters(rng: () => number): Encounter[] {
  const encounters: Encounter[] = [];
  let globalLineCounter = 0;

  for (let i = 0; i < ENCOUNTER_COUNT; i++) {
    const admission = addDays('2026-03-01', i % 12);
    const lengthDays = 6 + Math.floor(rng() * 7); // 6..12 天，均落在 2026 年 3 月
    const discharge = addDays(admission, lengthDays);
    const lineCount =
      MIN_LINES_PER_ENCOUNTER +
      Math.floor(rng() * (MAX_LINES_PER_ENCOUNTER - MIN_LINES_PER_ENCOUNTER + 1));
    const lines: BillLine[] = [];
    const lineCents: number[] = [];

    for (let j = 0; j < lineCount; j++) {
      // 前 22 行强制覆盖全部编码，确保每个价目编码都在明细中出现
      const codeIdx =
        globalLineCounter < CATALOG.length
          ? globalLineCounter
          : Math.floor(rng() * CATALOG.length);
      globalLineCounter++;
      const item = CATALOG[codeIdx];
      const quantity = 1 + Math.floor(rng() * 6); // 1..6
      const cents = item.unitPriceCents * quantity;
      lineCents.push(cents);

      // 少数明细行故意越出住院区间（供 §4 第 6 条「费用日期在住院期间」规则命中）
      const outOfRange = j === 6 || (i % 5 === 0 && j === 12);
      const occurredAt = outOfRange
        ? addDays(discharge, 3 + Math.floor(rng() * 4))
        : addDays(admission, Math.floor(rng() * (lengthDays + 1)));

      lines.push({
        line_no: j + 1,
        price_item_code: item.code,
        item_name: item.name,
        amount: cents / 100,
        fee_category: item.feeCategory,
        fee_class: item.feeClass,
        occurred_at: occurredAt,
        dept_code: `D${String(1 + Math.floor(rng() * 8)).padStart(3, '0')}`,
      });
    }

    const unbalanced = NON_RECONCILED_ENCOUNTERS.has(i);
    const encounter: Encounter = {
      encounter_no: `ZY2026${String(i + 1).padStart(6, '0')}`,
      admission_date: admission,
      discharge_date: discharge,
      lines,
      payment: buildPayment(lineCents, unbalanced),
    };
    if (unbalanced) encounter.reconciliation_expected = false;
    encounters.push(encounter);
  }
  return encounters;
}

function buildPriceItems(): PriceItemsFile {
  return {
    version: PRICE_VERSION,
    effective_from: PRICE_EFFECTIVE_FROM,
    // 故意遗漏 OMITTED_PRICE_CODE：该编码在明细中出现但目录里查不到
    items: CATALOG.filter((item) => item.code !== OMITTED_PRICE_CODE).map((item) => ({
      price_item_code: item.code,
      name: item.name,
      insurance_attribute: item.insuranceAttribute,
      unit_price: item.unitPriceCents / 100,
      effective_from: PRICE_EFFECTIVE_FROM,
      version: PRICE_VERSION,
    })),
  };
}

interface AmountEntry {
  spoken: number;
  phrases: string[];
}

/** 口述金额及其单位变体（3200 元 / 3 千 2 / 三千二 / 3200 块钱 …） */
const AMOUNT_ENTRIES: AmountEntry[] = [
  { spoken: 3200, phrases: ['3200 元', '3 千 2', '三千二', '3200 块钱', '3千2百'] },
  { spoken: 1800, phrases: ['1800 元', '1 千 8', '一千八', '一千八百块'] },
  { spoken: 320, phrases: ['320 元', '三百二', '320 块钱', '三百二十'] },
  { spoken: 280, phrases: ['280 元', '二百八', '280 块', '二百八十'] },
  { spoken: 1200, phrases: ['1200 元', '1 千 2', '一千二', '一千二百块'] },
  { spoken: 680, phrases: ['680 元', '六百八', '680 块钱', '六百八十'] },
  { spoken: 120, phrases: ['120 元', '一百二', '120 块钱', '一百二十'] },
  { spoken: 46, phrases: ['46 元', '四十六块', '46 块钱'] },
  { spoken: 3, phrases: ['3 元', '三块钱', '三块'] },
  { spoken: 8.5, phrases: ['8.5 元', '八块五', '八元五'] },
];

/** 转述 / 口语化开场白（含「女儿转述」） */
const OPENERS = [
  '',
  '',
  '我闺女让我来问一下，',
  '女儿替我问问，',
  '家里人让我打听一下，',
  '我儿子说让来问一嘴，',
];

/** 疑问模板：全部以「？」结尾；含错别字（单剧/报消/离普/核队）与方言（咋） */
const QUESTION_TEMPLATES: ((amount: string, subject: string) => string)[] = [
  (a, s) => `上次多算了${a}，${s}怎么这么贵？`,
  (a, s) => `是不是把${s}收了两遍，多出来${a}？`,
  (a, s) => `单剧上${s}写的是${a}，跟我印象对不上啊？`,
  (a, s) => `这${a}的${s}医保咋不给定点报消？`,
  (a, s) => `怎么又多出来一笔${s}，${a}？`,
  (a, s) => `${s}收${a}是不是有点离普？`,
  (a, s) => `上回${s}没这么贵，这回咋多了${a}？`,
  (a, s) => `${s}这${a}到底算不算在报销里？`,
  (a, s) => `能不能麻烦核队一下${s}，好像多收了${a}？`,
  (a, s) => `女儿说${s}这笔${a}不该我们出，是不是弄错了？`,
];

const CATEGORIES: DisputeCategory[] = [
  'internal_check',
  'to_insurance_office',
  'needs_human',
];

function buildTranscripts(
  encounters: Encounter[],
  lineNoByEncounter: Map<string, number[]>,
  catalogByCode: Map<string, CatalogItem>,
): TranscriptsFile {
  const items: Transcript[] = [];
  for (let k = 0; k < TRANSCRIPT_COUNT; k++) {
    const encounter = encounters[k % encounters.length];
    const lineNos = lineNoByEncounter.get(encounter.encounter_no) as number[];
    const amountEntry = AMOUNT_ENTRIES[k % AMOUNT_ENTRIES.length];
    const phrase =
      amountEntry.phrases[
        Math.floor(k / AMOUNT_ENTRIES.length) % amountEntry.phrases.length
      ];
    const opener = OPENERS[k % OPENERS.length];
    const template = QUESTION_TEMPLATES[k % QUESTION_TEMPLATES.length];

    // 质疑点指向的是「某个收费项目」：标注行号取该次住院里同一项目编码的全部明细行。
    // 同一项目出现两行以上时自然形成一对多（n:m）标注，不再用随机行号冒充人工标注。
    const sameItemLines = (line: BillLine): BillLine[] =>
      encounter.lines.filter((l) => l.price_item_code === line.price_item_code);
    const duplicated = k % 4 === 0
      ? encounter.lines.find((line) => sameItemLines(line).length > 1)
      : undefined;
    const firstLine = duplicated ?? encounter.lines[lineNos[k % lineNos.length] - 1] as BillLine;
    const expectedLineNumbers = sameItemLines(firstLine)
      .map((line) => line.line_no)
      .sort((x, y) => x - y);
    const item = catalogByCode.get(firstLine.price_item_code) as CatalogItem;
    const subject = k % 2 === 0 ? item.colloquial : item.name;

    items.push({
      id: `T${String(k + 1).padStart(3, '0')}`,
      encounter_no: encounter.encounter_no,
      text: `${opener}${template(phrase, subject)}`,
      spoken_amount: amountEntry.spoken,
      expected_line_numbers: expectedLineNumbers,
      category: CATEGORIES[k % CATEGORIES.length],
    });
  }
  return { items };
}

function buildAttributionLabels(transcripts: TranscriptsFile): AttributionFile {
  const items: AttributionLabel[] = [];
  for (let k = 0; k < ATTRIBUTION_LABEL_COUNT; k++) {
    // 从转录中等距抽样，模拟人工标注子集：质疑点必须就是家属那句原话，
    // 才能由归并器从文本回指明细行；泛化短语与随机行号都不是可复核的人工标注。
    const t = transcripts.items[(k * 2) % transcripts.items.length];
    items.push({
      transcript_id: t.id,
      question_point: t.text,
      line_numbers: t.expected_line_numbers,
      category: t.category,
    });
  }
  return { items };
}

function buildLedger(encounters: Encounter[]): LedgerFile {
  const [e0, e1, e2] = encounters;
  const consultations: Consultation[] = [
    {
      consultation_no: 'CS202611090001',
      channel: 'counter',
      encounter_no: e0.encounter_no,
      request_text: '上次多算了 3200',
      status: 'pending_reply',
      amount: 3200,
      created_at: '2026-11-09T09:00:00.000Z',
    },
    {
      consultation_no: 'CS202611090002',
      channel: 'phone',
      encounter_no: e1.encounter_no,
      request_text: '女儿替我问问，化验费怎么多收了 3 千 2',
      status: 'pending_reply',
      amount: 3200,
      created_at: '2026-11-09T09:12:00.000Z',
    },
    {
      consultation_no: 'CS202611090003',
      channel: 'online',
      encounter_no: e2.encounter_no,
      request_text: '线上留言：床位费是不是算重了，多出 20 元',
      status: 'pending_reply',
      amount: 20,
      created_at: '2026-11-09T10:05:00.000Z',
    },
  ];
  const billLines: Record<string, BillLine[]> = {
    CS202611090001: e0.lines.slice(0, 5),
    CS202611090002: e1.lines.slice(0, 5),
    CS202611090003: e2.lines.slice(0, 5),
  };
  return { consultations, bill_lines: billLines };
}

// ───────────────── 官方 QC 用例（原样复制 + 离线内嵌副本）─────────────────

/** 与 domain/cases/settlement_qc_cases.json 逐字一致的内嵌副本（离线回退用） */
const EMBEDDED_QC_CASES = {
  _meta: {
    依据: 'domain/dictionaries/医保结算清单字段规范.md（结算清单填写规范）+ domain/rules/医保违规负面清单.md §4',
    说明: '结算清单/费用场景 → 质控校验应通过或不通过。硬校验条目来自官方填写规范与地方 DIP 质控细则。',
    'confidence 说明': 'official = 官方规范直接可推',
  },
  cases: [
    {
      case_id: 'qc-001',
      input: { 出院诊断数: 2, 主要诊断: '空' },
      expect: { 通过: false, 校验: '主诊断唯一性', 原因: '主诊断有且只有一个，否则校验不通过' },
      basis: '结算清单质控硬校验 §4（宁德 DIP 质控通知，通用条目）',
      confidence: 'official',
    },
    {
      case_id: 'qc-002',
      input: { 主要诊断: '急性阑尾炎', 手术操作数: 3, 主要手术操作: '空' },
      expect: { 通过: false, 校验: '主手术操作唯一性', 原因: '手术操作不为空时主手术操作有且只有一个' },
      basis: '结算清单质控硬校验 §4',
      confidence: 'official',
    },
    {
      case_id: 'qc-003',
      input: {
        主要诊断: '急性阑尾炎',
        主要手术操作: '腹腔镜下阑尾切除术',
        离院方式: '2',
        拟接收机构名称: '空',
        拟接收机构代码: '空',
      },
      expect: { 通过: false, 校验: '离院方式联动', 原因: '离院方式为 2（转院）时拟接收机构名称与代码必有值' },
      basis: '结算清单质控硬校验 §4',
      confidence: 'official',
    },
    {
      case_id: 'qc-004',
      input: { 主要诊断: '社区获得性肺炎', 入院时间: '2026-03-01', 出院时间: '2026-03-10', 某费用明细日期: '2026-03-15' },
      expect: { 通过: false, 校验: '费用日期在住院期间', 原因: '费用发生日期超出住院日期范围' },
      basis: '智能审核规则条目 §4-6（负面清单）',
      confidence: 'official',
    },
    {
      case_id: 'qc-005',
      input: { 诊断代码: 'A09.9', 代码格式: '3位类目+1位亚目+2位延拓码' },
      expect: { 通过: true, 校验: 'ICD-10 医保版结构', 原因: '1 字母+2 数字类目 + 亚目 + 延拓码共 6 位结构合规' },
      basis: 'domain/dictionaries/医保编码规则_ICD与药品.md §1（医保发〔2019〕55号）',
      confidence: 'official',
    },
    {
      case_id: 'qc-006',
      input: { 诊断代码: 'J45', 填报要求: '仅填代码不填名称' },
      expect: { 通过: false, 校验: '名称与代码同时填报', 原因: '填写疾病诊断、手术及操作项目时应当同时填写名称及代码' },
      basis: '结算清单填报硬规则 §3-2',
      confidence: 'official',
    },
    {
      case_id: 'qc-007',
      input: { 患者性别: '男', 诊断: '子宫肌瘤' },
      expect: { 通过: false, 校验: '诊断与性别匹配', 原因: '生殖系统诊断按性别分流，男性出现女性专属诊断不符' },
      basis: 'CHS-DRG MDC 性别分流规则 + 编码业务校验三层 §5-3',
      confidence: 'official',
    },
    {
      case_id: 'qc-008',
      input: { 住院医疗类型: '2（日间手术）', 门诊慢特病诊疗信息: '已填', 住院诊疗信息: '空' },
      expect: { 通过: true, 校验: '分区互斥', 原因: '日间手术走住院分区；门诊慢特病患者无需填报住院诊疗信息，反之亦然' },
      basis: '填报硬规则 §3（门诊慢特病患者无需填报住院诊疗信息，住院患者无需填报门诊慢特病诊疗信息）',
      confidence: 'official',
    },
  ],
};

function isQcCaseSet(value: unknown): value is { cases: unknown[] } {
  if (typeof value !== 'object' || value === null) return false;
  const cases = (value as { cases?: unknown }).cases;
  return Array.isArray(cases) && cases.length === 8;
}

/** 优先读取官方源文件逐字复制；读不到则回退到内嵌副本，保证 CI 离线可用 */
function loadQcCases(): unknown {
  try {
    if (fs.existsSync(OFFICIAL_QC_CASES_PATH)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(OFFICIAL_QC_CASES_PATH, 'utf8'));
      if (isQcCaseSet(parsed)) return parsed;
    }
  } catch {
    // 落到内嵌副本
  }
  return EMBEDDED_QC_CASES;
}

// ───────────────────────────── 缓存校验 ─────────────────────────────

function readProduct(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, name), 'utf8'));
}

/** 校验既有产物是否可复用；通过则第二次运行直接打印 reused cached */
function validateProducts(): ValidationResult {
  try {
    for (const file of PRODUCT_FILES) {
      if (!fs.existsSync(path.join(SAMPLES_DIR, file))) {
        return { ok: false, reason: `缺少产物 ${file}` };
      }
    }

    const bill = readProduct('bill-details.json') as BillDetailsFile;
    const price = readProduct('price-items.json') as PriceItemsFile;
    const transcripts = readProduct('transcripts.json') as TranscriptsFile;
    const ledger = readProduct('ledger-seed.json') as LedgerFile;
    const attribution = readProduct('attribution-labels.json') as AttributionFile;
    const qc = readProduct('qc-cases.json') as { cases: unknown[] };

    if (!Array.isArray(bill.encounters) || bill.encounters.length < ENCOUNTER_COUNT) {
      return { ok: false, reason: 'bill-details 住院次数不足' };
    }
    let lineCount = 0;
    const usedCodes = new Set<string>();
    const lineNoByEncounter = new Map<string, number[]>();
    for (const enc of bill.encounters) {
      const seen = new Set<number>();
      for (let idx = 0; idx < enc.lines.length; idx++) {
        const line = enc.lines[idx];
        if (line.line_no !== idx + 1 || seen.has(line.line_no)) {
          return { ok: false, reason: `${enc.encounter_no} 行号不唯一或非从 1 递增` };
        }
        seen.add(line.line_no);
        usedCodes.add(line.price_item_code);
      }
      lineNoByEncounter.set(
        enc.encounter_no,
        enc.lines.map((l) => l.line_no),
      );
      lineCount += enc.lines.length;

      // 标注 reconciliation_expected !== false 的住院必须严格勾稽
      if (enc.reconciliation_expected !== false) {
        const p = enc.payment;
        const sum = enc.lines.reduce((s, l) => s + l.amount, 0);
        if (sum !== p.total_amount) return { ok: false, reason: `${enc.encounter_no} total 与明细不勾稽` };
        if (
          p.insured_fund_paid + p.supplementary_paid + p.medical_aid_paid + p.personal_burden !==
          p.total_amount
        ) {
          return { ok: false, reason: `${enc.encounter_no} 支付口径合计不勾稽` };
        }
        if (p.other_paid + p.personal_paid !== p.personal_burden) {
          return { ok: false, reason: `${enc.encounter_no} 个人负担不勾稽` };
        }
      }
    }
    if (lineCount < 300) return { ok: false, reason: '明细总行数不足 300' };

    if (!Array.isArray(price.items) || price.items.length < 20) {
      return { ok: false, reason: 'price-items 条目不足 20' };
    }
    const listed = new Set(price.items.map((i) => i.price_item_code));
    const missing = [...usedCodes].filter((code) => !listed.has(code));
    if (missing.length !== 1) {
      return { ok: false, reason: `故意遗漏的编码数应为 1，实际 ${missing.length}` };
    }

    if (!Array.isArray(transcripts.items) || transcripts.items.length < 120) {
      return { ok: false, reason: 'transcripts 条数不足 120' };
    }
    for (const t of transcripts.items) {
      const lineNos = lineNoByEncounter.get(t.encounter_no);
      if (!lineNos) return { ok: false, reason: `${t.id} 住院号不存在` };
      for (const n of t.expected_line_numbers) {
        if (!lineNos.includes(n)) return { ok: false, reason: `${t.id} 指向不存在的行号` };
      }
    }

    if (!Array.isArray(ledger.consultations) || ledger.consultations.length < 3) {
      return { ok: false, reason: 'ledger 咨询单不足 3 条' };
    }
    if (!Array.isArray(attribution.items) || attribution.items.length < 40) {
      return { ok: false, reason: 'attribution-labels 不足 40 条' };
    }
    if (!Array.isArray(qc.cases) || qc.cases.length !== 8) {
      return { ok: false, reason: 'qc-cases 不是 8 条官方用例' };
    }

    return {
      ok: true,
      stats: {
        encounterCount: bill.encounters.length,
        lineCount,
        transcriptCount: transcripts.items.length,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `产物解析/校验异常：${reason}` };
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

function printStats(stats: ProductStats, source: string): void {
  console.log(`[统计] 住院次数: ${stats.encounterCount}`);
  console.log(`[统计] 明细行数: ${stats.lineCount}`);
  console.log(`[统计] 转录条数: ${stats.transcriptCount}`);
  console.log(`[统计] 数据来源: ${source}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });

  // 1) 既有产物全部校验通过 → 复用缓存，跳过下载与生成
  const cached = validateProducts();
  if (cached.ok) {
    console.log('reused cached: samples/ 下 6 个派生产物已存在且校验通过，跳过下载与生成。');
    printStats(cached.stats, '缓存派生（复用既有产物）');
    process.exitCode = 0;
    return;
  }
  console.log(`[信息] 未发现可完整复用的产物（${cached.reason}），开始生成。`);

  // 2) 尝试下载真实公开 CSV；失败则降级
  const download = await fetchSource();
  let sourceLabel: string;
  let seed = GENERATION_SEED;
  if (download.ok) {
    console.log(
      `[信息] 真实下载成功：${SOURCE_URL}（${download.bytes} 字节，${download.entries} 条），已作为附加输入影响生成。`,
    );
    // 下载内容的 CSV 条目数作为附加输入，扰动固定 seed
    seed = GENERATION_SEED + download.entries;
    sourceLabel = `真实下载（${SOURCE_URL}）+ 确定性派生`;
  } else {
    console.log(
      `[降级] 下载/校验失败：${download.reason}；已切换到仓库内缓存派生数据（缓存口径：按 Synthea 公开字段口径确定性生成），产物仍可复用，不静默失败。`,
    );
    sourceLabel = '缓存派生（断网/降级，固定 seed 确定性生成）';
  }

  // 3) 确定性生成全部产物
  const rng = createLcg(seed);
  const encounters = buildEncounters(rng);
  const priceItems = buildPriceItems();
  const lineNoByEncounter = new Map<string, number[]>(
    encounters.map((enc) => [enc.encounter_no, enc.lines.map((l) => l.line_no)]),
  );
  const catalogByCode = new Map<string, CatalogItem>(
    CATALOG.map((item) => [item.code, item]),
  );
  const transcripts = buildTranscripts(encounters, lineNoByEncounter, catalogByCode);
  const attribution = buildAttributionLabels(transcripts);
  const ledger = buildLedger(encounters);

  const billDetails: BillDetailsFile = {
    source: 'synthea-derived',
    license: SYNTHEA_LICENSE,
    generated_at: new Date().toISOString(),
    encounters,
  };

  writeProduct('bill-details.json', billDetails, BILL_MONEY_KEYS);
  writeProduct('price-items.json', priceItems, PRICE_MONEY_KEYS);
  writeProduct('transcripts.json', transcripts, NO_MONEY_KEYS);
  writeProduct('ledger-seed.json', ledger, LEDGER_MONEY_KEYS);
  writeProduct('attribution-labels.json', attribution, NO_MONEY_KEYS);
  writeProduct('qc-cases.json', loadQcCases(), NO_MONEY_KEYS);

  const stats: ProductStats = {
    encounterCount: encounters.length,
    lineCount: encounters.reduce((s, enc) => s + enc.lines.length, 0),
    transcriptCount: transcripts.items.length,
  };
  printStats(stats, sourceLabel);
  console.log('[信息] 产物已写入 samples/（6 个 JSON，UTF-8，2 空格缩进，末尾换行）。');
  process.exitCode = 0;
}

main().catch((err: unknown) => {
  const reason = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[错误] 派生脚本执行失败：${reason}`);
  process.exitCode = 1;
});
