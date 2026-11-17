/**
 * 解释稿 / 确认 / 打印 / 转办 CLI（Tasks 17 / 11 / 40 / 38 / 39）。
 */

import { loadSampleEncounters } from '../../core/adapters/samples.ts';
import { runAttribution } from '../../core/attribution/engine.ts';
import { writeDraftFiles } from '../../core/dispatch/draft.ts';
import { renderPrintDraft } from '../../core/dispatch/print.ts';
import { ConfirmationGate } from '../../core/dispatch/gate.ts';
import { ConsultationStateService } from '../../core/workunit/state-machine.ts';
import { WorkOrderAdapter } from '../../core/adapters/workorder.ts';
import { ImAdapter } from '../../core/adapters/im.ts';
import { HandoffService } from '../../core/dispatch/handoff.ts';
import { CATEGORY_LABELS } from '../../core/config.ts';
import type { CliContext } from '../context.ts';
import { parseArgs, strFlag } from '../context.ts';

function services(ctx: CliContext) {
  const states = new ConsultationStateService(ctx.repos);
  const gate = new ConfirmationGate(ctx.repos, states);
  return { states, gate };
}

export async function runExplain(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  const encounterNo = strFlag(flags, 'encounter', loadSampleEncounters()[0]!.encounterNo);
  const text = strFlag(flags, 'text', '上次多算了 3200');
  const consultationNo = strFlag(flags, 'consultation', `CS-EXPLAIN-${encounterNo.slice(-6)}`);
  const outcome = await runAttribution({
    consultationNo,
    encounterNo,
    requestText: text,
    channel: 'counter',
    operator: strFlag(flags, 'operator', 'cli'),
    config: ctx.config,
    env: ctx.env,
    repos: ctx.repos,
    bundle: ctx.bundle,
  });
  const files = writeDraftFiles(outcome.result, {
    label: outcome.draftPendingHuman ? '待人工撰写' : outcome.baselineMode ? '确定性基线草稿' : '模型归因草稿',
  });
  console.log('住院费用口径解释已生成');
  console.log(`  咨询编号：${consultationNo}`);
  console.log(`  住院号（掩码）：${outcome.result.encounterNoMasked}`);
  console.log(`  数据来源：${outcome.result.dataSource === 'his' ? 'HIS 真实接口 + 本院价目目录' : '本地脱敏样例（非真实院内数据）'}`);
  console.log(`  解释稿文件：${files.explanationPath}`);
  console.log(`  争议分类单：${files.classificationPath}`);
  console.log(`  引用条数：${files.citationCount}`);
  console.log(`  逐条覆盖明细行：${[...new Set(files.lineCoverage)].length} 行`);
  console.log(`  争议分类：${CATEGORY_LABELS[outcome.result.category] ?? outcome.result.category}`);
  console.log(`  质疑点：${outcome.result.questionPoints.length} ｜ 规则命中：${outcome.result.ruleHits.length} ｜ 勾稽命中：${outcome.result.reconciliationHits.length}`);
  console.log(`  模型通道：${outcome.baselineMode ? '确定性基线（模型未配置）' : outcome.draftPendingHuman ? `降级 ${outcome.degradation?.failureType ?? '模型不可达'}（草稿待人工撰写）` : outcome.result.modelMeta?.model}`);
  console.log(`  咨询单状态：草稿待确认（未经收费员确认，不得外发）`);
  console.log(`  归因留痕：第 ${outcome.sessionRound} 轮`);
  if (!outcome.complianceOk) {
    console.log(`  合规校验：命中 ${outcome.complianceViolations.length} 条禁语，本稿不可外发`);
  }
  // 引用条数必须 ≥ 1，否则视为无依据产物
  return files.citationCount >= 1 ? 0 : 1;
}

export async function runConfirm(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const consultationNo = positional[0] ?? strFlag(flags, 'consultation', '');
  if (!consultationNo) { console.error('用法：npm run cli -- confirm <咨询编号>'); return 2; }
  const { gate } = services(ctx);
  try {
    const record = gate.confirm(consultationNo, strFlag(flags, 'operator', 'cli'));
    console.log(`已确认：${consultationNo} ｜ 确认人 ${record.confirmedBy} ｜ 确认时间 ${record.confirmedAt}`);
    console.log('确认是唯一放行闸门；打印 / 转办 / IM 三条通道现在可放行（需人工判断条目仍被隔离）。');
    return 0;
  } catch (err) {
    console.error(`确认失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function runPrint(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const consultationNo = positional[0] ?? strFlag(flags, 'consultation', '');
  if (!consultationNo) { console.error('用法：npm run cli -- print <咨询编号>'); return 2; }
  const { gate } = services(ctx);
  const session = ctx.repos.sessions.latest(consultationNo);
  const record = ctx.repos.consultations.find(consultationNo);
  if (!session || !record) { console.error(`咨询单 ${consultationNo} 尚无归因结果，请先运行 explain`); return 1; }
  try {
    // 整单判「需人工判断」时闸门拒绝；条目级的需人工判断由打印稿正文过滤 + 页脚提示处理
    gate.assertAllowed(consultationNo, 'print', { category: record.disputeCategory });
  } catch (err) {
    console.error(`打印被确认闸门拒绝：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const snapshot = session.snapshot ?? {};
  const citations = (snapshot.citations ?? []) as Parameters<typeof renderPrintDraft>[0]['citations'];
  const parts = (snapshot.parts ?? []) as Parameters<typeof renderPrintDraft>[0]['parts'];
  const draft = renderPrintDraft({
    consultationNo,
    encounterNoMasked: record.encounterNoMasked,
    parts,
    citations,
    category: record.disputeCategory ?? 'internal_check',
  });
  console.log(`打印稿已生成：${draft.filePath}`);
  console.log(`抬头：${draft.title} ｜ 分类：${draft.categoryLabel} ｜ 依据：${draft.citationSection.length} 条`);
  return 0;
}

export async function runHandoff(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const consultationNo = positional[0] ?? strFlag(flags, 'consultation', '');
  if (!consultationNo) { console.error('用法：npm run cli -- handoff <咨询编号>'); return 2; }
  const record = ctx.repos.consultations.find(consultationNo);
  if (!record) { console.error(`咨询单不存在：${consultationNo}`); return 1; }
  const { states, gate } = services(ctx);
  const session = ctx.repos.sessions.latest(consultationNo);
  const service = new HandoffService(
    ctx.repos, gate, states,
    new WorkOrderAdapter(ctx.env, { maxRetries: ctx.config.workorderMaxRetries, backoffMs: ctx.config.workorderBackoffMs }),
    new ImAdapter(ctx.env),
  );
  const outcome = await service.submit({
    consultationNo,
    reasonCode: 'INSURANCE_ATTRIBUTE_DISPUTE',
    draftSummary: `咨询 ${consultationNo} 的费用口径解释稿（引用 ${session?.citations.length ?? 0} 条）`,
    submittedBy: strFlag(flags, 'operator', 'cli'),
    evidenceRefs: session?.citations ?? [],
  });
  if (!outcome.ok) {
    console.error(`转办失败待重试：${outcome.errorCode ?? 'unknown'}（${outcome.handoff.lastResponseSummary ?? ''}）`);
    console.error('咨询单已标「转办失败待重试」并写错误码，未假装已提交。');
    return 1;
  }
  console.log(`转办成功：工单号 ${outcome.workOrderNo} ｜ 状态 ${outcome.status} ｜ 幂等键 ${outcome.handoff.idempotencyKey.slice(0, 16)}…`);
  return 0;
}
