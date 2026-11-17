/**
 * n:m 语义归并（Task 20）—— 质疑点 ↔ 费用明细行。
 *
 * 一条质疑可关联多行、一行可被多条质疑关联（n:m）；
 * 模型给出的行号必须真实存在于本次住院明细中，否则判为越界并拒收。
 * 低置信度不在本层丢弃，交由置信度阈值策略（Task 23）裁决。
 */

import { ErrorCode } from '../domain/errors.ts';
import type { AttributionItem } from '../domain/contracts.ts';

export interface MergeOutcome {
  matches: AttributionItem[];
  /** 越界被拒收的条目与错误码 */
  outOfBounds: Array<{ questionPoint: string; invalidLineNumbers: number[]; code: string }>;
  /** 无匹配质疑单独成条，分类 needs_human */
  unmatched: string[];
  /** 部分质疑未匹配标记 */
  partial: boolean;
  /** 质疑点 → 行号、行号 → 质疑点两张关系表（供逐条回指） */
  pointToLines: Record<string, number[]>;
  lineToPoints: Record<number, string[]>;
}

export function mergeAttribution(
  items: readonly AttributionItem[],
  validLineNumbers: readonly number[],
  questionPoints: readonly string[] = [],
): MergeOutcome {
  const valid = new Set(validLineNumbers);
  const matches: AttributionItem[] = [];
  const outOfBounds: MergeOutcome['outOfBounds'] = [];
  const pointToLines: Record<string, number[]> = {};
  const lineToPoints: Record<number, string[]> = {};

  for (const item of items) {
    const invalid = item.lineNumbers.filter((lineNo) => !valid.has(lineNo));
    if (invalid.length > 0) {
      // 越界拒收：丢弃该条归并，记越界错误码，不静默吞掉
      outOfBounds.push({
        questionPoint: item.questionPoint,
        invalidLineNumbers: invalid,
        code: ErrorCode.OUT_OF_BOUNDS,
      });
      continue;
    }
    if (item.lineNumbers.length === 0) continue;
    const accepted: AttributionItem = {
      questionPoint: item.questionPoint,
      lineNumbers: [...item.lineNumbers],
      category: item.category,
      confidence: item.confidence,
    };
    matches.push(accepted);
    pointToLines[accepted.questionPoint] = [
      ...new Set([...(pointToLines[accepted.questionPoint] ?? []), ...accepted.lineNumbers]),
    ];
    for (const lineNo of accepted.lineNumbers) {
      lineToPoints[lineNo] = [...new Set([...(lineToPoints[lineNo] ?? []), accepted.questionPoint])];
    }
  }

  const matchedPoints = new Set(matches.map((m) => m.questionPoint));
  const allPoints = new Set([...questionPoints, ...items.map((i) => i.questionPoint)]);
  const unmatched = [...allPoints].filter((point) => !matchedPoints.has(point));

  return {
    matches,
    outOfBounds,
    unmatched,
    partial: unmatched.length > 0 || outOfBounds.length > 0,
    pointToLines,
    lineToPoints,
  };
}

/** 未匹配质疑单独成条：分类「需人工判断」，不进外发队列 */
export function unmatchedAsItems(points: readonly string[]): AttributionItem[] {
  return points.map((point) => ({
    questionPoint: point,
    lineNumbers: [],
    category: 'needs_human',
    confidence: 0,
  }));
}
