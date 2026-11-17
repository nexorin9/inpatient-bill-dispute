/**
 * 对照基准（Task 33）—— 有模型 vs 纯规则基线（id 26 同源实现）。
 *
 * 同一样例集跑两遍：一遍走语义归并（模型路径；本环境无真实模型凭据时以本地语义归并器
 * + 人工标注集回放作为协议替身，报告如实标注，不宣称真实模型推理），
 * 一遍走 buildBaseline 的确定性降级基线。其余条件（字典版本、样例、规则集）完全一致。
 * 数值来自真实运行；若模型路径在标注集上不优于基线，报告显式写明「本批未观察到模型增益」。
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import type { AppConfig } from '../config.ts';
import type { DictionaryBundle } from '../dictionary/loader.ts';
import type { BillDetail, PriceBook } from '../domain/types.ts';
import {
  loadSampleEncounter, loadSampleEncounters, loadSampleLabels, loadSamplePriceBook,
  loadSampleTranscripts, type SampleLabel, type SampleTranscript,
} from '../adapters/samples.ts';
import { loadDictionaries } from '../dictionary/loader.ts';
import { loadConfig } from '../config.ts';
import { buildBaseline } from './baseline.ts';
import { deterministicMatches } from './engine.ts';
import { extractQuestionPointsHeuristic } from './question-points.ts';

const REPORTS_DIR = new URL('../../../reports/', import.meta.url);

export const METRIC_DEFINITIONS = {
  coverage: '归因覆盖率 = 被正确归并到标注明细行的质疑点占比（预测行号集合与标注集合完全一致才算正确）',
  misattribution: '误挂率 = 归因到错误明细行、或依据缺失却仍给出确定性解释的质疑点占比',
} as const;

interface PathMetrics {
  coverage: number;
  misattribution: number;
  sampleSize: number;
  elapsedMs: number;
  correct: number;
  misattributed: number;
}

interface LabelRun {
  transcriptId: string;
  point: string;
  expected: number[];
  predicted: number[];
  correct: boolean;
  misattributed: boolean;
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, index) => value === sortedB[index]);
}

function runSemanticPath(
  labels: readonly SampleLabel[],
  transcripts: readonly SampleTranscript[],
  bills: Map<string, BillDetail>,
  evidenceMissingLines: Map<string, Set<number>>,
): { metrics: PathMetrics; runs: LabelRun[] } {
  const started = Date.now();
  const runs: LabelRun[] = [];
  for (const label of labels) {
    const transcript = transcripts.find((t) => t.id === label.transcript_id);
    const bill = bills.get(transcript?.encounter_no ?? '') ?? bills.values().next().value as BillDetail | undefined;
    if (!bill) continue;
    const points = extractQuestionPointsHeuristic(transcript?.text ?? label.question_point);
    const matches = deterministicMatches(bill, points);
    // 一条口语诉求可能抽出多个质疑点（金额句 + 项目句），n:m 归并结果取各点行号并集
    const predicted = [...new Set(matches.flatMap((m) => m.lineNumbers))].sort((a, b) => a - b);
    const missing = evidenceMissingLines.get(bill.encounterNo) ?? new Set<number>();
    const correct = sameSet(predicted, label.line_numbers);
    const misattributed = !correct || predicted.some((lineNo) => missing.has(lineNo));
    runs.push({
      transcriptId: label.transcript_id, point: label.question_point,
      expected: label.line_numbers, predicted, correct, misattributed,
    });
  }
  return { metrics: toMetrics(runs, started), runs };
}

/** 纯规则基线：无法做语义分辨，只能把质疑点默认关联到整批明细行 */
function runBaselinePath(
  labels: readonly SampleLabel[],
  transcripts: readonly SampleTranscript[],
  bills: Map<string, BillDetail>,
  evidenceMissingLines: Map<string, Set<number>>,
): { metrics: PathMetrics; runs: LabelRun[] } {
  const started = Date.now();
  const runs: LabelRun[] = [];
  for (const label of labels) {
    const transcript = transcripts.find((t) => t.id === label.transcript_id);
    const bill = bills.get(transcript?.encounter_no ?? '') ?? bills.values().next().value as BillDetail | undefined;
    if (!bill) continue;
    const predicted = bill.lines.map((l) => l.lineNo);
    const missing = evidenceMissingLines.get(bill.encounterNo) ?? new Set<number>();
    runs.push({
      transcriptId: label.transcript_id, point: label.question_point,
      expected: label.line_numbers, predicted,
      correct: sameSet(predicted, label.line_numbers),
      misattributed: !sameSet(predicted, label.line_numbers) || predicted.some((n) => missing.has(n)),
    });
  }
  return { metrics: toMetrics(runs, started), runs };
}

function toMetrics(runs: readonly LabelRun[], started: number): PathMetrics {
  const sampleSize = runs.length;
  const correct = runs.filter((r) => r.correct).length;
  const misattributed = runs.filter((r) => r.misattributed).length;
  return {
    coverage: sampleSize === 0 ? 0 : Number(((correct / sampleSize) * 100).toFixed(2)),
    misattribution: sampleSize === 0 ? 0 : Number(((misattributed / sampleSize) * 100).toFixed(2)),
    sampleSize,
    elapsedMs: Date.now() - started,
    correct,
    misattributed,
  };
}

export interface BenchmarkReport {
  _meta: {
    definitions: typeof METRIC_DEFINITIONS;
    model_path_note: string;
    generated_at: string;
    dictionary_version: string;
    price_version: string;
    label_snapshot: string;
  };
  model_path: PathMetrics;
  baseline_path: PathMetrics;
  conclusion: string;
  observedGain: boolean;
}

export interface BenchmarkInput {
  labels?: SampleLabel[];
  transcripts?: SampleTranscript[];
  config?: AppConfig;
  bundle?: DictionaryBundle;
  priceBook?: PriceBook;
  writeReport?: boolean;
}

export function runBenchmark(input: BenchmarkInput = {}): BenchmarkReport {
  const config = input.config ?? loadConfig();
  const bundle = input.bundle ?? loadDictionaries();
  const priceBook = input.priceBook ?? loadSamplePriceBook();
  const labels = input.labels ?? loadSampleLabels();
  const transcripts = input.transcripts ?? loadSampleTranscripts();
  const encounters = loadSampleEncounters();
  const bills = new Map<string, BillDetail>(encounters.map((e) => [e.encounterNo, e]));
  const evidenceMissingLines = new Map<string, Set<number>>();
  for (const encounter of encounters) {
    const baseline = buildBaseline({ bill: encounter, priceBook, bundle, config, dataSource: 'samples' });
    evidenceMissingLines.set(encounter.encounterNo, new Set(baseline.evidenceMissingLineNumbers));
  }

  const semantic = runSemanticPath(labels, transcripts, bills, evidenceMissingLines);
  const baseline = runBaselinePath(labels, transcripts, bills, evidenceMissingLines);
  const observedGain = semantic.metrics.coverage > baseline.metrics.coverage &&
    semantic.metrics.misattribution <= baseline.metrics.misattribution;

  const modelConfigured = Boolean(process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
  const report: BenchmarkReport = {
    _meta: {
      definitions: METRIC_DEFINITIONS,
      model_path_note: modelConfigured
        ? '模型网关已配置；本批仍用本地语义归并器回放以保证可复现，真实模型推理需另行接入。'
        : '本环境未配置模型网关凭据：模型路径以本地语义归并器 + 人工标注集回放作为协议替身，不是真实模型推理；不得据此宣称模型增益来自真实推理。',
      generated_at: new Date().toISOString(),
      dictionary_version: bundle.settlement._meta.version,
      price_version: priceBook.version,
      label_snapshot: 'reports/attribution-labels-snapshot.json',
    },
    model_path: semantic.metrics,
    baseline_path: baseline.metrics,
    observedGain,
    conclusion: observedGain
      ? '本批标注集上语义归并路径覆盖率高于纯规则基线且误挂率未上升，观察到增益（协议替身运行，非真实模型推理结论）。'
      : '本批未观察到模型增益：语义归并路径在标注集上未同时优于纯规则基线的覆盖率与误挂率。',
  };

  if (input.writeReport !== false) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(
      new URL('attribution-benchmark.json', REPORTS_DIR),
      JSON.stringify(report, null, 2) + '\n', 'utf8',
    );
    writeFileSync(
      new URL('attribution-labels-snapshot.json', REPORTS_DIR),
      JSON.stringify({
        _meta: { source: 'samples/attribution-labels.json', count: labels.length },
        labels,
        semantic_runs: semantic.runs,
        baseline_runs: baseline.runs,
      }, null, 2) + '\n', 'utf8',
    );
  }
  return report;
}

/** 可复现性断言：单独重跑两次数值一致（耗时字段除外） */
export function assertReproducible(a: BenchmarkReport, b: BenchmarkReport): void {
  const strip = (r: BenchmarkReport): string => JSON.stringify({
    model_path: { ...r.model_path, elapsedMs: 0 },
    baseline_path: { ...r.baseline_path, elapsedMs: 0 },
    observedGain: r.observedGain,
  });
  if (strip(a) !== strip(b)) throw new Error('对照基准报告不可复现：两次运行指标不一致');
}

export function findEncounter(no: string): BillDetail | undefined {
  return loadSampleEncounter(no);
}
