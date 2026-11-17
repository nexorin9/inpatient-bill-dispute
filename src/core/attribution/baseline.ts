/**
 * 确定性基线 + 模型不可达降级链（Task 26 / Task 33 同源实现）。
 *
 * 模型不可达 / 超时 / Schema 校验失败时，只产出确定性层产物
 * （明细清单 + 规则命中 + 勾稽结论），解释稿标「待人工撰写」，
 * 咨询单保持「草稿待确认」或退回「待答复」，绝不自动推进到「已答复」。
 *
 * 降级产物与对照评测的「纯规则基线」走同一个 buildBaseline 函数，口径不漂移。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { BaselineResult, Citation, ExplanationPart } from '../domain/contracts.ts';
import type { BillDetail, PriceBook } from '../domain/types.ts';
import type { AppConfig } from '../config.ts';
import type { DictionaryBundle } from '../dictionary/loader.ts';
import { exactMatchPrice } from '../adapters/pricing.ts';
import {
  createDefaultRuleRegistry, guardrailHits, reconcile, ruleOnlyCategory, runRules,
  type RuleContext,
} from '../rules/index.ts';
import { buildExplanation } from './explanation.ts';

export interface BaselineInput {
  bill: BillDetail;
  priceBook: PriceBook;
  bundle: DictionaryBundle;
  config: AppConfig;
  dataSource: 'his' | 'samples';
  consultationDate?: string;
  /** 历史复现时传入旧规则集版本 */
  rulesVersion?: string;
}

/** 确定性层：规则命中 + 金额勾稽 + 医保属性核验 + 三重绑定校验 */
export function buildBaseline(input: BaselineInput): BaselineResult {
  const ctx: RuleContext = {
    bill: input.bill,
    priceBook: input.priceBook,
    bundle: input.bundle,
    consultationDate: input.consultationDate,
  };
  const registry = createDefaultRuleRegistry(input.rulesVersion);
  const ruleHits = runRules(ctx, registry);
  const guardrail = guardrailHits(ctx);
  const reconciliationHits = reconcile(input.bill.payment, input.config.reconciliationToleranceCents, input.bundle.reconciliation);

  const evidenceMissingLineNumbers = input.bill.lines
    .filter((line) => !exactMatchPrice(input.priceBook, line.priceItemCode))
    .map((line) => line.lineNo);
  const coveredLineNumbers = input.bill.lines
    .map((line) => line.lineNo)
    .filter((lineNo) => !evidenceMissingLineNumbers.includes(lineNo));

  // 基线不调用模型：把每行明细视作一个确定性「质疑点」，覆盖全部行（零漏行）
  const matches = input.bill.lines.map((line) => ({
    questionPoint: `明细行 ${line.lineNo}`,
    lineNumbers: [line.lineNo],
    category: 'internal_check' as const,
    confidence: 1,
  }));

  const explanation = buildExplanation({
    bill: input.bill,
    priceBook: input.priceBook,
    bundle: input.bundle,
    matches,
    ruleHits: [...ruleHits, ...guardrail],
    citationsEnabled: input.config.citationsEnabled,
    evidenceMissingLineNumbers,
  });

  const verdict = ruleOnlyCategory({
    ruleHits: [...ruleHits, ...guardrail],
    reconciliationHits,
    evidenceMissingCount: evidenceMissingLineNumbers.length,
  });

  return {
    source: 'deterministic_baseline',
    dataSource: input.dataSource,
    lineCount: input.bill.lines.length,
    coveredLineNumbers,
    evidenceMissingLineNumbers,
    ruleHits,
    reconciliationHits,
    guardrailHits: guardrail,
    parts: explanation.parts,
    citations: explanation.citations,
    category: verdict.category,
    draftPendingHuman: true,
  };
}

export const DEGRADED_ALLOWED_STATUSES = ['draft_pending_confirm', 'pending_reply'] as const;

/** 状态保护不变量：降级后咨询单状态只能在这两态之间 */
export function assertDegradedStatus(status: string): void {
  if (!(DEGRADED_ALLOWED_STATUSES as readonly string[]).includes(status)) {
    throw new AppError(ErrorCode.ILLEGAL_TRANSITION, {
      status,
      reason: '模型降级后咨询单状态不得被推进到已答复 / 已转办',
    });
  }
}

export function allowedDegradedStatus(current: string): 'draft_pending_confirm' | 'pending_reply' {
  return current === 'pending_reply' ? 'pending_reply' : 'draft_pending_confirm';
}

export interface DegradationRecord {
  failureType: 'timeout' | 'http_5xx' | 'schema_invalid' | 'credentials_missing' | 'parse_failed';
  errorCode: string;
  retries: number;
  degraded: true;
  baselineRef: 'deterministic_baseline';
  explanationLabel: '待人工撰写';
}

export function degradationRecord(error: unknown, retries = 0): DegradationRecord {
  const code = error instanceof AppError ? error.code : ErrorCode.PARSE_FAILED;
  const failureType = code === ErrorCode.TIMEOUT ? 'timeout'
    : code === ErrorCode.HTTP_5XX ? 'http_5xx'
      : code === ErrorCode.SCHEMA_INVALID ? 'schema_invalid'
        : code === ErrorCode.CREDENTIALS_MISSING ? 'credentials_missing'
          : 'parse_failed';
  return {
    failureType, errorCode: code, retries, degraded: true,
    baselineRef: 'deterministic_baseline', explanationLabel: '待人工撰写',
  };
}

/** 降级渲染：解释稿标「待人工撰写」，但仍保留确定性基线结论集 */
export function renderDegradedDraft(baseline: BaselineResult): string {
  const lines = [
    '住院费用口径核对说明（草稿 · 待人工撰写）',
    '说明：模型通道当前不可用，以下仅为院内核对的确定性结论，供收费员人工撰写解释稿时参考。',
    '',
    `本次住院明细共 ${baseline.lineCount} 行，其中 ${baseline.coveredLineNumbers.length} 行有可核对依据，` +
      `${baseline.evidenceMissingLineNumbers.length} 行依据缺失（需人工判断）。`,
    `规则命中 ${baseline.ruleHits.length} 条，金额勾稽命中 ${baseline.reconciliationHits.length} 条，` +
      `属性守门命中 ${baseline.guardrailHits.length} 条。`,
    '',
  ];
  for (const part of baseline.parts as ExplanationPart[]) {
    lines.push(`- ${part.text ?? ''}`);
  }
  if (baseline.citations.length > 0) {
    lines.push('', '依据清单：');
    for (const citation of baseline.citations as Citation[]) {
      lines.push(`  [${citation.index}] ${citation.type} ${citation.code} ${citation.label}`);
    }
  }
  return lines.join('\n');
}
