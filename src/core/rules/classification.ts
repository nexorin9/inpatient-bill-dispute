/**
 * 争议分类三值映射与归因 × 规则融合裁定（Task 9）。
 *
 * 三值：院内核对（依据齐备、无高风险命中）/ 需转医保办（§4 高风险命中或医保属性争议）
 * / 需人工判断（依据缺失、歧义拒答、模型与规则冲突且无法裁定）。
 * 模型分类与规则结论冲突时以规则为准，并记录裁定原因、双方证据与被否决的模型分类。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { AttributionResult, ReconciliationHit, RuleHit } from '../domain/contracts.ts';
import type { DisputeCategory } from '../domain/types.ts';

type Category = DisputeCategory;

export interface ClassificationInput {
  ruleHits: RuleHit[];
  reconciliationHits: ReconciliationHit[];
  /** 依据缺失的明细行数 */
  evidenceMissingCount?: number;
  /** 模型给出的分类（未提供时视为纯规则运行） */
  modelCategory?: Category;
  /** 模型置信度（Task 23 的低置信度由拒答策略先处理） */
  modelConfidence?: number;
  ambiguous?: boolean;
}

export interface ClassificationVerdict {
  category: Category;
  /** 支撑依据编号：无依据的分类不得产生 */
  evidenceRefs: string[];
  reasons: string[];
  /** 规则侧独立结论（融合前） */
  ruleCategory: Category;
}

const HIGH_RISK_PREFIXES = ['§4-', 'GUARD-ATTR'];

export function ruleOnlyCategory(input: ClassificationInput): ClassificationVerdict {
  const evidenceRefs = [
    ...input.ruleHits.map((h) => h.basisRef),
    ...input.reconciliationHits.map((h) => h.basisRef),
  ];
  const reasons: string[] = [];
  let category: Category = 'internal_check';

  const highRisk = input.ruleHits.filter((h) =>
    h.severity === 'high' && HIGH_RISK_PREFIXES.some((prefix) => h.ruleId.startsWith(prefix)));
  if (highRisk.length > 0) {
    category = 'to_insurance_office';
    reasons.push(`负面清单/属性守门高风险命中 ${highRisk.length} 条，直接归「需转医保办」`);
  }
  // 行级依据缺失才把整单判需人工判断；规则级「字典缺项」只影响该条规则的结论，
  // 不把整张咨询单一票否决（否则院内字典尚未齐备时所有咨询都会被隔离）。
  const rowLevelMissing = input.ruleHits.filter((h) => h.evidenceMissing && h.lineNo !== undefined);
  if (rowLevelMissing.length > 0 || (input.evidenceMissingCount ?? 0) > 0) {
    category = 'needs_human';
    reasons.push(`明细行依据缺失 ${Math.max(rowLevelMissing.length, input.evidenceMissingCount ?? 0)} 项，标「需人工判断」`);
  }
  if (input.ambiguous) {
    category = 'needs_human';
    reasons.push('存在互斥候选或歧义拒答，标「需人工判断」');
  }
  if (input.reconciliationHits.length > 0) {
    reasons.push(`金额勾稽命中 ${input.reconciliationHits.length} 项`);
    if (category === 'internal_check') category = 'needs_human';
  }
  if (category === 'internal_check') {
    reasons.push('依据齐备、无高风险命中，归「院内核对」');
  }
  if (evidenceRefs.length === 0) {
    // 无依据的分类不得产生：院内核对须有价目/清单字段依据
    throw new AppError(ErrorCode.EVIDENCE_MISSING, { reason: '分类结论缺支撑依据编号' });
  }
  return { category, evidenceRefs: [...new Set(evidenceRefs)], reasons, ruleCategory: category };
}

/** 融合裁定：冲突时以规则为准，写入 attribution_sessions 的裁定记录 */
export function arbitrate(
  input: ClassificationInput,
): ClassificationVerdict & { arbitration?: AttributionResult['arbitration'] } {
  const ruleVerdict = ruleOnlyCategory(input);
  if (!input.modelCategory || input.modelCategory === ruleVerdict.ruleCategory) {
    return ruleVerdict;
  }
  return {
    ...ruleVerdict,
    arbitration: {
      modelCategory: input.modelCategory,
      ruleCategory: ruleVerdict.ruleCategory,
      finalCategory: ruleVerdict.ruleCategory,
      reason: '模型分类与规则结论冲突，按「规则守门优先」以规则为准',
      evidenceRefs: ruleVerdict.evidenceRefs,
    },
  };
}

export const CATEGORY_VALUES: readonly Category[] = [
  'internal_check', 'to_insurance_office', 'needs_human',
];

/** 高风险隔离：需转医保办的条目不进外发队列，只进转办通道 */
export function isOutboundAllowed(category: Category): boolean {
  return category === 'internal_check';
}

/** 需人工判断条目隔离：即便已确认也不进任何外发通道 */
export function isNeedsHuman(category: Category): boolean {
  return category === 'needs_human';
}
