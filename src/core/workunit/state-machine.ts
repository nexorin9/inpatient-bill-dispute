/**
 * 六态状态机服务层（Task 34）—— 撤回语义与状态守卫。
 *
 * 合法跃迁表驱动（复用 Task 1 的 domain/state-machine.ts），非法跃迁一律拒绝并返回统一错误码；
 * 未确认态可撤回，撤回记录操作人与时间，撤回后不得再被外发通道取用。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import {
  ALLOWED_TRANSITIONS,
  STATUS_LABELS,
  applyTransition,
  canTransition,
  isUnconfirmed,
} from '../domain/state-machine.ts';
import type { Consultation, ConsultationStatus } from '../domain/types.ts';
import type { ConsultationRecord, Repositories } from '../../db/index.ts';

export interface WithdrawalRecord {
  consultationNo: string;
  operator: string;
  withdrawnAt: string;
  fromStatus: ConsultationStatus;
}

export class ConsultationStateService {
  private readonly withdrawals = new Map<string, WithdrawalRecord>();

  private readonly repos: Repositories;

  constructor(repos: Repositories) {
    this.repos = repos;
  }

  /** 全部合法跃迁（供测试逐对断言） */
  legalTransitions(): Array<[ConsultationStatus, ConsultationStatus]> {
    return Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => [from as ConsultationStatus, to as ConsultationStatus] as [ConsultationStatus, ConsultationStatus]));
  }

  /** 跃迁执行器：非法跃迁抛统一错误码并给出可读原因，状态不变 */
  transition(
    consultationNo: string,
    to: ConsultationStatus,
    options: { confirmedBy?: string; at?: string } = {},
  ): ConsultationRecord {
    const record = this.repos.consultations.find(consultationNo);
    if (!record) throw new AppError(ErrorCode.ILLEGAL_TRANSITION, { consultationNo, reason: '咨询单不存在' });
    if (!canTransition(record.status, to)) {
      throw new AppError(ErrorCode.ILLEGAL_TRANSITION, {
        consultationNo,
        from: record.status,
        to,
        reason: `${STATUS_LABELS[record.status]} → ${STATUS_LABELS[to]} 不允许`,
      });
    }
    const asDomain: Consultation = {
      consultationNo: record.consultationNo,
      channel: record.channel,
      encounterNo: record.encounterNo,
      encounterNoMasked: record.encounterNoMasked,
      requestText: record.requestText,
      status: record.status,
      amount: record.amount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.disputeCategory ? { disputeCategory: record.disputeCategory } : {}),
      ...(record.confirmedAt ? { confirmedAt: record.confirmedAt } : {}),
      ...(record.confirmedBy ? { confirmedBy: record.confirmedBy } : {}),
      ...(record.workOrderNo ? { workOrderNo: record.workOrderNo } : {}),
    };
    const next = applyTransition(asDomain, to, options);
    this.repos.consultations.update(consultationNo, {
      status: next.status,
      ...(next.confirmedAt ? { confirmedAt: next.confirmedAt } : {}),
      ...(next.confirmedBy ? { confirmedBy: next.confirmedBy } : {}),
    }, options.at);
    return this.repos.consultations.find(consultationNo)!;
  }

  /** 撤回：仅限未确认态，记录操作人与时间 */
  withdraw(consultationNo: string, operator: string, at?: string): WithdrawalRecord {
    const record = this.repos.consultations.find(consultationNo);
    if (!record) throw new AppError(ErrorCode.ILLEGAL_TRANSITION, { consultationNo, reason: '咨询单不存在' });
    if (!isUnconfirmed(record.status)) {
      throw new AppError(ErrorCode.ILLEGAL_TRANSITION, {
        consultationNo, from: record.status, reason: '已确认态不可撤回',
      });
    }
    const withdrawnAt = at ?? new Date().toISOString();
    this.transition(consultationNo, 'withdrawn', { at: withdrawnAt });
    const entry: WithdrawalRecord = {
      consultationNo, operator, withdrawnAt, fromStatus: record.status,
    };
    this.withdrawals.set(consultationNo, entry);
    return entry;
  }

  /** 状态守卫：确认闸门与外发通道只接受满足前置状态的咨询单 */
  assertDispatchable(consultationNo: string): ConsultationRecord {
    const record = this.repos.consultations.find(consultationNo);
    if (!record) throw new AppError(ErrorCode.ILLEGAL_TRANSITION, { consultationNo, reason: '咨询单不存在' });
    if (record.status === 'withdrawn') {
      throw new AppError(ErrorCode.ILLEGAL_TRANSITION, { consultationNo, reason: '已撤回咨询不可被外发通道取用' });
    }
    return record;
  }

  isWithdrawn(consultationNo: string): boolean {
    return this.withdrawals.has(consultationNo) ||
      this.repos.consultations.find(consultationNo)?.status === 'withdrawn';
  }
}
