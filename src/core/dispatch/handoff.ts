/**
 * 转办工单提交 + 回执写回 + IM 白名单推送（Tasks 38 / 39 / 11 编排）。
 *
 * 提交前统一过确认闸门；幂等键由 adapter 生成，失败按指数退避重试（≤3），
 * 仍失败则显式标「转办失败待重试」并写错误码，不静默失败、不假装已提交。
 * 回执写回必须经合法跃迁把状态置「已转办」并记录工单号；IM 只推四个白名单字段。
 */

import type { EvidenceRef, HandoffRequest } from '../domain/contracts.ts';
import type { Repositories } from '../../db/index.ts';
import { WorkOrderAdapter, type HandoffOutcome } from '../adapters/workorder.ts';
import { ImAdapter, type ImOutcome } from '../adapters/im.ts';
import type { ConfirmationGate } from './gate.ts';
import type { ConsultationStateService } from '../workunit/state-machine.ts';

export interface SubmitHandoffInput {
  consultationNo: string;
  reasonCode: string;
  draftSummary: string;
  submittedBy: string;
  evidenceRefs: EvidenceRef[];
  /** IM 白名单字段 */
  imFields?: { priceItemCode: string; disputeCategory: string; draftNo: string };
}

export interface SubmitHandoffOutcome {
  ok: boolean;
  handoff: HandoffOutcome;
  im?: ImOutcome;
  workOrderNo?: string;
  status?: string;
  errorCode?: string;
  needsRetry: boolean;
}

export class HandoffService {
  private readonly repos: Repositories;
  private readonly gate: ConfirmationGate;
  private readonly states: ConsultationStateService;
  private readonly workorder: WorkOrderAdapter;
  private readonly im: ImAdapter;

  constructor(
    repos: Repositories,
    gate: ConfirmationGate,
    states: ConsultationStateService,
    workorder: WorkOrderAdapter,
    im: ImAdapter,
  ) {
    this.repos = repos;
    this.gate = gate;
    this.states = states;
    this.workorder = workorder;
    this.im = im;
  }

  async submit(input: SubmitHandoffInput): Promise<SubmitHandoffOutcome> {
    // ① 统一确认闸门：未确认 / 撤回 / 需人工判断一律拒绝
    this.gate.assertAllowed(input.consultationNo, 'workorder');
    const record = this.repos.consultations.find(input.consultationNo)!;
    const request: HandoffRequest = {
      consultationNo: input.consultationNo,
      encounterNo: record.encounterNo,
      targetDept: '医保办',
      reasonCode: input.reasonCode,
      evidenceRefs: input.evidenceRefs,
      draftSummary: input.draftSummary,
      submittedBy: input.submittedBy,
    };

    // ② 真实写路径（幂等键 + 退避重试 + 失败可观测）
    const handoff = await this.workorder.submit(request);
    if (!handoff.ok || !handoff.receipt) {
      this.repos.consultations.update(input.consultationNo, { handoffFailed: true });
      return {
        ok: false, handoff, errorCode: handoff.errorCode,
        needsRetry: handoff.needsRetry,
      };
    }

    // ③ 回执写回：经合法跃迁置「已转办」并记录工单号与接收时间
    const receipt = handoff.receipt;
    try {
      this.states.transition(input.consultationNo, 'transferred', {
        confirmedBy: input.submittedBy, at: receipt.acceptedAt,
      });
    } catch {
      // 已是 transferred（同键重放）时不重复跃迁，只补工单号
      const current = this.repos.consultations.find(input.consultationNo);
      if (current?.status !== 'transferred') throw new Error('回执写回状态跃迁失败');
    }
    this.repos.consultations.update(input.consultationNo, {
      workOrderNo: receipt.workOrderNo,
      handoffFailed: false,
    });

    // ④ IM 推送（白名单四字段，失败不阻断主流程但必须可观测）
    let im: ImOutcome | undefined;
    if (input.imFields) {
      this.gate.assertAllowed(input.consultationNo, 'im');
      im = await this.im.push({
        consultationNo: input.consultationNo,
        priceItemCode: input.imFields.priceItemCode,
        disputeCategory: input.imFields.disputeCategory,
        draftNo: input.imFields.draftNo,
      });
    }
    return {
      ok: true, handoff, im, workOrderNo: receipt.workOrderNo,
      status: 'transferred', needsRetry: false,
    };
  }
}

/** 回执解析与写回（Task 39）：响应缺 work_order_no 时视为失败，不写状态 */
export function parseReceipt(raw: unknown): { ok: boolean; workOrderNo?: string; acceptedAt?: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const record = raw as Record<string, unknown>;
  const workOrderNo = record.work_order_no ?? record.workOrderNo;
  if (typeof workOrderNo !== 'string' || workOrderNo.length === 0) return { ok: false };
  const acceptedAt = record.accepted_at ?? record.acceptedAt;
  return {
    ok: true, workOrderNo,
    ...(typeof acceptedAt === 'string' ? { acceptedAt } : {}),
  };
}
