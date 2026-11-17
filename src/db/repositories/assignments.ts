/**
 * 派单 / 容量 / 队列绑定 / 超时升级仓储（Tasks 35–37、41）。
 *
 * 并发幂等的关键：assignments.idempotency_key 有唯一约束，配合 BEGIN IMMEDIATE 事务锁，
 * 两个进程同时抢同一条咨询时只会有一条记录落库（Task 37）。
 */

import type { Row, Store } from '../store.ts';

export interface AgentCapacity {
  agentKey: string;
  capacity: number;
  onDuty: boolean;
  inHand: number;
}

export interface QueueBinding {
  queueKey: string;
  disputeType: string;
  windowName: string;
  agentKey?: string;
  handoffDept: string;
  enabled: boolean;
  model?: string;
  promptKey?: string;
  conversationLimit: number;
}

interface CapacityRow extends Row {
  agent_key: string; capacity: number; on_duty: number; in_hand: number;
}
interface QueueRow extends Row {
  queue_key: string; dispute_type: string; window_name: string; agent_key: string | null;
  handoff_dept: string; enabled: number; model: string | null; prompt_key: string | null;
  conversation_limit: number;
}

export class AssignmentRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 事务锁内写入；命中唯一约束视为「已被他人派走」，返回 false */
  tryAssign(input: {
    consultationNo: string;
    agentKey: string;
    roundNo?: number;
    idempotencyKey: string;
    at?: string;
  }): boolean {
    return this.store.transaction(() => {
      const existing = this.store.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM assignments WHERE consultation_no = ?', [input.consultationNo],
      );
      if ((existing?.n ?? 0) > 0) return false;
      try {
        this.store.run(
          `INSERT INTO assignments (consultation_no, agent_key, round_no, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [input.consultationNo, input.agentKey, input.roundNo ?? 1,
            input.idempotencyKey, input.at ?? new Date().toISOString()],
        );
        this.store.run(
          'UPDATE consultations SET assigned_to = ?, updated_at = ? WHERE consultation_no = ?',
          [input.agentKey, input.at ?? new Date().toISOString(), input.consultationNo],
        );
        return true;
      } catch (err) {
        // 唯一约束冲突 = 另一进程先落库，丢弃本次结果（discard_already_applied_status_change 语义）
        if (String(err).includes('UNIQUE') || String(err).includes('constraint')) return false;
        throw err;
      }
    });
  }

  count(consultationNo?: string): number {
    const row = consultationNo
      ? this.store.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM assignments WHERE consultation_no = ?', [consultationNo])
      : this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM assignments');
    return row?.n ?? 0;
  }

  list(consultationNo: string): Array<{ agentKey: string; idempotencyKey: string; createdAt: string }> {
    return this.store.query<{ agent_key: string; idempotency_key: string; created_at: string }>(
      'SELECT agent_key, idempotency_key, created_at FROM assignments WHERE consultation_no = ?',
      [consultationNo],
    ).map((r) => ({ agentKey: r.agent_key, idempotencyKey: r.idempotency_key, createdAt: r.created_at }));
  }
}

export class CapacityRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  upsert(agent: AgentCapacity): void {
    this.store.run(
      `INSERT INTO agent_capacity (agent_key, capacity, on_duty, in_hand) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_key) DO UPDATE SET capacity = excluded.capacity,
         on_duty = excluded.on_duty, in_hand = excluded.in_hand`,
      [agent.agentKey, agent.capacity, agent.onDuty ? 1 : 0, agent.inHand],
    );
  }

  list(): AgentCapacity[] {
    return this.store.query<CapacityRow>('SELECT * FROM agent_capacity ORDER BY agent_key').map((r) => ({
      agentKey: r.agent_key, capacity: r.capacity, onDuty: r.on_duty === 1, inHand: r.in_hand,
    }));
  }

  get(agentKey: string): AgentCapacity | undefined {
    const r = this.store.get<CapacityRow>(
      'SELECT * FROM agent_capacity WHERE agent_key = ?', [agentKey],
    );
    return r ? { agentKey: r.agent_key, capacity: r.capacity, onDuty: r.on_duty === 1, inHand: r.in_hand } : undefined;
  }

  increment(agentKey: string): void {
    this.store.run('UPDATE agent_capacity SET in_hand = in_hand + 1 WHERE agent_key = ?', [agentKey]);
  }
}

export class QueueBindingRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  upsert(binding: QueueBinding): void {
    this.store.run(
      `INSERT INTO queue_bindings (queue_key, dispute_type, window_name, agent_key,
        handoff_dept, enabled, model, prompt_key, conversation_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(queue_key) DO UPDATE SET dispute_type = excluded.dispute_type,
         window_name = excluded.window_name, agent_key = excluded.agent_key,
         handoff_dept = excluded.handoff_dept, enabled = excluded.enabled,
         model = excluded.model, prompt_key = excluded.prompt_key,
         conversation_limit = excluded.conversation_limit`,
      [binding.queueKey, binding.disputeType, binding.windowName, binding.agentKey ?? null,
        binding.handoffDept, binding.enabled ? 1 : 0, binding.model ?? null,
        binding.promptKey ?? null, binding.conversationLimit],
    );
  }

  list(): QueueBinding[] {
    return this.store.query<QueueRow>('SELECT * FROM queue_bindings ORDER BY queue_key').map(toBinding);
  }

  get(queueKey: string): QueueBinding | undefined {
    const row = this.store.get<QueueRow>(
      'SELECT * FROM queue_bindings WHERE queue_key = ?', [queueKey],
    );
    return row ? toBinding(row) : undefined;
  }
}

function toBinding(r: QueueRow): QueueBinding {
  return {
    queueKey: r.queue_key, disputeType: r.dispute_type, windowName: r.window_name,
    agentKey: r.agent_key ?? undefined, handoffDept: r.handoff_dept, enabled: r.enabled === 1,
    model: r.model ?? undefined, promptKey: r.prompt_key ?? undefined,
    conversationLimit: r.conversation_limit,
  };
}

export interface SlaEscalationRecord {
  consultationNo: string;
  fromStatus: string;
  limitMinutes: number;
  escalatedTo: string;
  escalatedAt: string;
  slaKey: string;
}

export class SlaRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 同一咨询在同一时限内只升级一次 */
  tryEscalate(record: SlaEscalationRecord): boolean {
    const result = this.store.run(
      `INSERT OR IGNORE INTO sla_escalations
        (consultation_no, from_status, limit_minutes, escalated_to, escalated_at, sla_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [record.consultationNo, record.fromStatus, record.limitMinutes,
        record.escalatedTo, record.escalatedAt, record.slaKey],
    );
    if (result.changes === 0) return false;
    this.store.run(
      'UPDATE consultations SET escalated_at = ?, escalated_to = ?, sla_key = ? WHERE consultation_no = ?',
      [record.escalatedAt, record.escalatedTo, record.slaKey, record.consultationNo],
    );
    return true;
  }

  list(consultationNo?: string): SlaEscalationRecord[] {
    const rows = consultationNo
      ? this.store.query<{ consultation_no: string; from_status: string; limit_minutes: number;
          escalated_to: string; escalated_at: string; sla_key: string }>(
        'SELECT * FROM sla_escalations WHERE consultation_no = ? ORDER BY escalated_at', [consultationNo])
      : this.store.query<{ consultation_no: string; from_status: string; limit_minutes: number;
          escalated_to: string; escalated_at: string; sla_key: string }>(
        'SELECT * FROM sla_escalations ORDER BY escalated_at');
    return rows.map((r) => ({
      consultationNo: r.consultation_no, fromStatus: r.from_status,
      limitMinutes: r.limit_minutes, escalatedTo: r.escalated_to,
      escalatedAt: r.escalated_at, slaKey: r.sla_key,
    }));
  }
}

export class FingerprintRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  findRecent(fingerprint: string, sinceIso: string): string[] {
    return this.store.query<{ consultation_no: string }>(
      'SELECT consultation_no FROM conversation_fingerprints WHERE fingerprint = ? AND created_at >= ?',
      [fingerprint, sinceIso],
    ).map((r) => r.consultation_no);
  }

  record(fingerprint: string, consultationNo: string, at: string): void {
    this.store.run(
      'INSERT OR IGNORE INTO conversation_fingerprints (fingerprint, consultation_no, created_at) VALUES (?, ?, ?)',
      [fingerprint, consultationNo, at],
    );
  }
}
