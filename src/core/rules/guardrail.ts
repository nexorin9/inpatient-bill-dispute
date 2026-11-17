/**
 * 医保属性与价目版本守门 + 三重绑定校验（Task 30）。
 *
 * ① 明细 fee_category 与本院价目 insurance_attribute 冲突即命中；价目中无该编码即标依据缺失。
 * ② 价目 version 缺失、过期（effective_from 晚于咨询发生日）时该行标依据缺失，
 *    不静默用现价回算历史。
 * ③ 三重绑定：住院号 + 明细行号 + 收费项目编码缺一即拒绝归因并返回统一错误码。
 * ④ 住院号命中多条住院记录时抛歧义错误，要求人工选定，禁止自动取第一条。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { RuleHit } from '../domain/contracts.ts';
import type { BillDetail, FeeCategory, PriceBook, PriceItem } from '../domain/types.ts';
import { exactMatchPrice } from '../adapters/pricing.ts';
import { hit, missingEvidenceHit, type RuleContext } from './engine.ts';

const ATTRIBUTE_BY_CATEGORY: Record<FeeCategory, string | undefined> = {
  甲类: '甲',
  乙类: '乙',
  自费: '自费',
  其他: undefined,
};

export const GUARDRAIL_BASIS = '价目目录·医保属性与版本守门（医保办发〔2021〕34 号修订版）';

/** 三重绑定校验：不通过直接抛统一错误码，调用方不得产出解释稿 */
export function assertGuardrailBinding(bill: BillDetail): void {
  if (!bill.encounterNo || bill.encounterNo.trim().length === 0) {
    throw new AppError(ErrorCode.BINDING_INCOMPLETE, { missing: 'encounter_no' });
  }
  for (const line of bill.lines) {
    if (line.lineNo === undefined || line.lineNo === null) {
      throw new AppError(ErrorCode.BINDING_INCOMPLETE, { missing: 'line_no' });
    }
    if (!line.priceItemCode || line.priceItemCode.trim().length === 0) {
      throw new AppError(ErrorCode.BINDING_INCOMPLETE, { lineNo: line.lineNo, missing: 'price_item_code' });
    }
  }
  if ((bill.candidateCount ?? 1) > 1) {
    throw new AppError(ErrorCode.AMBIGUOUS, {
      encounterNo: bill.encounterNo,
      candidateCount: bill.candidateCount,
      reason: '住院号命中多条住院记录，需人工选定',
    });
  }
}

/** 单条明细的价目守门结果 */
export interface GuardrailVerdict {
  lineNo: number;
  priceItem?: PriceItem;
  evidenceMissing: boolean;
  reason?: string;
  attributeConsistent: boolean;
}

export function checkLine(
  line: { lineNo: number; priceItemCode: string; feeCategory: FeeCategory },
  book: PriceBook | undefined,
  consultationDate?: string,
): GuardrailVerdict {
  if (!book) {
    return { lineNo: line.lineNo, evidenceMissing: true, reason: '价目目录不可得', attributeConsistent: false };
  }
  const item = exactMatchPrice(book, line.priceItemCode);
  if (!item) {
    return { lineNo: line.lineNo, evidenceMissing: true, reason: '价目编码未命中（依据缺失）', attributeConsistent: false };
  }
  if (!book.version || !item.version) {
    return { lineNo: line.lineNo, priceItem: item, evidenceMissing: true, reason: '价目版本缺失', attributeConsistent: false };
  }
  if (consultationDate && item.effectiveFrom && item.effectiveFrom > consultationDate) {
    return {
      lineNo: line.lineNo, priceItem: item, evidenceMissing: true,
      reason: '价目生效日期晚于咨询发生日（版本过期）', attributeConsistent: false,
    };
  }
  const expected = ATTRIBUTE_BY_CATEGORY[line.feeCategory];
  const consistent = expected !== undefined && expected === item.insuranceAttribute;
  return { lineNo: line.lineNo, priceItem: item, evidenceMissing: false, attributeConsistent: consistent };
}

export function guardrailHits(ctx: RuleContext): RuleHit[] {
  assertGuardrailBinding(ctx.bill);
  const hits: RuleHit[] = [];
  for (const line of ctx.bill.lines) {
    const verdict = checkLine(line, ctx.priceBook, ctx.consultationDate);
    if (verdict.evidenceMissing) {
      hits.push(missingEvidenceHit('GUARD-PRICE', GUARDRAIL_BASIS, '本院价目目录（含版本与生效日期）', {
        line_no: line.lineNo, price_item_code: line.priceItemCode, reason_code: verdict.reason,
      }));
      continue;
    }
    if (!verdict.attributeConsistent) {
      hits.push(hit(
        { id: 'GUARD-ATTR', basisRef: GUARDRAIL_BASIS, severity: 'high' },
        line.lineNo,
        {
          price_item_code: line.priceItemCode,
          fee_category: line.feeCategory,
          insurance_attribute: verdict.priceItem?.insuranceAttribute,
          price_version: verdict.priceItem?.version,
        },
      ));
    }
  }
  return hits;
}
