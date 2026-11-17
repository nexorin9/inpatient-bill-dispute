/**
 * 本地脱敏样例装载 —— 无 HIS 凭据时归因入口显式走这里，并在产物中标注「数据来源：本地样例」。
 * 公开数据集派生结果只作验证数据层，不作为最终对接方式（真实端点见 his.ts / pricing.ts）。
 */

import { readFileSync } from 'node:fs';

import type { BillDetail, BillLine, PriceBook } from '../domain/types.ts';
import { parseBillLine, parsePayment } from './his.ts';
import { parsePriceItem } from './pricing.ts';

const SAMPLES = new URL('../../../samples/', import.meta.url);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, SAMPLES), 'utf8')) as T;
}

interface RawEncounter extends Record<string, unknown> {
  encounter_no: string;
  admission_date: string;
  discharge_date: string;
  lines: Array<Record<string, unknown>>;
  payment: Record<string, unknown>;
  reconciliation_expected?: boolean;
}

interface BillDetailsFile {
  source: string;
  license: string;
  generated_at: string;
  encounters: RawEncounter[];
}

export interface SampleEncounter extends BillDetail {
  reconciliationExpected: boolean;
}

export function loadSampleEncounters(): SampleEncounter[] {
  const file = readJson<BillDetailsFile>('bill-details.json');
  return file.encounters.map((raw) => {
    const lines: BillLine[] = raw.lines.map((line) => parseBillLine(line, raw.encounter_no));
    const outOfPeriodLineNumbers = lines
      .filter((line) => line.occurredAt < raw.admission_date || line.occurredAt > raw.discharge_date)
      .map((line) => line.lineNo);
    return {
      encounterNo: raw.encounter_no,
      patientName: '',
      idCardNo: '',
      bedNo: '',
      admissionDate: raw.admission_date,
      dischargeDate: raw.discharge_date,
      lines,
      payment: parsePayment(raw.payment),
      flags: { outOfPeriodLineNumbers, warnings: outOfPeriodLineNumbers.length > 0 ? ['存在费用日期越界明细'] : [] },
      candidateCount: 1,
      reconciliationExpected: raw.reconciliation_expected !== false,
    };
  });
}

export function loadSampleEncounter(encounterNo: string): SampleEncounter | undefined {
  return loadSampleEncounters().find((encounter) => encounter.encounterNo === encounterNo);
}

export function loadSamplePriceBook(): PriceBook {
  const file = readJson<{ version: string; items: Array<Record<string, unknown>> }>('price-items.json');
  return {
    version: file.version,
    items: file.items.map((item) => parsePriceItem(item, file.version)),
  };
}

export interface SampleTranscript {
  id: string;
  encounter_no: string;
  text: string;
  spoken_amount?: number;
  expected_line_numbers: number[];
  category: string;
}

export function loadSampleTranscripts(): SampleTranscript[] {
  return readJson<{ items: SampleTranscript[] }>('transcripts.json').items;
}

export interface SampleLabel {
  transcript_id: string;
  question_point: string;
  line_numbers: number[];
  category: string;
}

export function loadSampleLabels(): SampleLabel[] {
  return readJson<{ items: SampleLabel[] }>('attribution-labels.json').items;
}

export interface LedgerSeedConsultation {
  consultation_no: string;
  channel: 'counter' | 'phone' | 'online';
  encounter_no: string;
  request_text: string;
  status: string;
  amount: number;
  created_at: string;
}

export function loadLedgerSeed(): {
  consultations: LedgerSeedConsultation[];
  bill_lines: Record<string, Array<Record<string, unknown>>>;
} {
  return readJson('ledger-seed.json');
}

export interface QcCase {
  case_id: string;
  input: Record<string, unknown>;
  expect: { 通过: boolean; 校验: string; 原因: string };
  basis: string;
  confidence: string;
}

export function loadQcCases(): QcCase[] {
  return readJson<{ cases: QcCase[] }>('qc-cases.json').cases;
}
