/**
 * HIS 住院费用明细入站适配器（真实端点）。
 *
 * GET {HIS_BASE_URL}/api/v1/inpatient-bills/{encounter_no}/details
 * Authorization: Bearer $HIS_API_TOKEN
 *
 * 凭据一律从环境变量读；缺凭据报错且不静默降级到本地文件（本地样例由归因入口在无凭据时显式选择，
 * 并在产物中标注数据来源）。字段规范在此校验：金额非负、行号唯一、枚举合法、
 * occurred_at 越界不丢弃而标记，三重绑定缺一即拒绝归因。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { BillDetail, BillLine, FeeCategory, PaymentBreakdown } from '../domain/types.ts';
import { requestJson, type HttpOptions } from './http.ts';

const FEE_CATEGORIES: readonly FeeCategory[] = ['甲类', '乙类', '自费', '其他'];
const FEE_CLASSES = [
  '床位费', '诊察费', '检查费', '化验费', '治疗费', '手术费', '护理费', '卫生材料费',
  '西药费', '中药饮片费', '中成药费', '一般诊疗费', '挂号费', '其他',
] as const;

type RawLine = Record<string, unknown>;

function str(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number') return String(value);
  throw new AppError(ErrorCode.PARSE_FAILED, { field, reason: '缺字段或类型不符' });
}

function num(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field, reason: '金额不是有限数' });
  }
  return parsed;
}

/** 三重绑定：住院号 + 明细行号 + 收费项目编码，缺一即拒绝归因 */
export function assertTripleBinding(encounterNo: string, line: Partial<BillLine>): void {
  if (!encounterNo || line.lineNo === undefined || line.lineNo === null || !line.priceItemCode) {
    throw new AppError(ErrorCode.BINDING_INCOMPLETE, {
      encounterNoPresent: Boolean(encounterNo),
      lineNoPresent: line.lineNo !== undefined && line.lineNo !== null,
      priceItemCodePresent: Boolean(line.priceItemCode),
    });
  }
}

export function parseBillLine(raw: RawLine, encounterNo: string): BillLine {
  const lineNo = num(raw.line_no ?? raw.lineNo, 'line_no');
  const priceItemCode = str(raw.price_item_code ?? raw.priceItemCode, 'price_item_code');
  const itemName = str(raw.item_name ?? raw.itemName, 'item_name');
  assertTripleBinding(encounterNo, { lineNo, priceItemCode });

  const amount = num(raw.amount, 'amount');
  if (amount < 0) throw new AppError(ErrorCode.PARSE_FAILED, { field: 'amount', reason: '金额非负校验失败' });

  const feeCategory = str(raw.fee_category ?? raw.feeCategory, 'fee_category') as FeeCategory;
  if (!FEE_CATEGORIES.includes(feeCategory)) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'fee_category', value: feeCategory, reason: '枚举外取值' });
  }
  const feeClass = str(raw.fee_class ?? raw.feeClass, 'fee_class') as BillLine['feeClass'];
  if (!(FEE_CLASSES as readonly string[]).includes(feeClass)) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'fee_class', value: feeClass, reason: '枚举外取值' });
  }
  return {
    lineNo, priceItemCode, itemName, amount, feeCategory, feeClass,
    occurredAt: str(raw.occurred_at ?? raw.occurredAt, 'occurred_at'),
    deptCode: str(raw.dept_code ?? raw.deptCode, 'dept_code'),
  };
}

export function parsePayment(raw: Record<string, unknown> | undefined): PaymentBreakdown {
  if (!raw) throw new AppError(ErrorCode.PARSE_FAILED, { field: 'payment', reason: '缺支付口径' });
  const get = (snake: string, camel: string): number => num(raw[snake] ?? raw[camel], snake);
  return {
    totalAmount: get('total_amount', 'totalAmount'),
    insuredFundPaid: get('insured_fund_paid', 'insuredFundPaid'),
    supplementaryPaid: get('supplementary_paid', 'supplementaryPaid'),
    medicalAidPaid: get('medical_aid_paid', 'medicalAidPaid'),
    personalBurden: get('personal_burden', 'personalBurden'),
    otherPaid: get('other_paid', 'otherPaid'),
    personalPaid: get('personal_paid', 'personalPaid'),
  };
}

export interface HisRawResponse extends Record<string, unknown> {
  encounter_no?: string;
  admission_date?: string;
  discharge_date?: string;
  lines?: RawLine[];
  payment?: Record<string, unknown>;
  /** 住院号命中多条住院记录时上游返回候选数组 */
  encounters?: Array<Record<string, unknown>>;
  matches?: Array<Record<string, unknown>>;
}

/** 把 HIS 原始响应解析为内部 BillDetail（字段规范校验集中在这里） */
export function parseHisResponse(raw: HisRawResponse, requestedEncounterNo: string): BillDetail {
  const candidates = raw.encounters ?? raw.matches;
  if (Array.isArray(candidates) && candidates.length > 1) {
    throw new AppError(ErrorCode.AMBIGUOUS, {
      encounterNo: requestedEncounterNo,
      candidateCount: candidates.length,
      reason: '住院号命中多条住院记录，需人工选定，禁止自动挑一条',
    });
  }
  const source = candidates && candidates.length === 1 ? candidates[0]! : raw;
  const encounterNo = str(source.encounter_no ?? source.encounterNo ?? requestedEncounterNo, 'encounter_no');
  const admissionDate = str(source.admission_date ?? source.admissionDate, 'admission_date');
  const dischargeDate = str(source.discharge_date ?? source.dischargeDate, 'discharge_date');
  const rawLines = (source.lines ?? raw.lines) as RawLine[] | undefined;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'lines', reason: '明细为空' });
  }

  const lines = rawLines.map((line) => parseBillLine(line, encounterNo));
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.lineNo)) {
      throw new AppError(ErrorCode.PARSE_FAILED, { field: 'line_no', value: line.lineNo, reason: '行号不唯一' });
    }
    seen.add(line.lineNo);
  }

  const outOfPeriodLineNumbers = lines
    .filter((line) => line.occurredAt < admissionDate || line.occurredAt > dischargeDate)
    .map((line) => line.lineNo);

  return {
    encounterNo,
    patientName: String(source.patient_name ?? source.patientName ?? ''),
    idCardNo: String(source.id_card_no ?? source.idCardNo ?? ''),
    bedNo: String(source.bed_no ?? source.bedNo ?? ''),
    admissionDate,
    dischargeDate,
    lines,
    payment: parsePayment((source.payment ?? raw.payment) as Record<string, unknown> | undefined),
    flags: {
      outOfPeriodLineNumbers,
      warnings: outOfPeriodLineNumbers.length > 0
        ? [`${outOfPeriodLineNumbers.length} 行费用日期越出住院期间，已标记供规则层判定`]
        : [],
    },
    candidateCount: candidates?.length ?? 1,
  };
}

export class HisBillingAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: HttpOptions;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    transport: HttpOptions = {},
  ) {
    this.env = env;
    this.transport = transport;
  }

  /** 端点与凭据是否齐备（doctor 用，不回显取值） */
  isConfigured(): boolean {
    return Boolean(this.env.HIS_BASE_URL && this.env.HIS_API_TOKEN);
  }

  async fetchDetails(encounterNo: string): Promise<BillDetail> {
    if (!this.isConfigured()) {
      throw new AppError(ErrorCode.CREDENTIALS_MISSING, {
        missing: ['HIS_BASE_URL', 'HIS_API_TOKEN'].filter((k) => !this.env[k]),
        purpose: 'HIS 住院费用明细',
      });
    }
    const base = this.env.HIS_BASE_URL!.replace(/\/$/, '');
    const url = `${base}/api/v1/inpatient-bills/${encodeURIComponent(encounterNo)}/details`;
    const result = await requestJson<HisRawResponse>(url, {
      ...this.transport,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.env.HIS_API_TOKEN}`, ...(this.transport.headers ?? {}) },
    });
    return parseHisResponse(result.data, encounterNo);
  }
}
