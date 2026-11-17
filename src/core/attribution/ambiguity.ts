/**
 * 歧义拒绝与置信度阈值（Task 23）—— 答不清就说答不清。
 *
 * 置信度低于阈值、或阈值附近（±margin）、或命中多条互斥明细、或质疑点无法唯一归并时，
 * 输出「需人工判断」而不是硬凑解释；被拒条目不进入外发队列，且逐条留痕。
 */

import type { AttributionItem } from '../domain/contracts.ts';
import type { AppConfig } from '../config.ts';

export interface RefusalRecord {
  questionPoint: string;
  lineNumbers: number[];
  threshold: number;
  rawConfidence: number;
  reason: string;
  candidateLineNumbers?: number[];
}

export interface AmbiguityOutcome {
  accepted: AttributionItem[];
  refusals: RefusalRecord[];
  refusedLineNumbers: number[];
  isolated: AttributionItem[];
}

/** 互斥候选：同一质疑关联多行且分数接近（差值 ≤ margin）时列出候选行号供界面选定 */
export interface CandidateGroup {
  questionPoint: string;
  scores: Array<{ lineNumbers: number[]; confidence: number }>;
}

export function detectMutuallyExclusive(groups: readonly CandidateGroup[], margin: number): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const group of groups) {
    if (group.scores.length < 2) continue;
    const sorted = [...group.scores].sort((a, b) => b.confidence - a.confidence);
    const first = sorted[0]!;
    const second = sorted[1]!;
    if (first.confidence - second.confidence <= margin) {
      result.set(group.questionPoint, [...new Set(sorted.flatMap((s) => s.lineNumbers))]);
    }
  }
  return result;
}

export function applyAmbiguityPolicy(
  items: readonly AttributionItem[],
  config: Pick<AppConfig, 'minConfidence' | 'confidenceMargin'>,
  options: { unmatched?: string[]; candidateGroups?: CandidateGroup[] } = {},
): AmbiguityOutcome {
  const accepted: AttributionItem[] = [];
  const refusals: RefusalRecord[] = [];
  const isolated: AttributionItem[] = [];
  const exclusive = detectMutuallyExclusive(options.candidateGroups ?? [], config.confidenceMargin);

  for (const item of items) {
    const candidates = exclusive.get(item.questionPoint);
    let reason = '';
    if (item.confidence < config.minConfidence) {
      reason = `置信度 ${item.confidence.toFixed(2)} 低于阈值 ${config.minConfidence}`;
    } else if (Math.abs(item.confidence - config.minConfidence) <= config.confidenceMargin) {
      reason = `置信度 ${item.confidence.toFixed(2)} 落在阈值 ±${config.confidenceMargin} 边界带，保留原始分数供人工参考`;
    } else if (candidates && candidates.length > 1) {
      reason = '命中多条互斥明细且分数接近，需人工选定';
    } else if (item.lineNumbers.length === 0) {
      reason = '质疑点无法唯一归并到明细行';
    }
    if (reason) {
      refusals.push({
        questionPoint: item.questionPoint,
        lineNumbers: item.lineNumbers,
        threshold: config.minConfidence,
        rawConfidence: item.confidence,
        reason,
        ...(candidates ? { candidateLineNumbers: candidates } : {}),
      });
      isolated.push({ ...item, category: 'needs_human' });
    } else {
      accepted.push(item);
    }
  }

  for (const point of options.unmatched ?? []) {
    refusals.push({
      questionPoint: point, lineNumbers: [], threshold: config.minConfidence,
      rawConfidence: 0, reason: '质疑点完全无法匹配到本次住院明细',
    });
    isolated.push({ questionPoint: point, lineNumbers: [], category: 'needs_human', confidence: 0 });
  }

  return {
    accepted,
    refusals,
    refusedLineNumbers: [...new Set(refusals.flatMap((r) => r.lineNumbers))],
    isolated,
  };
}

/** 被拒条目隔离：不进打印稿、不进转办工单、不进 IM 推送 */
export function filterOutbound<T extends { needsHuman?: boolean; category?: string }>(items: readonly T[]): T[] {
  return items.filter((item) => !item.needsHuman && item.category !== 'needs_human');
}
