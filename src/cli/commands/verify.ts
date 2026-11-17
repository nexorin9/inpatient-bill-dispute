/**
 * 验收类 CLI：官方用例跑批 / 对照基准 / 规模验收 / 超时扫描（Tasks 32 / 33 / 27 / 41）。
 */

import { loadQcCases } from '../../core/adapters/samples.ts';
import { runQcCases, summarizeQc, type QcCheckName } from '../../core/rules/qc-cases.ts';
import { runBenchmark, assertReproducible } from '../../core/attribution/benchmark.ts';
import { assertScaleInvariants, runScaleAcceptance } from '../../core/attribution/batch.ts';
import { FakeClock, SlaEscalationService } from '../../core/audit/sla.ts';
import type { CliContext } from '../context.ts';
import { parseArgs, strFlag } from '../context.ts';

export async function runCases(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  const breakCheck = strFlag(flags, 'break') as QcCheckName | '';
  const cases = loadQcCases();
  const results = runQcCases(cases, breakCheck ? { breakCheck } : {});
  const summary = summarizeQc(results);
  console.log('官方结算清单质控用例对照（8 条）');
  console.log('用例编号\t校验项\t命中\t期望通过\t结论\t依据出处');
  for (const result of results) {
    const qcCase = cases.find((c) => c.case_id === result.caseId);
    console.log([
      result.caseId, result.check, result.hit ? '是' : '否',
      qcCase?.expect.通过 ? '是' : '否',
      result.passed ? '通过' : '失败', result.basisRef,
    ].join('\t'));
  }
  console.log(`结论：${summary.passed}/${summary.total} 通过`);
  if (summary.failed.length > 0) {
    console.error(`失败用例编号：${summary.failed.join(', ')}`);
    return 1;
  }
  console.log('8/8 全命中（含 qc-005 / qc-008 两条应通过用例未误报）。');
  return 0;
}

export async function runBenchAttribution(argv: readonly string[], ctx: CliContext): Promise<number> {
  void argv; void ctx;
  const report = runBenchmark();
  // 可复现性：再跑一次，指标（除耗时外）必须一致
  const second = runBenchmark({ writeReport: false });
  assertReproducible(report, second);
  console.log('对照基准：有模型路径 vs 纯规则基线');
  console.log(`  ${report._meta.model_path_note}`);
  console.log(`  样本量：${report.model_path.sampleSize} 条标注（reports/attribution-labels-snapshot.json 可复核）`);
  console.log(`  语义归并路径：覆盖率 ${report.model_path.coverage}% ｜ 误挂率 ${report.model_path.misattribution}% ｜ 耗时 ${report.model_path.elapsedMs}ms`);
  console.log(`  纯规则基线　：覆盖率 ${report.baseline_path.coverage}% ｜ 误挂率 ${report.baseline_path.misattribution}% ｜ 耗时 ${report.baseline_path.elapsedMs}ms`);
  console.log(`  结论：${report.conclusion}`);
  console.log('  报告：reports/attribution-benchmark.json（数值来自真实运行，两次重跑一致）');
  return 0;
}

export async function runBenchScale(argv: readonly string[], ctx: CliContext): Promise<number> {
  void argv; void ctx;
  const summary = runScaleAcceptance();
  try {
    assertScaleInvariants(summary);
  } catch (err) {
    console.error(`规模验收失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log('归因引擎真实规模验收');
  console.log(`  咨询单：${summary.consultationCount} 条 ｜ 明细行：${summary.lineCount} 条（≥300）`);
  console.log(`  零漏行：已覆盖 ${summary.coveredLines} + 显式依据缺失 ${summary.missingLines} = ${summary.lineCount}`);
  console.log(`  引用覆盖率：${summary.citationCoverage}%（100%） ｜ 拒答数：${summary.refusalCount}`);
  console.log(`  单批耗时：${summary.elapsedMs}ms（≤5000ms） ｜ p50 ${summary.p50Ms}ms ｜ p95 ${summary.p95Ms}ms`);
  console.log('  运行摘要：reports/attribution-scale.json');
  return 0;
}

export async function runSlaScan(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  const at = strFlag(flags, 'at');
  const clock = new FakeClock(at ? new Date(at) : new Date());
  const service = new SlaEscalationService(ctx.repos, ctx.config, clock);
  const outcome = service.scan();
  console.log(`超时升级扫描（时钟 ${clock.now().toISOString()}）`);
  console.log(`  扫描待答复/草稿待确认：${outcome.scanned} 条 ｜ 本次升级：${outcome.escalated.length} 条 ｜ 未超时/重复：${outcome.unchanged.length} 条`);
  for (const entry of outcome.escalated) {
    console.log(`  - ${entry.consultationNo}：${entry.fromStatus} 超 ${entry.limitMinutes} 分钟 → ${entry.escalatedTo}`);
  }
  return 0;
}
