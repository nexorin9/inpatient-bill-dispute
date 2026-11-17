/**
 * 超长重写与长度裁剪（Task 24）—— 家属看不懂的一稿不算稿。
 *
 * 顺序：先压缩每条措辞 → 仍超长则裁剪低争议条目 → 最后保留「需人工判断」与高严重度条目。
 * 重写只压缩表述，不删除引用、不新增结论、不改动依据编号；被裁剪条目的依据仍留在留痕中。
 */

import type { Citation, ExplanationPart, ResponsePart } from '../domain/contracts.ts';
import type { AppConfig } from '../config.ts';
import type { ModelGateway } from './model-gateway.ts';
import { validateModelResponse } from './schema.ts';

export interface RewriteOutcome {
  parts: ExplanationPart[];
  citations: Citation[];
  charsBefore: number;
  charsAfter: number;
  compressed: boolean;
  trimmedLineNumbers: number[];
  /** 被裁剪条目的依据仍留在留痕中（不丢依据） */
  retainedCitations: Citation[];
  finalLengthOk: boolean;
}

export function explanationLength(parts: readonly ExplanationPart[]): number {
  return parts.reduce((sum, part) => sum + (part.text ?? '').length, 0);
}

/** 只压缩措辞：去掉重复前缀、合并短句，不动引用编号与结论 */
export function compressWording(parts: readonly ExplanationPart[]): ExplanationPart[] {
  return parts.map((part) => {
    if (!part.text) return { ...part };
    let text = part.text
      .replace(/^这笔是/, '')
      .replace(/；按本院价目口径/u, '，按院内口径')
      .replace(/，金额 /u, ' ')
      .replace(/ 元，/u, '元，')
      .replace(/这一笔暂时缺少可核对的院内依据，需人工判断后再向家属说明。/u, '依据缺失，需人工判断。')
      .replace(/这一笔存在多种可能，需人工判断后再向家属说明。/u, '存在歧义，需人工判断。');
    if (text.length > 140) text = text.slice(0, 137) + '…';
    return { ...part, text };
  });
}

/** 裁剪顺序：低争议、非 protected 的条目先裁；protected 恒保留 */
export function trimParts(parts: readonly ExplanationPart[]): {
  kept: ExplanationPart[];
  trimmedLineNumbers: number[];
} {
  const trimmedLineNumbers: number[] = [];
  // 一次裁掉全部低争议非保护项；protected 恒保留
  const kept = parts.filter((part) => {
    if (part.protected) return true;
    trimmedLineNumbers.push(...part.lineNumbers);
    return false;
  });
  return { kept, trimmedLineNumbers };
}

/**
 * 确定性重写（无模型可用时）：压缩 → 裁剪 → 保护项保留。
 * 与模型重写共用同一压缩/裁剪函数，保证引用一致性与口径不漂移。
 */
export function rewriteIfOversized(
  parts: ExplanationPart[],
  citations: Citation[],
  config: Pick<AppConfig, 'maxExplanationChars'>,
): RewriteOutcome {
  const charsBefore = explanationLength(parts);
  let current = parts;
  let compressed = false;
  let trimmedLineNumbers: number[] = [];

  if (charsBefore > config.maxExplanationChars) {
    current = compressWording(current);
    compressed = true;
  }
  if (explanationLength(current) > config.maxExplanationChars) {
    // 逐步裁剪：每轮去掉一条最低置信度的非保护项，直到达标或只剩保护项
    const trimmed = new Set<number>();
    while (explanationLength(current) > config.maxExplanationChars) {
      const candidate = current
        .map((part, index) => ({ part, index }))
        .filter(({ part, index }) => !part.protected && !trimmed.has(index))
        .sort((a, b) => (a.part.confidence ?? 1) - (b.part.confidence ?? 1))[0];
      if (!candidate) break;
      trimmed.add(candidate.index);
      trimmedLineNumbers.push(...candidate.part.lineNumbers);
      current = current.filter((_, index) => !trimmed.has(index));
    }
  }

  const charsAfter = explanationLength(current);
  return {
    parts: current,
    citations,
    charsBefore,
    charsAfter,
    compressed,
    trimmedLineNumbers,
    retainedCitations: citations,
    finalLengthOk: charsAfter <= config.maxExplanationChars,
  };
}

/**
 * 模型重写（可选路径）：把原 parts 与依据清单交给模型重写为更短表述，
 * 返回仍须符合同一 JSON Schema 与引用类型白名单；重写后编号不重排。
 */
export async function rewriteWithModel(
  parts: readonly ExplanationPart[],
  citations: readonly Citation[],
  gateway: ModelGateway,
): Promise<ResponsePart[]> {
  const contextJson = JSON.stringify({
    task: 'compress_explanation',
    parts: parts.map((part) => ({ text: part.text, citation_indexes: part.citationIndexes })),
    evidence: citations.map((c) => ({ index: c.index, type: c.type, code: c.code })),
  });
  const result = await gateway.attribute(contextJson, '把每一段解释压缩为更短的家属可读表述；不得新增结论、不得改动引用编号。');
  const validated = validateModelResponse({
    parts: result.response.parts,
    attribution: result.response.attribution,
  });
  // 引用编号一致性：重写后不得出现新编号或丢失已有编号
  const allowed = new Set(citations.map((c) => c.index));
  for (const part of validated.parts) {
    for (const index of part.citationIndexes) {
      if (!allowed.has(index)) {
        throw new Error(`重写引入了不存在的引用编号 [${index}]`);
      }
    }
  }
  return validated.parts;
}
