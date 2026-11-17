/**
 * 登记 / 派单 CLI（Tasks 10 / 36 / 37）。
 */

import { intake } from '../../core/workunit/intake.ts';
import { CapacityAssignmentService } from '../../core/workunit/assignment.ts';
import { QueueBindingService } from '../../core/workunit/queue.ts';
import type { CliContext } from '../context.ts';
import { parseArgs, strFlag } from '../context.ts';

const DEFAULT_AGENTS = [
  { agentKey: 'clerk-01', capacity: 5, onDuty: true, inHand: 0 },
  { agentKey: 'clerk-02', capacity: 5, onDuty: true, inHand: 0 },
  { agentKey: 'clerk-03', capacity: 4, onDuty: true, inHand: 0 },
];

export async function runIntake(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  const channel = strFlag(flags, 'channel', 'counter') as 'counter' | 'phone' | 'online';
  const encounterNo = strFlag(flags, 'encounter', 'ZY2026000001');
  const text = strFlag(flags, 'text', '上次多算了 3200');
  const outcome = intake({
    channel, encounterNo, requestText: text,
    operator: strFlag(flags, 'operator', 'cli'),
  }, ctx.repos);
  console.log(`咨询单已登记：${outcome.consultationNo} ｜ 渠道 ${outcome.channel} ｜ 状态 ${outcome.statusLabel}`);
  if (outcome.duplicateHint) console.log(`提示：${outcome.duplicateHint}`);
  return 0;
}

export async function runAssign(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const consultationNo = positional[0] ?? strFlag(flags, 'consultation', '');
  if (!consultationNo) { console.error('用法：npm run cli -- assign <咨询编号>'); return 2; }
  const queues = new QueueBindingService(ctx.repos);
  queues.ensureDefaults();
  const service = new CapacityAssignmentService(ctx.repos);
  if (ctx.repos.capacity.list().length === 0) service.configure(DEFAULT_AGENTS);
  const outcome = service.assign({ consultationNo, queueKey: strFlag(flags, 'queue', 'Q-DEFAULT') });
  console.log(`派单：${outcome.assigned ? '成功' : '未派出'} ｜ ${outcome.reason}`);
  if (outcome.idempotencyKey) console.log(`  幂等键：${outcome.idempotencyKey}`);
  console.log(`  该咨询派单记录数：${ctx.repos.assignments.count(consultationNo)}`);
  return outcome.assigned ? 0 : 1;
}
