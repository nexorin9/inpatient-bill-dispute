/**
 * 确认闸门（Task 11）—— 收费员确认是唯一放行闸门。
 *
 * 打印稿 / 转办工单 / IM 推送三条外发通道在发起前调用同一 gate 函数校验
 * confirmed_at 与允许外发的状态；绕过确认的外发调用一律被拒并记错误码。
 * 撤回即失效；需人工判断条目即便已确认也不进任何外发通道。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { ConsultationRecord, Repositories } from '../../db/index.ts';
import type { ConsultationStateService } from '../workunit/state-machine.ts';

export type OutboundChannel = 'print' | 'workorder' | 'im';

export const OUTBOUND_CHANNELS: readonly OutboundChannel[] = ['print', 'workorder', 'im'];

/** 允许外发的状态：已确认且未撤回、未关闭 */
const DISPATCHABLE_STATUSES = ['draft_pending_confirm', 'answered', 'transferred'] as const;

export interface GateVerdict {
  allowed: boolean;
  consultationNo: string;
  channel: OutboundChannel;
  record: ConsultationRecord;
  reason: string;
}

export class ConfirmationGate {
  private readonly repos: Repositories;
  private readonly states: ConsultationStateService;

  constructor(
    repos: Repositories,
    states: ConsultationStateService,
  ) {
    this.repos = repos;
    this.states = states;
  }

  /** 确认动作：写 confirmed_at 与确认人；未确认的咨询单 confirmed_at 为空 */
  confirm(consultationNo: string, operator: string, at?: string): ConsultationRecord {
    const record = this.repos.consultations.find(consultationNo);
    if (!record) throw new AppError(ErrorCode.ILLEGAL_TRANSITION, { consultationNo, reason: '咨询单不存在' });
    if (record.status === 'withdrawn' || record.status === 'closed') {
      throw new AppError(ErrorCode.ILLEGAL_TRANSITION, {
        consultationNo, from: record.status, reason: '已撤回 / 已关闭的咨询不可确认',
      });
    }
    this.repos.consultations.update(consultationNo, {
      confirmedAt: at ?? new Date().toISOString(),
      confirmedBy: operator,
    });
    return this.repos.consultations.find(consultationNo)!;
  }

  /** 统一闸门：三条通道共用；未确认 → ERR_CONFIRM_REQUIRED */
  assertAllowed(
    consultationNo: string,
    channel: OutboundChannel,
    options: { category?: string; hasNeedsHumanItems?: boolean } = {},
  ): GateVerdict {
    const record = this.states.assertDispatchable(consultationNo);
    const base = { consultationNo, channel, record };
    if (!record.confirmedAt) {
      throw new AppError(ErrorCode.CONFIRM_REQUIRED, {
        consultationNo, channel, reason: '尚未经收费员确认，不得外发',
      });
    }
    if (!(DISPATCHABLE_STATUSES as readonly string[]).includes(record.status)) {
      throw new AppError(ErrorCode.ILLEGAL_TRANSITION, {
        consultationNo, channel, from: record.status, reason: '当前状态不允许外发',
      });
    }
    if (options.hasNeedsHumanItems || options.category === 'needs_human' || record.disputeCategory === 'needs_human') {
      // 与「未确认」分开：这里 confirmed_at 已就绪，是分类本身禁止外发。
      // 复用 CONFIRM_REQUIRED 会让收费员误以为自己没点确认而反复重试。
      throw new AppError(ErrorCode.OUTBOUND_BLOCKED, {
        consultationNo, channel, reason: '含需人工判断条目，即便已确认也不进任何外发通道',
      });
    }
    return { ...base, allowed: true, reason: '确认闸门放行' };
  }

  /** 撤回后闸门一并拒绝（已确认记录保留但不可再外发） */
  assertNotWithdrawn(consultationNo: string): void {
    if (this.states.isWithdrawn(consultationNo)) {
      throw new AppError(ErrorCode.ILLEGAL_TRANSITION, { consultationNo, reason: '已撤回咨询不可再外发' });
    }
  }
}
