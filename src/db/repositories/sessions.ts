/**
 * 归因留痕仓储 —— 每轮归因留一行 session（Task 12），
 * 同时承载版本快照（Task 31）、重放审计（Task 42）与拒答留痕（Task 23）。
 */

import type { EvidenceRef } from '../../core/domain/types.ts';
import type { Row, Store } from '../store.ts';

export interface AttributionSessionInput {
  consultationNo: string;
  citations: EvidenceRef[];
  model?: string;
  modelVersion?: string;
  endpointDomain?: string;
  tokens?: number;
  latencyMs?: number;
  retries?: number;
  schemaValid?: boolean;
  guardrailHits?: string[];
  operator?: string;
  maskedEncounterNo: string;
  degraded?: boolean;
  failureType?: string;
  contextSummary?: string;
  snapshot?: Record<string, unknown>;
  rejections?: Array<Record<string, unknown>>;
  createdAt?: string;
}

export interface AttributionSessionRecord extends AttributionSessionInput {
  id: number;
  roundNo: number;
  createdAt: string;
}

interface SessionRow extends Row {
  id: number;
  consultation_no: string;
  round_no: number;
  citations_json: string;
  model: string | null;
  model_version: string | null;
  endpoint_domain: string | null;
  tokens: number | null;
  latency_ms: number | null;
  retries: number;
  schema_valid: number;
  guardrail_hits_json: string;
  operator: string;
  masked_encounter_no: string;
  degraded: number;
  failure_type: string | null;
  context_summary: string;
  snapshot_json: string;
  rejections_json: string;
  created_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function rowToSession(row: SessionRow): AttributionSessionRecord {
  return {
    id: row.id,
    roundNo: row.round_no,
    consultationNo: row.consultation_no,
    citations: parseJson<EvidenceRef[]>(row.citations_json, []),
    model: row.model ?? undefined,
    modelVersion: row.model_version ?? undefined,
    endpointDomain: row.endpoint_domain ?? undefined,
    tokens: row.tokens ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    retries: row.retries,
    schemaValid: row.schema_valid === 1,
    guardrailHits: parseJson<string[]>(row.guardrail_hits_json, []),
    operator: row.operator,
    maskedEncounterNo: row.masked_encounter_no,
    degraded: row.degraded === 1,
    failureType: row.failure_type ?? undefined,
    contextSummary: row.context_summary,
    snapshot: parseJson<Record<string, unknown>>(row.snapshot_json, {}),
    rejections: parseJson<Array<Record<string, unknown>>>(row.rejections_json, []),
    createdAt: row.created_at,
  };
}

/** 身份信息红线：留痕里不得出现证件号 / 床号 / 姓名 / 电话原值 */
const SENSITIVE_PATTERNS = [
  /\b\d{17}[\dXx]\b/, // 身份证
  /\b1[3-9]\d{9}\b/, // 手机号
  /(姓名|床号|身份证号|联系电话)\s*[:：]\s*[^\s,，。;；]{2,}/,
];

export function containsSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export class AttributionSessionRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 追加一轮；轮次由库内 max(round_no)+1 决定，同一咨询多次归因逐次各一行 */
  append(input: AttributionSessionInput): AttributionSessionRecord {
    const serialized = JSON.stringify({
      citations: input.citations,
      contextSummary: input.contextSummary ?? '',
      snapshot: input.snapshot ?? {},
      rejections: input.rejections ?? [],
    });
    if (containsSensitive(serialized)) {
      throw new Error('归因留痕含患者可识别信息，写入被拒绝');
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const row = this.store.transaction(() => {
      const current = this.store.get<{ n: number }>(
        'SELECT COALESCE(MAX(round_no), 0) AS n FROM attribution_sessions WHERE consultation_no = ?',
        [input.consultationNo],
      );
      const roundNo = (current?.n ?? 0) + 1;
      this.store.run(
        `INSERT INTO attribution_sessions (
          consultation_no, round_no, citations_json, model, model_version, endpoint_domain,
          tokens, latency_ms, retries, schema_valid, guardrail_hits_json, operator,
          masked_encounter_no, degraded, failure_type, context_summary, snapshot_json,
          rejections_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.consultationNo, roundNo, JSON.stringify(input.citations),
          input.model ?? null, input.modelVersion ?? null, input.endpointDomain ?? null,
          input.tokens ?? null, input.latencyMs ?? null, input.retries ?? 0,
          input.schemaValid === false ? 0 : 1, JSON.stringify(input.guardrailHits ?? []),
          input.operator ?? '', input.maskedEncounterNo, input.degraded ? 1 : 0,
          input.failureType ?? null, input.contextSummary ?? '',
          JSON.stringify(input.snapshot ?? {}), JSON.stringify(input.rejections ?? []), createdAt],
      );
      return this.store.get<SessionRow>(
        'SELECT * FROM attribution_sessions WHERE consultation_no = ? AND round_no = ?',
        [input.consultationNo, roundNo],
      );
    });
    if (!row) throw new Error('归因留痕写入失败');
    return rowToSession(row);
  }

  list(consultationNo: string): AttributionSessionRecord[] {
    return this.store.query<SessionRow>(
      'SELECT * FROM attribution_sessions WHERE consultation_no = ? ORDER BY round_no',
      [consultationNo],
    ).map(rowToSession);
  }

  latest(consultationNo: string): AttributionSessionRecord | undefined {
    const row = this.store.get<SessionRow>(
      'SELECT * FROM attribution_sessions WHERE consultation_no = ? ORDER BY round_no DESC LIMIT 1',
      [consultationNo],
    );
    return row ? rowToSession(row) : undefined;
  }

  count(consultationNo?: string): number {
    const row = consultationNo
      ? this.store.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM attribution_sessions WHERE consultation_no = ?', [consultationNo])
      : this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM attribution_sessions');
    return row?.n ?? 0;
  }
}

/** 版本快照：解释稿依据指向快照中的具体版本，不在渲染时回查当前字典 */
export class SnapshotRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  save(snapshotRef: string, payload: Record<string, unknown>): void {
    this.store.run(
      'INSERT OR REPLACE INTO snapshots (snapshot_ref, payload_json, created_at) VALUES (?, ?, ?)',
      [snapshotRef, JSON.stringify(payload), new Date().toISOString()],
    );
  }

  load(snapshotRef: string): Record<string, unknown> | undefined {
    const row = this.store.get<{ payload_json: string }>(
      'SELECT payload_json FROM snapshots WHERE snapshot_ref = ?', [snapshotRef],
    );
    return row ? parseJson<Record<string, unknown>>(row.payload_json, {}) : undefined;
  }
}

export class ReplayAuditRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  record(consultationNo: string, operator: string, citationCount: number): void {
    this.store.run(
      'INSERT INTO replay_audits (consultation_no, operator, replayed_at, citation_count) VALUES (?, ?, ?, ?)',
      [consultationNo, operator, new Date().toISOString(), citationCount],
    );
  }

  count(consultationNo: string): number {
    return this.store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM replay_audits WHERE consultation_no = ?', [consultationNo],
    )?.n ?? 0;
  }
}
