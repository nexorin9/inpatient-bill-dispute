/**
 * 工作单元 D 段 / 确认外发 E 段 / 留痕 F 段回归
 * （Tasks 10 / 11 / 12 / 17 / 34 / 35 / 36 / 37 / 38 / 39 / 40 / 41 / 42 / 43）。
 * 全部使用 :memory: 台账，不触碰真实数据文件。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, ErrorCode } from '../src/core/domain/errors.ts';
import type { Citation, ExplanationPart } from '../src/core/domain/contracts.ts';
import { maskEncounterNo } from '../src/core/domain/mask.ts';
import { createRepositories, openStore } from '../src/db/index.ts';
import { loadConfig } from '../src/core/config.ts';
import { loadDictionaries, makeSnapshot } from '../src/core/dictionary/loader.ts';
import { loadSampleEncounter, loadSamplePriceBook } from '../src/core/adapters/samples.ts';

import { intake, nextConsultationNo, requestFingerprint } from '../src/core/workunit/intake.ts';
import { ConsultationStateService } from '../src/core/workunit/state-machine.ts';
import { QueueBindingService } from '../src/core/workunit/queue.ts';
import { CapacityAssignmentService } from '../src/core/workunit/assignment.ts';
import { runAttribution } from '../src/core/attribution/engine.ts';
import { ConfirmationGate } from '../src/core/dispatch/gate.ts';
import { renderPrintDraft, assertPrintSafe } from '../src/core/dispatch/print.ts';
import { HandoffService } from '../src/core/dispatch/handoff.ts';
import { WorkOrderAdapter } from '../src/core/adapters/workorder.ts';
import { ImAdapter } from '../src/core/adapters/im.ts';
import { buildSnapshotPayload } from '../src/core/rules/snapshot.ts';
import { FakeClock, SlaEscalationService } from '../src/core/audit/sla.ts';
import { LedgerService } from '../src/core/audit/ledger.ts';
import { CSV_HEADERS, assertExportSafe, exportAuditPackage, toCsv } from '../src/core/audit/export.ts';

const CONFIG = loadConfig({});
const BUNDLE = loadDictionaries();

function memory() {
  const store = openStore(':memory:');
  return { store, repos: createRepositories(store) };
}

function makeParts(): { parts: ExplanationPart[]; citations: Citation[] } {
  const citations: Citation[] = [{
    index: 1, type: 'price_item', code: 'ITEM001', label: '床位费', lineNumbers: [1],
  }];
  const parts: ExplanationPart[] = [{
    lineNumbers: [1], what: '床位费', why: '按本院价目口径结算', citationIndexes: [1],
    needsHuman: false, evidenceMissing: false, category: 'internal_check',
    protected: false, text: '2026-03-01 的一笔床位费，按本院价目口径结算（依据 [1]）',
  }];
  return { parts, citations };
}

/** 手工建一张已归因而未确认的咨询单，供闸门与外发链测试 */
function seedConsultation(repos: ReturnType<typeof createRepositories>, no: string, at: string) {
  const versions = makeSnapshot(loadSamplePriceBook().version, BUNDLE);
  const { parts, citations } = makeParts();
  const payload = buildSnapshotPayload(versions, {
    citations, parts, ruleHits: [{ ruleId: '§4-1', basisRef: '§4-1', severity: 'low', evidence: {} }],
    evidenceRefs: [{ type: 'price_item', code: 'ITEM001', label: '床位费' }],
    priceItemCodes: ['ITEM001'],
  });
  repos.snapshots.save(versions.snapshotRef, payload as unknown as Record<string, unknown>);
  repos.consultations.insert({
    consultationNo: no, channel: 'counter', encounterNo: 'ZY2026000001',
    encounterNoMasked: maskEncounterNo('ZY2026000001'), requestText: '床位费怎么算的',
    status: 'draft_pending_confirm', disputeCategory: 'internal_check', amount: 100,
    priceVersion: versions.priceVersion, dictionaryVersion: versions.dictionaryVersion,
    rulesVersion: versions.rulesVersion, snapshotRef: versions.snapshotRef,
    handoffFailed: false, createdAt: at, updatedAt: at,
  });
  return { versions, parts, citations };
}

test('多通道归一：三入口各建一条，指纹查重只提示不自动合并', () => {
  const { store, repos } = memory();
  const at = '2026-11-09T09:00:00.000Z';
  const first = intake({ channel: 'counter', encounterNo: 'ZY2026000001', requestText: '床位费怎么算的', operator: 'clerk-01', now: at }, repos);
  const second = intake({ channel: 'phone', encounterNo: 'ZY2026000002', requestText: 'CT 是不是收了两遍', operator: 'clerk-02', now: at }, repos);
  const third = intake({ channel: 'online', encounterNo: 'ZY2026000003', requestText: '化验费怎么这么贵', operator: 'clerk-03', now: at }, repos);
  assert.equal(repos.consultations.count(), 3);
  assert.deepEqual([first.channel, second.channel, third.channel], ['counter', 'phone', 'online']);
  assert.equal(nextConsultationNo(7, at), 'CS202611090007');
  assert.equal(requestFingerprint('ZY1', '多收了 3200'), requestFingerprint('ZY1', '多收了3200'));
  const duplicate = intake({ channel: 'counter', encounterNo: 'ZY2026000001', requestText: '床位费怎么算的', operator: 'clerk-01', now: at }, repos);
  assert.ok(duplicate.duplicateHint?.includes('疑似重复咨询'));
  assert.equal(repos.consultations.count(), 4, '查重只提示，仍独立建档');
  store.close();
});

test('六态状态机：合法跃迁放行，非法跃迁拒绝且状态不变，撤回仅限未确认态', () => {
  const { store, repos } = memory();
  const states = new ConsultationStateService(repos);
  seedConsultation(repos, 'CS-A', '2026-11-09T09:00:00.000Z');
  assert.throws(() => states.transition('CS-A', 'closed'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.ILLEGAL_TRANSITION);
  assert.equal(repos.consultations.find('CS-A')!.status, 'draft_pending_confirm');
  const answered = states.transition('CS-A', 'answered', { confirmedBy: 'clerk-01' });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.confirmedBy, 'clerk-01');
  assert.throws(() => states.withdraw('CS-A', 'clerk-01'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.ILLEGAL_TRANSITION);
  seedConsultation(repos, 'CS-B', '2026-11-09T09:00:00.000Z');
  const withdrawal = states.withdraw('CS-B', 'clerk-01');
  assert.equal(withdrawal.fromStatus, 'draft_pending_confirm');
  assert.equal(states.isWithdrawn('CS-B'), true);
  store.close();
});

test('队列绑定与容量派单：停用助手不触发模型，超容不派，重复派单只落一条', () => {
  const { store, repos } = memory();
  const queues = new QueueBindingService(repos);
  queues.ensureDefaults();
  assert.ok(repos.queues.list().length >= 3);
  const resolved = queues.resolve('needs_human');
  assert.ok(resolved.handoffDept.length > 0);
  assert.equal(queues.resolve('不存在的分类').warnings.length > 0, true);
  const key = resolved.binding.queueKey;
  queues.setEnabled(key, false);
  assert.equal(queues.resolve('needs_human').useModel, false);
  queues.setEnabled(key, true);

  const svc = new CapacityAssignmentService(repos);
  svc.configure([
    { agentKey: 'clerk-01', capacity: 1, onDuty: true, inHand: 0 },
    { agentKey: 'clerk-02', capacity: 1, onDuty: false, inHand: 0 },
  ]);
  const twice = svc.assignTwice({ consultationNo: 'CS-A' });
  assert.equal(twice.first.assigned, true);
  assert.equal(twice.second.assigned, false);
  assert.equal(twice.records, 1, '行级并发幂等：同键只落一条派单记录');
  const overflow = svc.assign({ consultationNo: 'CS-B' });
  assert.equal(overflow.assigned, false, '在岗坐席已达容量上限');
  assert.ok(overflow.reason.includes('capacity'));
  svc.setOnDuty('clerk-01', false);
  assert.equal(svc.assign({ consultationNo: 'CS-C' }).assigned, false);
  store.close();
});

test('归因主干端到端：无模型时出确定性基线草稿、留痕一轮、状态不推进', async () => {
  const { store, repos } = memory();
  const outcome = await runAttribution({
    consultationNo: 'CS-E2E-0001', encounterNo: 'ZY2026000003',
    requestText: '化验费怎么这么贵', operator: 'clerk-01',
    env: {}, repos, config: CONFIG, bundle: BUNDLE, dataSource: 'samples',
  });
  assert.equal(outcome.baselineMode, true);
  assert.equal(outcome.draftPendingHuman, false);
  assert.equal(outcome.result.degraded, false);
  assert.equal(outcome.result.dataSource, 'samples');
  assert.ok(outcome.result.citations.length > 0);
  // 零漏行：每行要么在解释稿、要么标依据缺失/拒答、要么显式标篇幅裁剪（依据仍留在留痕）
  const covered = new Set(outcome.result.parts.flatMap((p) => p.lineNumbers));
  const allLines = loadSampleEncounter('ZY2026000003')!.lines.map((l) => l.lineNo);
  for (const lineNo of allLines) {
    assert.ok(
      covered.has(lineNo) || (outcome.result.trimmedLineNumbers ?? []).includes(lineNo),
      `明细行 ${lineNo} 无解释也无显式标注，属静默漏行`,
    );
  }
  assert.equal(outcome.complianceOk, true);
  const record = repos.consultations.find('CS-E2E-0001')!;
  assert.equal(record.status, 'draft_pending_confirm');
  assert.equal(record.confirmedAt, undefined);
  assert.ok(record.snapshotRef?.startsWith('SNAP-'));
  assert.equal(repos.sessions.count('CS-E2E-0001'), 1);

  const ledger = new LedgerService(repos);
  const replay = ledger.replay('CS-E2E-0001', 'auditor-01');
  assert.equal(replay.sessionRoundsBefore, 1);
  assert.equal(replay.sessionRoundsAfter, 1, '重放不新增归因轮次');
  assert.equal(replay.modelCalls, 0);
  assert.deepEqual(replay.citations, outcome.result.citations);
  assert.ok(replay.explanationText.includes('原样重放'));
  assert.equal(repos.replayAudits.count('CS-E2E-0001'), 1);
  store.close();
});

test('确认闸门：未确认三条通道全拒；确认后放行；需人工判断即便确认也拒', () => {
  const { store, repos } = memory();
  const states = new ConsultationStateService(repos);
  const gate = new ConfirmationGate(repos, states);
  seedConsultation(repos, 'CS-GATE', '2026-11-09T09:00:00.000Z');
  for (const channel of ['print', 'workorder', 'im'] as const) {
    assert.throws(() => gate.assertAllowed('CS-GATE', channel),
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.CONFIRM_REQUIRED);
  }
  const confirmed = gate.confirm('CS-GATE', 'clerk-01', '2026-11-09T09:10:00.000Z');
  assert.equal(confirmed.confirmedBy, 'clerk-01');
  for (const channel of ['print', 'workorder', 'im'] as const) {
    assert.equal(gate.assertAllowed('CS-GATE', channel).allowed, true);
  }
  repos.consultations.update('CS-GATE', { disputeCategory: 'needs_human' });
  assert.throws(() => gate.assertAllowed('CS-GATE', 'print'),
    (err: unknown) => err instanceof AppError && err.message.includes('需人工判断'));
  store.close();
});

test('家属可读打印稿：需人工判断条目不进正文，内部字段名与身份信息一律拒发', () => {
  const { parts, citations } = makeParts();
  const draft = renderPrintDraft({
    consultationNo: 'CS-PRINT', encounterNoMasked: '****0001',
    parts: [...parts, {
      ...parts[0]!, lineNumbers: [2], needsHuman: true, text: '这笔需人工判断，不得外发',
    }],
    citations, category: 'internal_check', date: '2026-11-09', writeFile: false,
  });
  assert.equal(draft.filePath, undefined);
  assert.ok(!draft.body.includes('需人工判断，不得外发'));
  assert.ok(draft.body.includes('另有 1 笔需人工判断'));
  assert.equal(draft.citationSection.length, 1);
  assert.doesNotThrow(() => assertPrintSafe(draft.body));
  assert.throws(() => assertPrintSafe('字段 price_item_code 泄漏'), /内部字段名/);
  assert.throws(() => assertPrintSafe('姓名：张三'), /身份信息/);
});

test('转办工单：确认后提交，回执写回工单号与状态；IM 只推白名单字段', async () => {
  const { store, repos } = memory();
  const states = new ConsultationStateService(repos);
  const gate = new ConfirmationGate(repos, states);
  seedConsultation(repos, 'CS-HANDOFF', '2026-11-09T09:00:00.000Z');
  const env = {
    WORKORDER_BASE_URL: 'https://workorder.example.test', WORKORDER_TOKEN: 'tok',
    IM_WEBHOOK_URL: 'https://im.example.test/hook',
  };
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.push(String(init?.body ?? ''));
    if (String(url).includes('workorder')) {
      return new Response(JSON.stringify({ work_order_no: 'WO-2026-0002', accepted_at: '2026-11-09T10:00:00.000Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const service = new HandoffService(
    repos, gate, states,
    new WorkOrderAdapter(env, { maxRetries: 0, transport: { fetchImpl } }),
    new ImAdapter(env, { fetchImpl }),
  );
  const { citations } = makeParts();
  const input = {
    consultationNo: 'CS-HANDOFF', reasonCode: 'INSURANCE_ATTRIBUTE_DISPUTE',
    draftSummary: '费用口径解释稿', submittedBy: 'clerk-01',
    evidenceRefs: citations.map((c) => ({ type: c.type, code: c.code, label: c.label })),
  };
  await assert.rejects(service.submit(input),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.CONFIRM_REQUIRED);
  gate.confirm('CS-HANDOFF', 'clerk-01');
  const outcome = await service.submit({
    ...input,
    imFields: { priceItemCode: 'ITEM001', disputeCategory: 'internal_check', draftNo: 'DR-0001' },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.workOrderNo, 'WO-2026-0002');
  assert.equal(outcome.im?.ok, true);
  const record = repos.consultations.find('CS-HANDOFF')!;
  assert.equal(record.status, 'transferred');
  assert.equal(record.workOrderNo, 'WO-2026-0002');
  assert.equal(record.handoffFailed, false);
  const imBody = seen.find((s) => s.includes('费用咨询转办提醒')) ?? '';
  assert.ok(imBody.includes('咨询编号') && imBody.includes('收费项目编码'));
  assert.ok(!imBody.includes('金额') && !imBody.includes('姓名'));
  store.close();
});

test('超时升级与引用留痕导出：假时钟推进后升级，导出脱敏且字段齐备', () => {
  const { store, repos } = memory();
  seedConsultation(repos, 'CS-SLA', '2026-11-09T09:00:00.000Z');
  const clock = new FakeClock(new Date('2026-11-09T09:05:00.000Z'));
  const sla = new SlaEscalationService(repos, CONFIG, clock);
  assert.equal(sla.scan().escalated.length, 0);
  clock.advanceMinutes(CONFIG.slaMinutes.counter + 1);
  const first = sla.scan();
  assert.equal(first.escalated.length, 1);
  assert.equal(first.escalated[0]!.escalatedTo, '住院服务中心');
  assert.equal(sla.scan().escalated.length, 0, '同一 sla_key 不重复升级');
  assert.ok(sla.unansweredByAssignee().some((g) => g.items.some((i) => i.overdue)));

  const pkg = exportAuditPackage(repos, {}, { writeFile: false });
  assert.equal(pkg.rows.length, 1);
  assert.equal(pkg.meta.rowCount, 1);
  assert.ok(pkg.csv.startsWith('\uFEFF' + CSV_HEADERS.join(',')));
  assert.ok(toCsv([]).startsWith('\uFEFF' + CSV_HEADERS.join(',')));
  assert.equal(pkg.csv.split('\r\n').length, 3, '表头 + 1 行数据 + 末尾换行');
  assert.doesNotThrow(() => assertExportSafe(pkg.csv));
  assert.throws(() => assertExportSafe('姓名：张三'), /可识别信息|身份|脱敏/);
  assert.equal(pkg.rows[0]!.consultationNo, 'CS-SLA');
  assert.ok(pkg.rows[0]!.citationCount >= 0);
  store.close();
});
