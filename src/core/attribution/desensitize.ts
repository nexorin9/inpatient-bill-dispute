/**
 * 脱敏上下文构造（Task 19）—— 进模型前的最小必要信息。
 *
 * 姓名 / 证件号 / 床号 / 电话 / 住址在进模型前统一替换为占位；
 * 上下文只含掩码住院号（后 4 位）、本次住院的费用明细行、命中的价目项与命中的规则条目。
 * 每次调用落一份上下文摘要供内审复核「模型实际看到了什么」。
 */

import type { AttributionContext } from '../domain/contracts.ts';
import type { BillDetail, PriceItem } from '../domain/types.ts';
import type { RuleHit } from '../domain/contracts.ts';

export const PLACEHOLDER = {
  name: '[姓名已脱敏]',
  idCard: '[证件号已脱敏]',
  bed: '[床号已脱敏]',
  phone: '[电话已脱敏]',
  address: '[住址已脱敏]',
} as const;

const PATTERNS: Array<{ pattern: RegExp; placeholder: string }> = [
  { pattern: /\b\d{17}[\dXx]\b/g, placeholder: PLACEHOLDER.idCard },
  { pattern: /\b1[3-9]\d{9}\b/g, placeholder: PLACEHOLDER.phone },
  { pattern: /(床号|床位)\s*[:：]?\s*[A-Za-z]?\d{1,4}[-\d]{0,4}床?/g, placeholder: PLACEHOLDER.bed },
  { pattern: /\b\d{1,4}\s*床\b/g, placeholder: PLACEHOLDER.bed },
  { pattern: /(姓名|患者)\s*[:：]\s*[\u4e00-\u9fa5]{2,4}/g, placeholder: PLACEHOLDER.name },
  { pattern: /(住址|家庭地址|联系地址)\s*[:：]\s*[^\s,，。;；\n]{4,}/g, placeholder: PLACEHOLDER.address },
];

/** 通用脱敏器：保留字段语义、不保留原值 */
export function desensitizeText(input: string): string {
  let output = input;
  for (const { pattern, placeholder } of PATTERNS) output = output.replace(pattern, placeholder);
  return output;
}

/** 掩码住院号（固定 8 位：`****` + 后 4 位），用于日志与留痕 */
export function maskEncounterNoFixed(encounterNo: string): string {
  const trimmed = encounterNo.trim();
  return '****' + (trimmed.length >= 4 ? trimmed.slice(-4) : trimmed.padStart(4, '*'));
}

/** 逐字段去掉可识别信息后再替换自由文本中的身份模式 */
export function desensitizeBill(bill: BillDetail): BillDetail {
  return {
    ...bill,
    patientName: bill.patientName ? PLACEHOLDER.name : '',
    idCardNo: bill.idCardNo ? PLACEHOLDER.idCard : '',
    bedNo: bill.bedNo ? PLACEHOLDER.bed : '',
    lines: bill.lines.map((line) => ({ ...line, itemName: desensitizeText(line.itemName) })),
  };
}

export interface ContextInput {
  bill: BillDetail;
  priceItems: PriceItem[];
  ruleHits: RuleHit[];
  requestText: string;
}

/** 只含模型归因所需最小信息：不含证件号、住址、姓名、床号、完整住院号 */
export function buildAttributionContext(input: ContextInput): AttributionContext {
  const cleanBill = desensitizeBill(input.bill);
  const maskedEncounterNo = maskEncounterNoFixed(input.bill.encounterNo);
  const requestText = desensitizeText(input.requestText);
  const context: AttributionContext = {
    maskedEncounterNo,
    lines: cleanBill.lines,
    priceItems: input.priceItems.map((item) => ({ ...item, name: desensitizeText(item.name) })),
    ruleHits: input.ruleHits.map((h) => ({
      ruleId: h.ruleId, basisRef: h.basisRef, ...(h.lineNo !== undefined ? { lineNo: h.lineNo } : {}),
    })),
    requestText,
    summary: '',
  };
  context.summary = buildContextSummary(context);
  return context;
}

/** 供内审复核的上下文摘要（不含任何身份原值） */
export function buildContextSummary(context: AttributionContext): string {
  return JSON.stringify({
    masked_encounter_no: context.maskedEncounterNo,
    line_count: context.lines.length,
    line_numbers: context.lines.map((line) => line.lineNo),
    price_item_codes: context.priceItems.map((item) => item.priceItemCode),
    rule_hits: context.ruleHits.map((hit) => `${hit.ruleId}@${hit.basisRef}`),
    request_text_length: context.requestText.length,
  });
}

/** 进模型前的红线检查：命中即抛错，不把身份信息送出去 */
export function assertContextSafe(context: AttributionContext): void {
  const serialized = JSON.stringify(context);
  const forbidden = [
    /\b\d{17}[\dXx]\b/,
    /\b1[3-9]\d{9}\b/,
    /[^\s]{2,}省[^\s]{2,}市/,
    /(床号|住址|身份证号)\s*[:：]\s*[^\s\]]{2,}/,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(serialized)) {
      throw new Error('模型上下文含患者可识别信息，拒绝发起调用');
    }
  }
  if (!/^\*{4}.{4}$/.test(context.maskedEncounterNo)) {
    throw new Error('掩码住院号格式不合规');
  }
}

/** 上下文 JSON（送进 ModelGateway 的 user message） */
export function contextToJson(context: AttributionContext): string {
  assertContextSafe(context);
  return JSON.stringify({
    masked_encounter_no: context.maskedEncounterNo,
    lines: context.lines,
    price_items: context.priceItems,
    rule_hits: context.ruleHits,
    request_text: context.requestText,
  });
}
