/**
 * 跨模块契约类型 —— 归因、规则、外发、留痕共享的结构。
 * 单独成文件避免 domain/types.ts（院内业务事实）被流程结构污染。
 */

import type {
  BillLine,
  DisputeCategory,
  EvidenceRef,
  EvidenceType,
  PriceItem,
} from './types.ts';

// 业务层既可从 types.ts 也可从 contracts.ts 引用这些院内事实类型，保持单一来源
export type {
  BillLine,
  DisputeCategory,
  EvidenceRef,
  EvidenceType,
  PriceItem,
  PaymentBreakdown,
  BillDetail,
  Consultation,
  ConsultationStatus,
  ConsultationChannel,
} from './types.ts';

/** 质疑点种类 */
export type QuestionKind =
  | 'fee_item'
  | 'insurance_attribute'
  | 'amount'
  | 'duplicate_charge'
  | 'other';

/** 口述金额归一：解析不出时 uncertain=true，不猜一个数 */
export interface SpokenAmount {
  min: number;
  max: number;
  uncertain: boolean;
  raw: string;
}

/** 从家属原话抽出的一个质疑点（Task 7） */
export interface QuestionPoint {
  id: string;
  text: string;
  sourceQuote: string;
  charStart: number;
  charEnd: number;
  kind: QuestionKind;
  spokenAmount?: SpokenAmount;
}

/** 模型给出的质疑点 ↔ 明细行归并（Task 20） */
export interface AttributionItem {
  questionPoint: string;
  lineNumbers: number[];
  category: DisputeCategory;
  confidence: number;
}

/** 结构化模型响应：正文与引用分离（Task 6 / 22） */
export interface ResponsePart {
  text: string;
  citationIndexes: number[];
}

export interface ModelResponse {
  parts: ResponsePart[];
  attribution: AttributionItem[];
}

/** 解释稿引用（编号按首次出现顺序，Task 21） */
export interface Citation {
  index: number;
  type: EvidenceType;
  code: string;
  label: string;
  version?: string;
  lineNumbers: number[];
}

/** 面向家属的一条解释（Task 21 / 40） */
export interface ExplanationPart {
  lineNumbers: number[];
  /** 这笔是什么 */
  what: string;
  /** 为什么这样算 */
  why: string;
  citationIndexes: number[];
  /** 依据缺失 / 歧义拒答 → 需人工判断，不进外发队列 */
  needsHuman: boolean;
  evidenceMissing: boolean;
  category: DisputeCategory;
  confidence?: number;
  /** 裁剪保护项：需人工判断与高严重度规则命中不可裁剪 */
  protected: boolean;
  text?: string;
}

/** 规则命中：引擎只输出命中条目与依据编号，不产出自由文本（Task 8） */
export interface RuleHit {
  ruleId: string;
  basisRef: string;
  severity: 'low' | 'medium' | 'high';
  lineNo?: number;
  evidence: Record<string, unknown>;
  /** 依据缺失时命中「需人工判断」而非默认通过 */
  evidenceMissing?: boolean;
  missingDictionary?: string;
}

/** 金额勾稽结论（Task 29） */
export interface ReconciliationHit {
  direction: 'top_down' | 'bottom_up' | 'personal_split';
  expected: number;
  actual: number;
  diffCents: number;
  basisRef: string;
}

/** 确定性基线产物：降级路径与纯规则基线共用同一函数（Task 26 / 33） */
export interface BaselineResult {
  source: 'deterministic_baseline';
  dataSource: 'his' | 'samples';
  lineCount: number;
  coveredLineNumbers: number[];
  evidenceMissingLineNumbers: number[];
  ruleHits: RuleHit[];
  reconciliationHits: ReconciliationHit[];
  guardrailHits: RuleHit[];
  parts: ExplanationPart[];
  citations: Citation[];
  category: DisputeCategory;
  /** 降级时解释稿标「待人工撰写」 */
  draftPendingHuman: boolean;
}

/** 完整归因结果（Task 9 融合裁定 / Task 17 主干） */
export interface AttributionResult {
  consultationNo: string;
  encounterNoMasked: string;
  questionPoints: QuestionPoint[];
  matches: AttributionItem[];
  unmatchedQuestionPoints: string[];
  ruleHits: RuleHit[];
  reconciliationHits: ReconciliationHit[];
  parts: ExplanationPart[];
  citations: Citation[];
  /** 因篇幅被裁剪的明细行：依据仍留在引用清单与留痕中，不得静默漏行 */
  trimmedLineNumbers?: number[];
  category: DisputeCategory;
  /** 模型与规则冲突的裁定记录 */
  arbitration?: {
    modelCategory: DisputeCategory;
    ruleCategory: DisputeCategory;
    finalCategory: DisputeCategory;
    reason: string;
    evidenceRefs: string[];
  };
  degraded: boolean;
  degradationReason?: string;
  modelMeta?: ModelCallMeta;
  contextSummary: string;
  snapshotRef: string;
  dataSource: 'his' | 'samples';
  elapsedMs: number;
}

/** 每次模型调用的可审计元数据（Task 18）：不含 API key、不含可识别信息 */
export interface ModelCallMeta {
  model: string;
  modelVersion?: string;
  endpointDomain: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  retries: number;
  schemaValid: boolean;
  errorCode?: string;
}

/** 脱敏后的模型上下文（Task 19） */
export interface AttributionContext {
  maskedEncounterNo: string;
  lines: BillLine[];
  priceItems: PriceItem[];
  ruleHits: Array<{ ruleId: string; basisRef: string; lineNo?: number }>;
  requestText: string;
  summary: string;
}

/** 规模验收运行摘要（Task 27） */
export interface ScaleSummary {
  consultationCount: number;
  lineCount: number;
  coveredLines: number;
  missingLines: number;
  citationCoverage: number;
  refusalCount: number;
  elapsedMs: number;
  p50Ms: number;
  p95Ms: number;
}

/** 转办工单请求体（Task 38） */
export interface HandoffRequest {
  consultationNo: string;
  encounterNo: string;
  targetDept: '医保办' | '财务科' | '住院服务中心';
  reasonCode: string;
  evidenceRefs: EvidenceRef[];
  draftSummary: string;
  submittedBy: string;
}

export interface HandoffReceipt {
  workOrderNo: string;
  acceptedAt: string;
}

/** 打印稿（Task 40） */
export interface PrintDraft {
  consultationNo: string;
  title: string;
  body: string;
  citationSection: string[];
  categoryLabel: string;
  footer: string;
  filePath?: string;
  html?: string;
}
