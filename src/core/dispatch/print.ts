/**
 * 家属可读打印稿渲染（Task 40）—— 看得懂、拿得走。
 *
 * 逐条说明（这笔是什么 / 为什么这样算 / 依据编号）+ 争议分类 + 需人工处理项提示，
 * 输出可打印 HTML 到 outbox/。稿内不得出现字段名、内部术语、患者身份信息；
 * 判为需人工判断的条目不进入正文，只在页脚提示收费员另有说明。
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { CATEGORY_LABELS } from '../config.ts';
import type { Citation, ExplanationPart, PrintDraft } from '../domain/contracts.ts';

const OUTBOX = new URL('../../../outbox/', import.meta.url);

/** 内部字段名与术语黑名单：打印稿措辞净化 */
export const INTERNAL_TERMS = [
  'fee_category', 'price_item_code', 'line_no', 'encounter_no', 'insurance_attribute',
  'confidence', 'disputeCategory', 'priceVersion', 'snapshotRef', 'citationIndexes',
  'needs_human', 'internal_check', 'to_insurance_office', 'ModelGateway', 'Schema',
];

const IDENTITY_PATTERNS = [
  /\b\d{17}[\dXx]\b/, /\b1[3-9]\d{9}\b/, /床号\s*[:：]?\s*\d+/,
  /姓名\s*[:：]\s*[^\s,，。;；]{2,}/, /住址\s*[:：]/,
];

export interface PrintInput {
  consultationNo: string;
  encounterNoMasked: string;
  parts: readonly ExplanationPart[];
  citations: readonly Citation[];
  category: string;
  date?: string;
  hospitalName?: string;
  writeFile?: boolean;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]!);
}

/** 措辞净化：不出现内部字段名；身份信息净化：不含证件号 / 床号 / 电话 / 姓名 */
export function assertPrintSafe(text: string): void {
  for (const term of INTERNAL_TERMS) {
    if (text.includes(term)) throw new Error(`打印稿出现内部字段名：${term}`);
  }
  for (const pattern of IDENTITY_PATTERNS) {
    if (pattern.test(text)) throw new Error('打印稿含患者身份信息，拒发');
  }
}

function citationLabel(type: string): string {
  return { price_item: '本院价目', settlement_field: '结算清单字段', rule: '审核规则' }[type] ?? '院内依据';
}

export function renderPrintDraft(input: PrintInput): PrintDraft {
  const date = (input.date ?? new Date().toISOString()).slice(0, 10);
  const bodyParts = input.parts.filter((part) => !part.needsHuman);
  const humanParts = input.parts.filter((part) => part.needsHuman);
  const usedIndexes = new Set(bodyParts.flatMap((part) => part.citationIndexes));
  const usedCitations = input.citations.filter((c) => usedIndexes.has(c.index));

  const lines: string[] = [
    `${input.hospitalName ?? '本院'} · 住院费用口径说明`,
    `咨询编号：${input.consultationNo}    住院号（掩码）：${input.encounterNoMasked}    日期：${date}`,
    '',
    '一、逐笔说明',
  ];
  if (bodyParts.length === 0) {
    lines.push('本次暂无可对外说明的条目，收费员将另行当面说明。');
  }
  bodyParts.forEach((part, index) => {
    lines.push(`${index + 1}. ${part.text ?? ''}`);
  });
  lines.push('', '二、依据清单');
  for (const citation of usedCitations) {
    lines.push(`  [${citation.index}] ${citationLabel(citation.type)}：${citation.label}（${citation.code}）`);
  }
  lines.push('', `三、处理意见：${CATEGORY_LABELS[input.category] ?? input.category}`);
  if (input.category === 'to_insurance_office') {
    lines.push('  本条已转医保办核对，后续以医保办回复为准。');
  } else if (input.category === 'needs_human') {
    lines.push('  部分条目需人工判断，收费员将另行说明。');
  } else {
    lines.push('  费用口径已按院内价目与结算清单核对，如有疑问可凭咨询编号再次查询。');
  }
  const footer = humanParts.length > 0
    ? `另有 ${humanParts.length} 笔需人工判断，由收费员另行说明（不列入本稿正文）。`
    : '本稿仅说明费用口径与依据，不含诊疗建议。';
  lines.push('', footer);

  const body = lines.join('\n');
  assertPrintSafe(body);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>住院费用口径说明 ${escapeHtml(input.consultationNo)}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:760px;margin:40px auto;line-height:1.9;color:#1f2937}
h1{font-size:20px;border-bottom:2px solid #1F6FEB;padding-bottom:12px}pre{white-space:pre-wrap;font:inherit}.footer{margin-top:32px;font-size:12px;color:#6b7280}</style>
</head><body><h1>住院费用口径说明</h1><pre>${escapeHtml(body)}</pre><div class="footer">打印件 · 咨询编号 ${escapeHtml(input.consultationNo)}</div></body></html>`;

  let filePath: string | undefined;
  if (input.writeFile !== false) {
    mkdirSync(OUTBOX, { recursive: true });
    const url = new URL(`print-${input.consultationNo}.html`, OUTBOX);
    writeFileSync(url, html, 'utf8');
    filePath = url.pathname;
  }
  return {
    consultationNo: input.consultationNo,
    title: '住院费用口径说明',
    body,
    citationSection: usedCitations.map((c) => `[${c.index}] ${citationLabel(c.type)}：${c.label}`),
    categoryLabel: CATEGORY_LABELS[input.category] ?? input.category,
    footer,
    ...(filePath ? { filePath } : {}),
    html,
  };
}
