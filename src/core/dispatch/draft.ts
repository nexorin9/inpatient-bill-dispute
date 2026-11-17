/**
 * 解释稿与争议分类单落盘（Task 17 最窄主干产物）。
 *
 * 逐条输出「这笔是什么 / 为什么这样算 / 依据编号」，引用编号按首次出现顺序生成；
 * 产物落 outbox/，每条引用可回指明本行号与依据编号，供收费员确认后打印。
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { CATEGORY_LABELS } from '../config.ts';
import type { AttributionResult, Citation, ExplanationPart } from '../domain/contracts.ts';

const OUTBOX = new URL('../../../outbox/', import.meta.url);

export interface DraftFiles {
  explanationPath: string;
  classificationPath: string;
  citationCount: number;
  lineCoverage: number[];
}

function citationMap(citations: readonly Citation[]): string[] {
  return citations.map((c) =>
    `- [${c.index}] 类型=${c.type} 依据编号=${c.code} 名称=${c.label} 关联明细行=${c.lineNumbers.join(',') || '无'}`);
}

export function renderExplanationMarkdown(result: AttributionResult, label: string): string {
  const lines = [
    `# 住院费用口径解释稿（${label}）`,
    '',
    `- 咨询编号：${result.consultationNo}`,
    `- 住院号（掩码）：${result.encounterNoMasked}`,
    `- 数据来源：${result.dataSource === 'his' ? 'HIS 真实接口 + 本院价目目录' : '本地脱敏样例（非真实院内数据）'}`,
    `- 争议分类：${CATEGORY_LABELS[result.category] ?? result.category}`,
    `- 依据版本快照：${result.snapshotRef}`,
    `- 引用条数：${result.citations.length}`,
    `- 质疑点数：${result.questionPoints.length} ｜ 归并条目：${result.matches.length} ｜ 拒答：${result.unmatchedQuestionPoints.length}`,
    `- 规则命中：${result.ruleHits.length} ｜ 金额勾稽命中：${result.reconciliationHits.length}`,
    `- 模型通道：${result.degraded ? `降级（${result.degradationReason ?? '不可达'}）` : result.modelMeta ? result.modelMeta.model : '确定性基线'}`,
    '',
    '## 一、逐笔说明',
    '',
  ];
  result.parts.forEach((part: ExplanationPart, index) => {
    lines.push(`${index + 1}. ${part.text ?? ''}`);
    lines.push(`   - 明细行：${part.lineNumbers.join(',') || '未匹配'} ｜ 依据编号：${part.citationIndexes.map((i) => `[${i}]`).join('') || '依据缺失'}`);
    if (part.needsHuman) lines.push('   - 标记：需人工判断（不进外发队列）');
  });
  lines.push('', '## 二、依据编号与明细行对照', '');
  lines.push(...citationMap(result.citations));
  lines.push('', '## 三、状态与合规', '');
  lines.push('- 咨询单状态：草稿待确认（收费员确认是唯一放行闸门，未确认不得外发）');
  lines.push('- 需人工判断条目不进入打印稿正文、不进转办工单、不进 IM 推送');
  lines.push('- 本稿只描述费用口径与依据，不含诊断、治疗建议、报销承诺');
  if (result.arbitration) {
    lines.push(`- 融合裁定：模型分类 ${result.arbitration.modelCategory} 与规则结论冲突，以规则 ${result.arbitration.ruleCategory} 为准`);
  }
  return lines.join('\n') + '\n';
}

export function renderClassification(result: AttributionResult): Record<string, unknown> {
  return {
    consultation_no: result.consultationNo,
    encounter_no_masked: result.encounterNoMasked,
    category: result.category,
    category_label: CATEGORY_LABELS[result.category] ?? result.category,
    status: 'draft_pending_confirm',
    data_source: result.dataSource,
    snapshot_ref: result.snapshotRef,
    degraded: result.degraded,
    question_points: result.questionPoints.map((p) => ({
      id: p.id, text: p.text, kind: p.kind, char_start: p.charStart, char_end: p.charEnd,
      spoken_amount: p.spokenAmount ?? null,
    })),
    matches: result.matches,
    unmatched: result.unmatchedQuestionPoints,
    rule_hits: result.ruleHits.map((h) => ({ rule_id: h.ruleId, basis_ref: h.basisRef, line_no: h.lineNo ?? null, severity: h.severity })),
    reconciliation_hits: result.reconciliationHits,
    citations: result.citations,
    parts: result.parts.map((p) => ({
      line_numbers: p.lineNumbers, citation_indexes: p.citationIndexes,
      needs_human: p.needsHuman, evidence_missing: p.evidenceMissing, category: p.category,
    })),
    arbitration: result.arbitration ?? null,
  };
}

/** 落盘：解释稿 + 争议分类单，返回路径与引用条数 */
export function writeDraftFiles(
  result: AttributionResult,
  options: { label?: string; writeFile?: boolean } = {},
): DraftFiles {
  const label = options.label ?? (result.degraded ? '待人工撰写' : '草稿待确认');
  const markdown = renderExplanationMarkdown(result, label);
  const classification = renderClassification(result);
  if (options.writeFile === false) {
    return { explanationPath: '', classificationPath: '', citationCount: result.citations.length, lineCoverage: [] };
  }
  mkdirSync(OUTBOX, { recursive: true });
  const explanationUrl = new URL(`explanation-${result.consultationNo}.md`, OUTBOX);
  const classificationUrl = new URL(`classification-${result.consultationNo}.json`, OUTBOX);
  writeFileSync(explanationUrl, markdown, 'utf8');
  writeFileSync(classificationUrl, JSON.stringify(classification, null, 2) + '\n', 'utf8');
  return {
    explanationPath: explanationUrl.pathname,
    classificationPath: classificationUrl.pathname,
    citationCount: result.citations.length,
    lineCoverage: result.parts.flatMap((p) => p.lineNumbers),
  };
}
