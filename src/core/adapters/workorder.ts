/**
 * 科室交办工单出站适配器（真实写路径 · 主路径）。
 *
 * POST {WORKORDER_BASE_URL}/api/v1/consultations/{consultation_no}/handoff
 * Authorization: Bearer $WORKORDER_TOKEN
 * Idempotency-Key: sha256(encounter_no|reason_code|item_code)
 *
 * 幂等：客户端按幂等键缓存回执，重放沿用同一键；服务端亦按该键去重。
 * 失败：仅超时与 5xx 指数退避重试（≤3），4xx 直接标失败；仍失败返回显式失败结构，
 * 由业务层写「转办失败待重试」与错误码，不静默吞掉、不假装已提交。
 */

import { createHash } from 'node:crypto';

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { EvidenceRef, HandoffReceipt, HandoffRequest } from '../domain/contracts.ts';
import { requestJson, type HttpOptions } from './http.ts';

export function idempotencyKey(encounterNo: string, reasonCode: string, itemCode: string): string {
  return createHash('sha256')
    .update(`${encounterNo}|${reasonCode}|${itemCode}`)
    .digest('hex');
}

const TARGET_DEPTS = ['医保办', '财务科', '住院服务中心'] as const;
const EVIDENCE_TYPES = ['price_item', 'settlement_field', 'rule'] as const;

/** 缺字段在本地拦截并报错，不发出半截请求 */
export function validateHandoffRequest(request: HandoffRequest): void {
  const required: Array<keyof HandoffRequest> = [
    'consultationNo', 'encounterNo', 'targetDept', 'reasonCode', 'evidenceRefs', 'draftSummary', 'submittedBy',
  ];
  for (const key of required) {
    const value = request[key];
    if (value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0)) {
      throw new AppError(ErrorCode.PARSE_FAILED, { field: key, reason: '工单请求体缺字段，本地拦截' });
    }
  }
  if (!(TARGET_DEPTS as readonly string[]).includes(request.targetDept)) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'target_dept', value: request.targetDept });
  }
  for (const ref of request.evidenceRefs as EvidenceRef[]) {
    if (!(EVIDENCE_TYPES as readonly string[]).includes(ref.type)) {
      throw new AppError(ErrorCode.PARSE_FAILED, { field: 'evidence_refs[].type', value: ref.type });
    }
    if (!ref.code || !ref.label) {
      throw new AppError(ErrorCode.PARSE_FAILED, { field: 'evidence_refs[].code/label' });
    }
  }
}

export interface HandoffOutcome {
  ok: boolean;
  receipt?: HandoffReceipt;
  errorCode?: string;
  retries: number;
  idempotencyKey: string;
  lastResponseSummary?: string;
  /** 失败时业务层据此标「转办失败待重试」 */
  needsRetry: boolean;
}

interface HandoffRawResponse extends Record<string, unknown> {
  work_order_no?: string;
  workOrderNo?: string;
  accepted_at?: string;
  acceptedAt?: string;
}

export class WorkOrderAdapter {
  private readonly receipts = new Map<string, HandoffReceipt>();

  private readonly env: NodeJS.ProcessEnv;
  private readonly options: { maxRetries?: number; backoffMs?: number; transport?: HttpOptions };

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    options: { maxRetries?: number; backoffMs?: number; transport?: HttpOptions } = {},
  ) {
    this.env = env;
    this.options = options;
  }

  isConfigured(): boolean {
    return Boolean(this.env.WORKORDER_BASE_URL && this.env.WORKORDER_TOKEN);
  }

  keyFor(request: HandoffRequest): string {
    const itemCode = request.evidenceRefs[0]?.code ?? 'none';
    return idempotencyKey(request.encounterNo, request.reasonCode, itemCode);
  }

  /** 同幂等键重复提交只产生一张工单：客户端直接复用已缓存回执 */
  cached(key: string): HandoffReceipt | undefined {
    return this.receipts.get(key);
  }

  async submit(request: HandoffRequest): Promise<HandoffOutcome> {
    validateHandoffRequest(request);
    const key = this.keyFor(request);
    const cached = this.receipts.get(key);
    if (cached) {
      return { ok: true, receipt: cached, retries: 0, idempotencyKey: key, needsRetry: false };
    }
    if (!this.isConfigured()) {
      return {
        ok: false, errorCode: ErrorCode.CREDENTIALS_MISSING, retries: 0,
        idempotencyKey: key, needsRetry: true,
        lastResponseSummary: 'WORKORDER_BASE_URL / WORKORDER_TOKEN 未配置',
      };
    }

    const base = this.env.WORKORDER_BASE_URL!.replace(/\/$/, '');
    const url = `${base}/api/v1/consultations/${encodeURIComponent(request.consultationNo)}/handoff`;
    const body = {
      consultation_no: request.consultationNo,
      encounter_no: request.encounterNo,
      target_dept: request.targetDept,
      reason_code: request.reasonCode,
      evidence_refs: request.evidenceRefs.map((ref) => ({ type: ref.type, code: ref.code, label: ref.label })),
      draft_summary: request.draftSummary,
      submitted_by: request.submittedBy,
    };
    const maxRetries = Math.min(3, Math.max(0, this.options.maxRetries ?? 3));
    const backoffMs = this.options.backoffMs ?? 10;

    let lastErrorCode: string | undefined;
    let lastSummary: string | undefined;
    let retries = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const result = await requestJson<HandoffRawResponse>(url, {
          ...(this.options.transport ?? {}),
          method: 'POST',
          body,
          retries: 0,
          headers: {
            Authorization: `Bearer ${this.env.WORKORDER_TOKEN}`,
            'Idempotency-Key': key,
            ...(this.options.transport?.headers ?? {}),
          },
        });
        const workOrderNo = result.data.work_order_no ?? result.data.workOrderNo;
        const acceptedAt = result.data.accepted_at ?? result.data.acceptedAt;
        if (!workOrderNo) {
          // 回执缺 work_order_no 视为失败，不写状态（Task 39）
          return {
            ok: false, errorCode: ErrorCode.PARSE_FAILED, retries, idempotencyKey: key,
            needsRetry: true, lastResponseSummary: '回执缺 work_order_no',
          };
        }
        const receipt: HandoffReceipt = {
          workOrderNo,
          acceptedAt: acceptedAt ?? new Date().toISOString(),
        };
        this.receipts.set(key, receipt);
        return { ok: true, receipt, retries, idempotencyKey: key, needsRetry: false };
      } catch (err) {
        const error = err instanceof AppError ? err : new AppError(ErrorCode.PARSE_FAILED, { raw: String(err) });
        lastErrorCode = error.code;
        lastSummary = error.message;
        const retryable = error.code === ErrorCode.TIMEOUT || error.code === ErrorCode.HTTP_5XX;
        if (!retryable || attempt >= maxRetries) break;
        retries = attempt + 1;
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }

    return {
      ok: false, errorCode: lastErrorCode ?? ErrorCode.HTTP_5XX, retries,
      idempotencyKey: key, needsRetry: true, lastResponseSummary: lastSummary,
    };
  }
}
