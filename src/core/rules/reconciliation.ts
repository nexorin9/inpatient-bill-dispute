/**
 * 金额勾稽双向校验（Task 29）。
 *
 * 官方口径（苏医保办发〔2021〕38 号）：
 *   金额合计 = 医保统筹基金支付 + 补充医疗保险支付 + 医疗救助支付 + 个人负担
 *   个人负担 = 其他支付 + 个人支付
 *
 * 两个方向都查：自上而下（分项合计对总额）、自下而上（总额拆回分项后的余额）、
 * 个人负担拆分。差额统一按分（0.01）取整比较，容差可配置、默认 0，避免浮点误差误报。
 */

import type { ReconciliationHit } from '../domain/contracts.ts';
import type { PaymentBreakdown } from '../domain/types.ts';
import type { ReconciliationDictionary } from '../dictionary/loader.ts';

const BASIS_TOP_DOWN = '苏医保办发〔2021〕38号 §二（四）·RECON-1';
const BASIS_BOTTOM_UP = '苏医保办发〔2021〕38号 §二（四）·RECON-1';
const BASIS_PERSONAL_SPLIT = '苏医保办发〔2021〕38号 §二（四）·RECON-2';

/** 元 → 分，四舍五入到整数分 */
export function toCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100);
}

export function reconcile(
  payment: PaymentBreakdown,
  toleranceCents = 0,
  dictionary?: ReconciliationDictionary,
): ReconciliationHit[] {
  const hits: ReconciliationHit[] = [];
  const basisTop = dictionary?.groups[0]?.basis_ref ?? BASIS_TOP_DOWN;
  const basisSplit = dictionary?.groups[1]?.basis_ref ?? BASIS_PERSONAL_SPLIT;

  // ① 自上而下：各支付口径之和与 total_amount 比对
  const components = toCents(payment.insuredFundPaid) + toCents(payment.supplementaryPaid) +
    toCents(payment.medicalAidPaid) + toCents(payment.personalBurden);
  const total = toCents(payment.totalAmount);
  if (Math.abs(components - total) > toleranceCents) {
    hits.push({
      direction: 'top_down',
      expected: total / 100,
      actual: components / 100,
      diffCents: components - total,
      basisRef: basisTop,
    });
  }

  // ② 自下而上：总额拆回各支付口径后的余额必须等于个人负担
  const remainder = total - toCents(payment.insuredFundPaid) - toCents(payment.supplementaryPaid) -
    toCents(payment.medicalAidPaid);
  const personal = toCents(payment.personalBurden);
  if (Math.abs(remainder - personal) > toleranceCents) {
    hits.push({
      direction: 'bottom_up',
      expected: personal / 100,
      actual: remainder / 100,
      diffCents: remainder - personal,
      basisRef: BASIS_BOTTOM_UP,
    });
  }

  // ③ 个人负担拆分：other_paid + personal_paid 与 personal_burden 比对
  const split = toCents(payment.otherPaid) + toCents(payment.personalPaid);
  if (Math.abs(split - personal) > toleranceCents) {
    hits.push({
      direction: 'personal_split',
      expected: personal / 100,
      actual: split / 100,
      diffCents: split - personal,
      basisRef: basisSplit,
    });
  }

  return hits;
}

/** 明细行合计与结算总额比对（HIS 明细 → 结算清单口径） */
export function reconcileLinesToTotal(
  lineAmounts: readonly number[],
  totalAmount: number,
  toleranceCents = 0,
): ReconciliationHit | undefined {
  const linesCents = lineAmounts.reduce((sum, amount) => sum + toCents(amount), 0);
  const totalCents = toCents(totalAmount);
  if (Math.abs(linesCents - totalCents) <= toleranceCents) return undefined;
  return {
    direction: 'top_down',
    expected: totalCents / 100,
    actual: linesCents / 100,
    diffCents: linesCents - totalCents,
    basisRef: BASIS_TOP_DOWN,
  };
}

/** 中文可读结论（供打印稿与留痕；不是面向家属的解释措辞） */
export function describeReconciliationHit(hit: ReconciliationHit): string {
  const direction = { top_down: '分项合计对总额', bottom_up: '总额拆回分项', personal_split: '个人负担拆分' }[hit.direction];
  return `${direction}不一致，差额 ${hit.diffCents} 分（期望 ${hit.expected.toFixed(2)}，实际 ${hit.actual.toFixed(2)}）；依据 ${hit.basisRef}`;
}
