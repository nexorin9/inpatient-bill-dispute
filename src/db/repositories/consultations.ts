/**
 * 咨询台账仓储 —— 唯一读写 consultations / bill_lines 的地方。
 * 业务层拿到的始终是领域类型，SQL 细节不外泄。
 */

import { maskEncounterNo } from '../../core/domain/mask.ts';
import type {
  BillLine,
  Consultation,
  ConsultationChannel,
  ConsultationStatus,
  DisputeCategory,
} from '../../core/domain/types.ts';
import type { Row, Store } from '../store.ts';

export interface ConsultationRecord extends Consultation {
  assignedTo?: string;
  priceVersion?: string;
  dictionaryVersion?: string;
  rulesVersion?: string;
  snapshotRef?: string;
  handoffFailed: boolean;
  escalatedAt?: string;
  escalatedTo?: string;
  slaKey?: string;
}

export interface LedgerFilter {
  status?: ConsultationStatus;
  channel?: ConsultationChannel;
  category?: DisputeCategory;
  assignedTo?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface ConsultationRow extends Row {
  consultation_no: string;
  channel: string;
  encounter_no: string;
  encounter_no_masked: string;
  request_text: string;
  status: string;
  dispute_category: string | null;
  amount: number;
  confirmed_at: string | null;
  confirmed_by: string | null;
  work_order_no: string | null;
  assigned_to: string | null;
  price_version: string | null;
  dictionary_version: string | null;
  rules_version: string | null;
  snapshot_ref: string | null;
  handoff_failed: number;
  escalated_at: string | null;
  escalated_to: string | null;
  sla_key: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToRecord(row: ConsultationRow): ConsultationRecord {
  return {
    consultationNo: row.consultation_no,
    channel: row.channel as ConsultationChannel,
    encounterNo: row.encounter_no,
    encounterNoMasked: row.encounter_no_masked,
    requestText: row.request_text,
    status: row.status as ConsultationStatus,
    disputeCategory: (row.dispute_category ?? undefined) as DisputeCategory | undefined,
    amount: row.amount,
    confirmedAt: row.confirmed_at ?? undefined,
    confirmedBy: row.confirmed_by ?? undefined,
    workOrderNo: row.work_order_no ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    priceVersion: row.price_version ?? undefined,
    dictionaryVersion: row.dictionary_version ?? undefined,
    rulesVersion: row.rules_version ?? undefined,
    snapshotRef: row.snapshot_ref ?? undefined,
    handoffFailed: row.handoff_failed === 1,
    escalatedAt: row.escalated_at ?? undefined,
    escalatedTo: row.escalated_to ?? undefined,
    slaKey: row.sla_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INSERT_SQL = `INSERT INTO consultations (
  consultation_no, channel, encounter_no, encounter_no_masked, request_text, status,
  dispute_category, amount, confirmed_at, confirmed_by, work_order_no, assigned_to,
  price_version, dictionary_version, rules_version, snapshot_ref, handoff_failed,
  escalated_at, escalated_to, sla_key, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class ConsultationRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  insert(record: ConsultationRecord): void {
    this.store.run(INSERT_SQL, [
      record.consultationNo, record.channel, record.encounterNo,
      record.encounterNoMasked || maskEncounterNo(record.encounterNo), record.requestText,
      record.status, record.disputeCategory ?? null, record.amount,
      record.confirmedAt ?? null, record.confirmedBy ?? null, record.workOrderNo ?? null,
      record.assignedTo ?? null, record.priceVersion ?? null, record.dictionaryVersion ?? null,
      record.rulesVersion ?? null, record.snapshotRef ?? null, record.handoffFailed ? 1 : 0,
      record.escalatedAt ?? null, record.escalatedTo ?? null, record.slaKey ?? null,
      record.createdAt, record.updatedAt,
    ]);
  }

  /** 按主键更新指定列（白名单，杜绝拼 SQL 注入） */
  update(consultationNo: string, patch: Partial<ConsultationRecord>, at?: string): void {
    const columns: Record<keyof ConsultationRecord, string> = {
      consultationNo: 'consultation_no', channel: 'channel', encounterNo: 'encounter_no',
      encounterNoMasked: 'encounter_no_masked', requestText: 'request_text', status: 'status',
      disputeCategory: 'dispute_category', amount: 'amount', confirmedAt: 'confirmed_at',
      confirmedBy: 'confirmed_by', workOrderNo: 'work_order_no', assignedTo: 'assigned_to',
      priceVersion: 'price_version', dictionaryVersion: 'dictionary_version',
      rulesVersion: 'rules_version', snapshotRef: 'snapshot_ref',
      handoffFailed: 'handoff_failed', escalatedAt: 'escalated_at', escalatedTo: 'escalated_to',
      slaKey: 'sla_key', createdAt: 'created_at', updatedAt: 'updated_at',
    };
    const entries = Object.entries(patch).filter(([key]) => key in columns) as Array<
      [keyof ConsultationRecord, unknown]
    >;
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
    const values = entries.map(([key, value]) => {
      if (key === 'handoffFailed') return value ? 1 : 0;
      return value === undefined ? null : value;
    });
    this.store.run(
      `UPDATE consultations SET ${sets}, updated_at = ? WHERE consultation_no = ?`,
      [...values, at ?? new Date().toISOString(), consultationNo],
    );
  }

  find(consultationNo: string): ConsultationRecord | undefined {
    const row = this.store.get<ConsultationRow>(
      'SELECT * FROM consultations WHERE consultation_no = ?', [consultationNo],
    );
    return row ? rowToRecord(row) : undefined;
  }

  list(filter: LedgerFilter = {}): ConsultationRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.channel) { where.push('channel = ?'); params.push(filter.channel); }
    if (filter.category) { where.push('dispute_category = ?'); params.push(filter.category); }
    if (filter.assignedTo) { where.push('assigned_to = ?'); params.push(filter.assignedTo); }
    if (filter.from) { where.push('created_at >= ?'); params.push(filter.from); }
    if (filter.to) { where.push('created_at <= ?'); params.push(filter.to); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.store.query<ConsultationRow>(
      `SELECT * FROM consultations ${clause} ORDER BY created_at DESC, consultation_no DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(rowToRecord);
  }

  count(filter: LedgerFilter = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.channel) { where.push('channel = ?'); params.push(filter.channel); }
    if (filter.from) { where.push('created_at >= ?'); params.push(filter.from); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM consultations ${clause}`, params,
    );
    return row?.n ?? 0;
  }

  /** 汇总条：今日咨询 / 未答复 / 已转办 / 高风险（界面顶部与托盘角标共用） */
  summary(today: string): { today: number; unanswered: number; transferred: number; highRisk: number } {
    const one = (sql: string, params: unknown[] = []): number =>
      this.store.get<{ n: number }>(sql, params)?.n ?? 0;
    return {
      today: one('SELECT COUNT(*) AS n FROM consultations WHERE substr(created_at, 1, 10) = ?', [today]),
      unanswered: one("SELECT COUNT(*) AS n FROM consultations WHERE status IN ('pending_reply','draft_pending_confirm')"),
      transferred: one("SELECT COUNT(*) AS n FROM consultations WHERE status = 'transferred'"),
      highRisk: one("SELECT COUNT(*) AS n FROM consultations WHERE dispute_category = 'to_insurance_office'"),
    };
  }
}

interface BillLineRow extends Row {
  line_no: number;
  price_item_code: string;
  item_name: string;
  amount: number;
  fee_category: string;
  fee_class: string;
  occurred_at: string;
  dept_code: string;
}

export class BillLineRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 一次咨询的明细整批替换（事务内完成） */
  replaceAll(consultationNo: string, lines: readonly BillLine[]): void {
    this.store.transaction(() => {
      this.store.run('DELETE FROM bill_lines WHERE consultation_no = ?', [consultationNo]);
      for (const line of lines) {
        this.store.run(
          `INSERT INTO bill_lines (consultation_no, line_no, price_item_code, item_name,
            amount, fee_category, fee_class, occurred_at, dept_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [consultationNo, line.lineNo, line.priceItemCode, line.itemName, line.amount,
            line.feeCategory, line.feeClass, line.occurredAt, line.deptCode],
        );
      }
    });
  }

  list(consultationNo: string): BillLine[] {
    return this.store.query<BillLineRow>(
      'SELECT * FROM bill_lines WHERE consultation_no = ? ORDER BY line_no', [consultationNo],
    ).map((row) => ({
      lineNo: row.line_no,
      priceItemCode: row.price_item_code,
      itemName: row.item_name,
      amount: row.amount,
      feeCategory: row.fee_category as BillLine['feeCategory'],
      feeClass: row.fee_class as BillLine['feeClass'],
      occurredAt: row.occurred_at,
      deptCode: row.dept_code,
    }));
  }

  count(consultationNo: string): number {
    return this.store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM bill_lines WHERE consultation_no = ?', [consultationNo],
    )?.n ?? 0;
  }
}
