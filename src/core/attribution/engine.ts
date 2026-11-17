/**
 * 归因引擎融合编排（Task 17 最窄主干 / Task 9 融合裁定 / Task 26 降级）。
 *
 * 路径：诉求文本 + 住院号 → HIS/价目（无凭据时读脱敏样例并标注数据来源）
 * → 确定性基线（规则命中 + 金额勾稽 + 三重绑定）→ 质疑点抽取 → n:m 归并
 * → 置信度阈值拒答 → 带引用解释稿 → 超长重写 → 禁语校验 → 三值分类融合
 * → 版本快照 → 咨询单落库（恒为草稿待确认）+ 归因留痕。
 *
 * 模型不可达时只出确定性产物，解释稿标「待人工撰写」，状态绝不推进到已答复。
 */

import { maskEncounterNo } from '../domain/mask.ts';
import type {
  AttributionItem,
  AttributionResult,
  Citation,
  EvidenceRef,
  QuestionPoint,
} from '../domain/contracts.ts';
import type { BillDetail, PriceBook } from '../domain/types.ts';
import { loadConfig, type AppConfig } from '../config.ts';
import { loadDictionaries, makeSnapshot, type DictionaryBundle } from '../dictionary/loader.ts';
import { HisBillingAdapter } from '../adapters/his.ts';
import { PricingAdapter } from '../adapters/pricing.ts';
import { loadSampleEncounter, loadSampleEncounters, loadSamplePriceBook } from '../adapters/samples.ts';
import { createRepositories, openStore, type Repositories } from '../../db/index.ts';
import { buildSnapshotPayload } from '../rules/snapshot.ts';
import { arbitrate } from '../rules/classification.ts';
import { ModelGateway } from './model-gateway.ts';
import { buildAttributionContext, contextToJson, maskEncounterNoFixed } from './desensitize.ts';
import { extractQuestionPoints } from './question-points.ts';
import { mergeAttribution } from './merge.ts';
import { applyAmbiguityPolicy, type RefusalRecord } from './ambiguity.ts';
import { buildExplanation } from './explanation.ts';
import { rewriteIfOversized } from './rewrite.ts';
import { checkCompliance } from './compliance.ts';
import { assertDegradedStatus, allowedDegradedStatus, buildBaseline, degradationRecord, type DegradationRecord } from './baseline.ts';

export interface ExplainInput {
  consultationNo: string;
  encounterNo: string;
  requestText: string;
  channel?: 'counter' | 'phone' | 'online';
  operator?: string;
  /** 显式指定数据来源；未指定时按凭据可用性决定 */
  dataSource?: 'his' | 'samples';
  config?: AppConfig;
  env?: NodeJS.ProcessEnv;
  repos?: Repositories;
  /** 不传时按 env 构造；凭据不齐则不启用模型路径 */
  gateway?: ModelGateway;
  bundle?: DictionaryBundle;
}

export interface ExplainOutcome {
  result: AttributionResult;
  degradation?: DegradationRecord;
  /** 主动确定性基线（模型未配置）不等于「调用失败降级」；后者才标待人工撰写 */
  baselineMode: boolean;
  draftPendingHuman: boolean;
  complianceOk: boolean;
  complianceViolations: string[];
  sessionRound: number;
  draftFilePath?: string;
  classificationFilePath?: string;
}

/** 取明细与价目：凭据齐备走真实端点；否则读脱敏样例并显式标注 */
export async function loadBillAndPrices(
  input: Pick<ExplainInput, 'encounterNo' | 'env' | 'dataSource'>,
): Promise<{ bill: BillDetail; priceBook: PriceBook; dataSource: 'his' | 'samples' }> {
  const env = input.env ?? process.env;
  const his = new HisBillingAdapter(env);
  const pricing = new PricingAdapter(env);
  const useHis = input.dataSource === 'his' || (input.dataSource !== 'samples' && his.isConfigured() && pricing.isConfigured());
  if (useHis) {
    const [bill, priceBook] = await Promise.all([his.fetchDetails(input.encounterNo), pricing.fetchPriceBook()]);
    return { bill, priceBook, dataSource: 'his' };
  }
  const bill = loadSampleEncounter(input.encounterNo) ?? loadSampleEncounters()[0]!;
  return { bill, priceBook: loadSamplePriceBook(), dataSource: 'samples' };
}

/**
 * 家属口语俗称 → 收费项目正式名称（本地领域词表，非官方字典）。
 * 只用于把「病房的钱」「开刀的钱」这类口语回指到明细行的项目名；
 * 命中不了就走宽泛线索，绝不凭空猜一个项目。
 */
export const COLLOQUIAL_ITEM_ALIASES: Readonly<Record<string, string>> = {
  '病房的钱': '床位费', '医生看病的钱': '诊察费', '查房的钱': '住院诊查费',
  '拍片子的钱': 'CT 平扫', '做 B 超的钱': '彩色多普勒超声', '验血的钱': '血常规',
  '抽血化验的钱': '生化全套', '挂水的钱': '静脉输液', '换药包的钱': '换药',
  '打麻药的钱': '麻醉费', '开刀的钱': '阑尾切除术', '护士照看的钱': '一级护理',
  '输液管的钱': '一次性输液器', '盐水的钱': '氯化钠注射液', '消炎针的钱': '注射用头孢呋辛',
  '中药饮片的钱': '黄芪饮片', '中成药的钱': '复方丹参滴丸', '诊疗费': '一般诊疗费',
  '挂号的钱': '挂号费', '空调费': '空调降温费', '心电监护的钱': '心电监护',
  '吸氧的钱': '氧气吸入',
};

/** 「化验」「床位」等大类俗称 → 费用归集类目（比项目名宽泛，作为次级线索） */
const FEE_CLASS_ALIASES: Readonly<Record<string, readonly string[]>> = {
  化验: ['化验费'], 检查: ['检查费'], 床位: ['床位费'], 病房: ['床位费'],
  药: ['西药费', '中成药费', '中药饮片费'], 手术: ['手术费'], 护理: ['护理费'],
  材料: ['卫生材料费'], 诊察: ['诊察费'], 治疗: ['治疗费'],
};

/**
 * 确定性语义归并（无模型通道时的本地实现）：
 * 按质疑点里的项目正式名称 / 口语俗称回指明细行；只有完全找不到精确项目证据时，
 * 才退到费用类目与口述金额这类宽泛线索。一次诉求里只要有一个点拿到精确证据，
 * 全部点都只保留精确证据，避免「多算了 3200 元」这类金额句把无关行挂进来。
 * 与「每行全覆盖」的纯规则基线区分开，供对照评测比较覆盖率与误挂率。
 */
export function deterministicMatches(bill: BillDetail, points: readonly QuestionPoint[]): AttributionItem[] {
  const perPoint = points.map((point) => {
    const precise = new Set<number>();
    const loose = new Set<number>();
    for (const line of bill.lines) {
      if (line.itemName.length >= 2 && point.text.includes(line.itemName)) precise.add(line.lineNo);
    }
    for (const [colloquial, formal] of Object.entries(COLLOQUIAL_ITEM_ALIASES)) {
      if (!point.text.includes(colloquial)) continue;
      for (const line of bill.lines.filter((l) => l.itemName === formal)) precise.add(line.lineNo);
    }
    for (const [word, classes] of Object.entries(FEE_CLASS_ALIASES)) {
      if (!point.text.includes(word)) continue;
      for (const line of bill.lines.filter((l) => classes.includes(l.feeClass))) loose.add(line.lineNo);
    }
    const spoken = point.spokenAmount;
    if (spoken && !spoken.uncertain && spoken.min > 0) {
      for (const line of bill.lines.filter((l) => l.amount >= spoken.min && l.amount <= spoken.max)) {
        loose.add(line.lineNo);
      }
    }
    return { point, precise: [...precise].sort((a, b) => a - b), loose: [...loose].sort((a, b) => a - b) };
  });

  const hasPreciseEvidence = perPoint.some((entry) => entry.precise.length > 0);
  return perPoint.map(({ point, precise, loose }) => {
    const lineNumbers = hasPreciseEvidence ? precise : loose;
    return {
      questionPoint: point.text,
      lineNumbers,
      category: 'internal_check',
      confidence: lineNumbers.length > 0 ? 0.92 : 0.3,
    } satisfies AttributionItem;
  });
}

function evidenceRefsFrom(citations: readonly Citation[]): EvidenceRef[] {
  return citations.map((c) => ({ type: c.type, code: c.code, label: c.label, version: c.version }));
}

/** 一次完整归因：主干 cli explain 与桌面端共用 */
export async function runAttribution(input: ExplainInput): Promise<ExplainOutcome> {
  const started = Date.now();
  const env = input.env ?? process.env;
  const config = input.config ?? loadConfig(env);
  const bundle = input.bundle ?? loadDictionaries();
  const repos = input.repos ?? createRepositories(openStore());
  const { bill, priceBook, dataSource } = await loadBillAndPrices({
    encounterNo: input.encounterNo, env, dataSource: input.dataSource,
  });

  // ① 确定性基线（规则 + 勾稽 + 三重绑定），同时是降级产物与对照基线
  const baseline = buildBaseline({
    bill, priceBook, bundle, config, dataSource,
    consultationDate: bill.admissionDate,
  });

  // ② 质疑点抽取 + 脱敏上下文
  const gateway = input.gateway ?? (new ModelGateway(env).isConfigured() ? new ModelGateway(env) : undefined);
  const context = buildAttributionContext({
    bill, priceItems: priceBook.items,
    ruleHits: [...baseline.ruleHits, ...baseline.guardrailHits], requestText: input.requestText,
  });
  const extraction = await extractQuestionPoints(input.requestText, {
    ...(gateway ? { gateway } : {}),
    contextJson: contextToJson(context),
  });

  // ③ 模型归因（结构化）或确定性语义归并；任一失败都走同一条降级链
  let items: AttributionItem[] = deterministicMatches(bill, extraction.points);
  let degraded = false;
  let baselineMode = false;
  let draftPendingHuman = false;
  let degradation: DegradationRecord | undefined;
  let modelMeta: AttributionResult['modelMeta'];
  let retries = 0;
  if (gateway) {
    try {
      const call = await gateway.attribute(contextToJson(context));
      const merged = mergeAttribution(call.response.attribution, bill.lines.map((l) => l.lineNo), extraction.points.map((p) => p.text));
      items = merged.matches;
      modelMeta = call.meta;
      if (merged.outOfBounds.length > 0) {
        // 越界拒收记错误码，但不让整条归因失败（部分质疑未匹配）
        items.push(...merged.unmatched.map((point) => ({
          questionPoint: point, lineNumbers: [], category: 'needs_human' as const, confidence: 0,
        })));
      }
    } catch (err) {
      // 模型调用失败：只出确定性层产物，解释稿标「待人工撰写」，状态不推进
      degraded = true;
      draftPendingHuman = true;
      degradation = degradationRecord(err, retries);
      retries = degradation.retries;
      items = [];
    }
  } else {
    // 主动确定性基线（Task 17 主干）：模型未配置不算调用失败，仍出带引用解释稿
    baselineMode = true;
  }

  // ④ 置信度阈值与歧义拒答
  const ambiguity = applyAmbiguityPolicy(items, config, {
    unmatched: extraction.points.map((p) => p.text).filter((p) => !items.some((i) => i.questionPoint === p)),
  });
  const refusedLineNumbers = ambiguity.refusedLineNumbers;

  // ⑤ 带引用解释稿（覆盖全部明细行，零漏行）
  const explanation = buildExplanation({
    bill, priceBook, bundle,
    matches: ambiguity.accepted,
    ruleHits: [...baseline.ruleHits, ...baseline.guardrailHits],
    citationsEnabled: config.citationsEnabled,
    evidenceMissingLineNumbers: baseline.evidenceMissingLineNumbers,
    refusedLineNumbers,
    priceVersion: priceBook.version,
  });
  const rewrite = rewriteIfOversized(explanation.parts, explanation.citations, config);
  if (draftPendingHuman) {
    // 降级路径：解释稿标「待人工撰写」，只保留确定性结论集，不冒充模型措辞
    for (const part of rewrite.parts) part.text = `[待人工撰写] ${part.text ?? ''}`;
  }

  // ⑥ 禁语与越界校验：命中即标不可外发，不静默放行
  const compliance = checkCompliance({
    parts: rewrite.parts,
    plainText: rewrite.parts.map((p) => p.text ?? '').join('\n'),
    structured: { category: 'internal_check', confidence: 0.9, note: input.requestText },
  });

  // ⑦ 三值分类融合裁定：模型与规则冲突以规则为准
  const verdict = arbitrate({
    ruleHits: [...baseline.ruleHits, ...baseline.guardrailHits],
    reconciliationHits: baseline.reconciliationHits,
    evidenceMissingCount: baseline.evidenceMissingLineNumbers.length,
    ...(modelMeta ? { modelCategory: 'internal_check' as const } : {}),
    ambiguous: refusedLineNumbers.length > 0,
  });

  // ⑧ 版本快照 + 落库（状态恒为草稿待确认）
  const versions = makeSnapshot(priceBook.version, bundle, { consultationNo: input.consultationNo });
  const maskedEncounterNo = maskEncounterNoFixed(bill.encounterNo);
  const existing = repos.consultations.find(input.consultationNo);
  const status = existing ? allowedDegradedStatus(existing.status) : 'draft_pending_confirm';
  assertDegradedStatus(status);
  const now = new Date().toISOString();
  const payload = buildSnapshotPayload(versions, {
    citations: explanation.citations,
    parts: rewrite.parts,
    ruleHits: [...baseline.ruleHits, ...baseline.guardrailHits],
    evidenceRefs: evidenceRefsFrom(explanation.citations),
    priceItemCodes: priceBook.items.map((i) => i.priceItemCode),
    dictionaryAnchors: bundle.settlement.fields.filter((f) => f.provenance === 'official_listed').slice(0, 12).map((f) => f.name),
    createdAt: now,
  });
  repos.snapshots.save(versions.snapshotRef, payload as unknown as Record<string, unknown>);

  if (!existing) {
    repos.consultations.insert({
      consultationNo: input.consultationNo,
      channel: input.channel ?? 'counter',
      encounterNo: bill.encounterNo,
      encounterNoMasked: maskEncounterNo(bill.encounterNo),
      requestText: input.requestText,
      status,
      disputeCategory: verdict.category,
      amount: bill.payment.totalAmount,
      priceVersion: versions.priceVersion,
      dictionaryVersion: versions.dictionaryVersion,
      rulesVersion: versions.rulesVersion,
      snapshotRef: versions.snapshotRef,
      handoffFailed: false,
      createdAt: now,
      updatedAt: now,
    });
    repos.billLines.replaceAll(input.consultationNo, bill.lines);
  } else {
    repos.consultations.update(input.consultationNo, {
      disputeCategory: verdict.category,
      priceVersion: versions.priceVersion,
      dictionaryVersion: versions.dictionaryVersion,
      rulesVersion: versions.rulesVersion,
      snapshotRef: versions.snapshotRef,
    }, now);
  }

  // 篇幅裁剪删掉的是「解释措辞」，不是依据：被裁剪行号显式写入留痕与结果，
  // 让零漏行可复核（每行要么在解释稿里，要么标依据缺失/拒答，要么标篇幅裁剪）。
  const trimmedLineNumbers = [...new Set(rewrite.trimmedLineNumbers)].sort((a, b) => a - b);
  const rejections: Array<Record<string, unknown>> = [
    ...ambiguity.refusals.map((r: RefusalRecord) => ({ ...r })),
    ...trimmedLineNumbers.map((lineNo) => ({
      questionPoint: `篇幅裁剪：明细行 ${lineNo}`,
      lineNumbers: [lineNo],
      reason: '解释稿超长按低争议条目裁剪，依据保留在引用清单中，未删除依据',
      code: 'EXPLANATION_TRIMMED',
    })),
  ];
  const session = repos.sessions.append({
    consultationNo: input.consultationNo,
    citations: evidenceRefsFrom(explanation.citations),
    model: modelMeta?.model,
    modelVersion: modelMeta?.modelVersion,
    endpointDomain: modelMeta?.endpointDomain,
    tokens: modelMeta?.totalTokens,
    latencyMs: modelMeta?.latencyMs ?? Date.now() - started,
    retries,
    schemaValid: modelMeta?.schemaValid ?? true,
    guardrailHits: [...baseline.ruleHits, ...baseline.guardrailHits].map((h) => h.basisRef),
    operator: input.operator ?? '',
    maskedEncounterNo,
    degraded,
    failureType: degradation?.failureType,
    contextSummary: context.summary,
    snapshot: payload as unknown as Record<string, unknown>,
    rejections,
    createdAt: now,
  });

  const result: AttributionResult = {
    consultationNo: input.consultationNo,
    encounterNoMasked: maskedEncounterNo,
    questionPoints: extraction.points,
    matches: ambiguity.accepted,
    unmatchedQuestionPoints: ambiguity.refusals.map((r) => r.questionPoint),
    ruleHits: [...baseline.ruleHits, ...baseline.guardrailHits],
    reconciliationHits: baseline.reconciliationHits,
    parts: rewrite.parts,
    citations: explanation.citations,
    ...(trimmedLineNumbers.length > 0 ? { trimmedLineNumbers } : {}),
    category: verdict.category,
    arbitration: verdict.arbitration,
    degraded,
    degradationReason: degradation?.failureType,
    modelMeta,
    contextSummary: context.summary,
    snapshotRef: versions.snapshotRef,
    dataSource,
    elapsedMs: Date.now() - started,
  };

  return {
    result,
    degradation,
    baselineMode,
    draftPendingHuman,
    complianceOk: compliance.ok,
    complianceViolations: compliance.violations.map((v) => `${v.location}: ${v.term}`),
    sessionRound: session.roundNo,
  };
}
