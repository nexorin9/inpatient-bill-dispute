/**
 * 本地台账 DDL —— 仅主进程持有连接，业务层经窄 Store 接口访问。
 *
 * 三张主表：consultations / bill_lines / attribution_sessions（Task 2、12）；
 * 其余为派单、容量、队列、超时、快照与重放审计（Task 31/36/37/41/42）。
 * 所有涉及患者身份的字段一律只存掩码值（encounter_no_masked），完整住院号只留在本地台账。
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consultations (
  consultation_no       TEXT PRIMARY KEY,
  channel               TEXT NOT NULL,
  encounter_no          TEXT NOT NULL,
  encounter_no_masked   TEXT NOT NULL,
  request_text          TEXT NOT NULL,
  status                TEXT NOT NULL,
  dispute_category      TEXT,
  amount                REAL NOT NULL DEFAULT 0,
  confirmed_at          TEXT,
  confirmed_by          TEXT,
  work_order_no         TEXT,
  assigned_to           TEXT,
  price_version         TEXT,
  dictionary_version    TEXT,
  rules_version         TEXT,
  snapshot_ref          TEXT,
  handoff_failed        INTEGER NOT NULL DEFAULT 0,
  escalated_at          TEXT,
  escalated_to          TEXT,
  sla_key               TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consultations_status  ON consultations(status);
CREATE INDEX IF NOT EXISTS idx_consultations_created ON consultations(created_at);
CREATE INDEX IF NOT EXISTS idx_consultations_assigned ON consultations(assigned_to);

CREATE TABLE IF NOT EXISTS bill_lines (
  consultation_no  TEXT NOT NULL,
  line_no          INTEGER NOT NULL,
  price_item_code  TEXT NOT NULL,
  item_name        TEXT NOT NULL,
  amount           REAL NOT NULL,
  fee_category     TEXT NOT NULL,
  fee_class        TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  dept_code        TEXT NOT NULL,
  PRIMARY KEY (consultation_no, line_no)
);

CREATE TABLE IF NOT EXISTS attribution_sessions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_no       TEXT NOT NULL,
  round_no              INTEGER NOT NULL,
  citations_json        TEXT NOT NULL DEFAULT '[]',
  model                 TEXT,
  model_version         TEXT,
  endpoint_domain       TEXT,
  tokens                INTEGER,
  latency_ms            INTEGER,
  retries               INTEGER NOT NULL DEFAULT 0,
  schema_valid          INTEGER NOT NULL DEFAULT 1,
  guardrail_hits_json   TEXT NOT NULL DEFAULT '[]',
  operator              TEXT NOT NULL DEFAULT '',
  masked_encounter_no   TEXT NOT NULL DEFAULT '',
  degraded              INTEGER NOT NULL DEFAULT 0,
  failure_type          TEXT,
  context_summary       TEXT NOT NULL DEFAULT '',
  snapshot_json         TEXT NOT NULL DEFAULT '{}',
  rejections_json       TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  UNIQUE (consultation_no, round_no)
);
CREATE INDEX IF NOT EXISTS idx_sessions_consultation ON attribution_sessions(consultation_no);

CREATE TABLE IF NOT EXISTS assignments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_no  TEXT NOT NULL,
  agent_key        TEXT NOT NULL,
  round_no         INTEGER NOT NULL DEFAULT 1,
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_consultation ON assignments(consultation_no);

CREATE TABLE IF NOT EXISTS agent_capacity (
  agent_key  TEXT PRIMARY KEY,
  capacity   INTEGER NOT NULL,
  on_duty    INTEGER NOT NULL DEFAULT 1,
  in_hand    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS queue_bindings (
  queue_key             TEXT PRIMARY KEY,
  dispute_type          TEXT NOT NULL,
  window_name           TEXT NOT NULL,
  agent_key             TEXT,
  handoff_dept          TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  model                 TEXT,
  prompt_key            TEXT,
  conversation_limit    INTEGER NOT NULL DEFAULT 20
);

CREATE TABLE IF NOT EXISTS sla_escalations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_no   TEXT NOT NULL,
  from_status       TEXT NOT NULL,
  limit_minutes     INTEGER NOT NULL,
  escalated_to      TEXT NOT NULL,
  escalated_at      TEXT NOT NULL,
  sla_key           TEXT NOT NULL,
  UNIQUE (consultation_no, sla_key)
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_ref   TEXT PRIMARY KEY,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_audits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_no   TEXT NOT NULL,
  operator          TEXT NOT NULL,
  replayed_at       TEXT NOT NULL,
  citation_count    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_fingerprints (
  fingerprint      TEXT NOT NULL,
  consultation_no  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (fingerprint, consultation_no)
);
`;

/** DDL 中登记的主表，供自检断言 */
export const CORE_TABLES = [
  'consultations',
  'bill_lines',
  'attribution_sessions',
  'assignments',
  'agent_capacity',
  'queue_bindings',
  'sla_escalations',
  'snapshots',
  'replay_audits',
] as const;
