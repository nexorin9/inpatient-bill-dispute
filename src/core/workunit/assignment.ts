/**
 * 容量派单与行级并发幂等（Tasks 36 / 37）。
 *
 * 每名在岗人员有 capacity，每个队列有 conversation_limit；派单按轮询在在岗人员之间取件
 * （当前在手量从低到高，同量按轮询指针轮转），超容不再派。
 * 派单在事务锁下写入并带幂等键；两个派单进程并发抢同一条咨询时只产生一条派单记录。
 */

import type { Repositories, AgentCapacity } from '../../db/index.ts';

export interface AssignmentRequest {
  consultationNo: string;
  queueKey?: string;
  roundNo?: number;
  at?: string;
}

export interface AssignmentOutcome {
  assigned: boolean;
  agentKey?: string;
  idempotencyKey?: string;
  reason: string;
}

export class CapacityAssignmentService {
  private pointer = 0;

  private readonly repos: Repositories;

  constructor(repos: Repositories) {
    this.repos = repos;
  }

  /** 可配置容量与队列上限 */
  configure(agents: readonly AgentCapacity[], bindings?: Array<{ queueKey: string; conversationLimit: number }>): void {
    for (const agent of agents) this.repos.capacity.upsert(agent);
    for (const item of bindings ?? []) {
      const binding = this.repos.queues.get(item.queueKey);
      if (binding) this.repos.queues.upsert({ ...binding, conversationLimit: item.conversationLimit });
    }
  }

  /** 队列待办上限判定 */
  private withinQueueLimit(queueKey: string): boolean {
    const binding = this.repos.queues.get(queueKey);
    if (!binding) return true;
    const pending = this.repos.consultations.list({ limit: 1000 })
      .filter((c) => c.status === 'pending_reply' || c.status === 'draft_pending_confirm').length;
    return pending < binding.conversationLimit;
  }

  /** 轮询取件：在手量低者优先，同量按指针轮转，保证不长期偏向同一人 */
  private pickAgent(): AgentCapacity | undefined {
    const onDuty = this.repos.capacity.list()
      .filter((agent) => agent.onDuty && agent.inHand < agent.capacity)
      .sort((a, b) => a.inHand - b.inHand || a.agentKey.localeCompare(b.agentKey));
    if (onDuty.length === 0) return undefined;
    const index = this.pointer % onDuty.length;
    this.pointer = (this.pointer + 1) % Math.max(1, onDuty.length);
    return onDuty[index];
  }

  assign(request: AssignmentRequest): AssignmentOutcome {
    const queueKey = request.queueKey ?? 'Q-DEFAULT';
    if (!this.withinQueueLimit(queueKey)) {
      return { assigned: false, reason: `队列 ${queueKey} 待办已达 conversation_limit，不再派单` };
    }
    const agent = this.pickAgent();
    if (!agent) {
      return { assigned: false, reason: '所有在岗坐席已达 capacity 上限（或均不在岗），不再派单' };
    }
    const roundNo = request.roundNo ?? 1;
    const idempotencyKey = `${request.consultationNo}|${agent.agentKey}|${roundNo}`;
    const ok = this.repos.assignments.tryAssign({
      consultationNo: request.consultationNo,
      agentKey: agent.agentKey,
      roundNo,
      idempotencyKey,
      ...(request.at ? { at: request.at } : {}),
    });
    if (!ok) {
      return {
        assigned: false,
        idempotencyKey,
        reason: '该咨询已被其他派单进程抢先落库，丢弃本次结果（行级并发幂等）',
      };
    }
    this.repos.capacity.increment(agent.agentKey);
    return {
      assigned: true,
      agentKey: agent.agentKey,
      idempotencyKey,
      reason: `已派给 ${agent.agentKey}（当前在手 ${agent.inHand + 1}/${agent.capacity}）`,
    };
  }

  /** 重复派单幂等：同一幂等键连续派两次不产生第二条记录 */
  assignTwice(request: AssignmentRequest): { first: AssignmentOutcome; second: AssignmentOutcome; records: number } {
    const first = this.assign(request);
    const second = this.assign(request);
    return { first, second, records: this.repos.assignments.count(request.consultationNo) };
  }

  /** 在岗切换：不在岗时其在手咨询不被自动转派，转派走人工确认 */
  setOnDuty(agentKey: string, onDuty: boolean): void {
    const agent = this.repos.capacity.get(agentKey);
    if (!agent) throw new Error(`坐席不存在：${agentKey}`);
    this.repos.capacity.upsert({ ...agent, onDuty });
  }
}
