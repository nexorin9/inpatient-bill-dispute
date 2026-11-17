/**
 * 咨询单六态状态机 —— 唯一能推进咨询状态的地方。
 *
 * 模型与规则层都不得绕过它：归因只产出草稿，收费员确认才允许进入「已答复 / 已转办」，
 * 撤回只允许发生在未确认态。
 */

import { AppError, ErrorCode } from './errors.ts';
import type { Consultation, ConsultationStatus } from './types.ts';

/** 六态的中文名（界面与导出件共用） */
export const STATUS_LABELS: Record<ConsultationStatus, string> = {
  pending_reply: '待答复',
  draft_pending_confirm: '草稿待确认',
  answered: '已答复',
  transferred: '已转办',
  closed: '已关闭',
  withdrawn: '已撤回',
};

/** 允许的状态跃迁表（表驱动：新增状态只改这张表，不改执行器） */
export const ALLOWED_TRANSITIONS: Readonly<Record<ConsultationStatus, readonly ConsultationStatus[]>> = {
  pending_reply: ['draft_pending_confirm', 'withdrawn'],
  draft_pending_confirm: ['answered', 'transferred', 'withdrawn'],
  answered: ['closed'],
  transferred: ['closed'],
  closed: [],
  withdrawn: [],
};

/** 未确认态：这些状态下允许撤回 */
export const UNCONFIRMED_STATES: readonly ConsultationStatus[] = ['pending_reply', 'draft_pending_confirm'];

/** 已确认态：只有这些状态对应「已经过收费员确认」 */
export const CONFIRMED_STATES: readonly ConsultationStatus[] = ['answered', 'transferred', 'closed'];

/** 该状态是否属于未确认态 */
export function isUnconfirmed(status: ConsultationStatus): boolean {
  return UNCONFIRMED_STATES.includes(status);
}

/** 该状态是否属于已确认态 */
export function isConfirmedStatus(status: ConsultationStatus): boolean {
  return CONFIRMED_STATES.includes(status);
}

/** 跃迁是否被允许 */
export function canTransition(from: ConsultationStatus, to: ConsultationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 状态跃迁执行器：非法跃迁一律拒绝并抛出统一错误码 ERR_ILLEGAL_TRANSITION，
 * 调用方据此把咨询单原样留在当前状态（不静默改数据）。
 */
export function assertTransition(from: ConsultationStatus, to: ConsultationStatus): void {
  if (canTransition(from, to)) return;
  throw new AppError(ErrorCode.ILLEGAL_TRANSITION, {
    from,
    to,
    fromLabel: STATUS_LABELS[from],
    toLabel: STATUS_LABELS[to],
    allowed: ALLOWED_TRANSITIONS[from],
    reason: `${STATUS_LABELS[from]} → ${STATUS_LABELS[to]} 不允许`,
  });
}

/** 跃迁执行器：校验通过后返回新状态，不修改入参 */
export function nextStatus(from: ConsultationStatus, to: ConsultationStatus): ConsultationStatus {
  assertTransition(from, to);
  return to;
}

/**
 * 在咨询单上执行一次状态跃迁（不可变：返回新对象）。
 *
 * 附带外发闸门的前置校验：未确认态不得直接进入已答复 / 已转办。
 * 传入 `confirmedBy` 视为「收费员在这一刻确认」，同时落下确认时间；
 * 不传且此前也没有确认记录 → ERR_CONFIRM_REQUIRED。
 */
export function applyTransition(
  consultation: Consultation,
  to: ConsultationStatus,
  options: { at?: string; confirmedBy?: string } = {},
): Consultation {
  assertTransition(consultation.status, to);

  const at = options.at ?? new Date().toISOString();
  const confirmedAt = consultation.confirmedAt ?? (options.confirmedBy ? at : undefined);

  const needsConfirmation = to === 'answered' || to === 'transferred';
  if (needsConfirmation && !confirmedAt) {
    throw new AppError(ErrorCode.CONFIRM_REQUIRED, {
      consultationNo: consultation.consultationNo,
      status: consultation.status,
      target: to,
    });
  }

  return {
    ...consultation,
    status: to,
    confirmedAt,
    confirmedBy: consultation.confirmedBy ?? options.confirmedBy,
    updatedAt: at,
  };
}
