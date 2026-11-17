/**
 * 真实规模验收（Task 27）—— ≥300 条明细、≤5 秒、零漏行、引用覆盖 100%。
 *
 * 结论与运行摘要落盘 reports/attribution-scale.json，作为可复现的对照结果而非一次性观察。
 * 批量入口不落库，只做计算，避免 SQLite 写入干扰耗时测量。
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import type { ScaleSummary } from '../domain/contracts.ts';
import type { AppConfig } from '../config.ts';
import type { DictionaryBundle } from '../dictionary/loader.ts';
import type { BillDetail, PriceBook } from '../domain/types.ts';
import type { SampleTranscript } from '../adapters/samples.ts';
import { loadSampleEncounters, loadSamplePriceBook, loadSampleTranscripts } from '../adapters/samples.ts';
import { loadDictionaries } from '../dictionary/loader.ts';
import { loadConfig } from '../config.ts';
import { buildBaseline } from './baseline.ts';
import { buildExplanation } from './explanation.ts';
import { deterministicMatches } from './engine.ts';
import { extractQuestionPointsHeuristic } from './question-points.ts';
import { applyAmbiguityPolicy } from './ambiguity.ts';

const REPORTS_DIR = new URL('../../../reports/', import.meta.url);

export interface ScaleInput {
  encounters?: BillDetail[];
  transcripts?: SampleTranscript[];
  config?: AppConfig;
  bundle?: DictionaryBundle;
  priceBook?: PriceBook;
  /** 至少 20 条咨询单 */
  consultationCount?: number;
  writeReport?: boolean;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** 一次运行处理多咨询单，输出逐条结果与运行摘要 */
export function runScaleAcceptance(input: ScaleInput = {}): ScaleSummary & { perConsultation: Array<{ no: string; lines: number; elapsedMs: number }> } {
  const config = input.config ?? loadConfig();
  const bundle = input.bundle ?? loadDictionaries();
  const priceBook = input.priceBook ?? loadSamplePriceBook();
  const encounters = input.encounters ?? loadSampleEncounters();
  const transcripts = input.transcripts ?? loadSampleTranscripts();
  const consultationCount = Math.max(20, input.consultationCount ?? 20);

  const started = Date.now();
  const perConsultation: Array<{ no: string; lines: number; elapsedMs: number }> = [];
  let lineCount = 0;
  let coveredLines = 0;
  let missingLines = 0;
  let explained = 0;
  let withEvidence = 0;
  let refusalCount = 0;

  for (let i = 0; i < consultationCount; i += 1) {
    const bill = encounters[i % encounters.length]!;
    const transcript = transcripts[i % transcripts.length]!;
    const t0 = Date.now();
    const baseline = buildBaseline({ bill, priceBook, bundle, config, dataSource: 'samples' });
    const points = extractQuestionPointsHeuristic(transcript.text);
    const matches = deterministicMatches(bill, points);
    const ambiguity = applyAmbiguityPolicy(matches, config, {
      unmatched: points.map((p) => p.text).filter((p) => !matches.some((m) => m.questionPoint === p)),
    });
    const explanation = buildExplanation({
      bill, priceBook, bundle,
      matches: ambiguity.accepted,
      ruleHits: [...baseline.ruleHits, ...baseline.guardrailHits],
      citationsEnabled: config.citationsEnabled,
      evidenceMissingLineNumbers: baseline.evidenceMissingLineNumbers,
      refusedLineNumbers: ambiguity.refusedLineNumbers,
    });
    const elapsed = Date.now() - t0;
    perConsultation.push({ no: `SCALE-${String(i + 1).padStart(3, '0')}`, lines: bill.lines.length, elapsedMs: elapsed });

    lineCount += bill.lines.length;
    coveredLines += baseline.coveredLineNumbers.length;
    missingLines += baseline.evidenceMissingLineNumbers.length;
    refusalCount += ambiguity.refusals.length;
    for (const part of explanation.parts) {
      explained += 1;
      // 每条解释要么带至少一条有效引用，要么显式标依据缺失；空解释判失败
      if (part.citationIndexes.length > 0 || part.evidenceMissing || part.needsHuman) withEvidence += 1;
    }
  }

  const durations = perConsultation.map((c) => c.elapsedMs);
  const summary: ScaleSummary = {
    consultationCount,
    lineCount,
    coveredLines,
    missingLines,
    citationCoverage: explained === 0 ? 0 : Number(((withEvidence / explained) * 100).toFixed(2)),
    refusalCount,
    elapsedMs: Date.now() - started,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
  };

  if (input.writeReport !== false) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(
      new URL('attribution-scale.json', REPORTS_DIR),
      JSON.stringify({
        _meta: {
          definition: '归因覆盖率=每条解释带有效引用或显式依据缺失的占比；零漏行=已归因行+显式依据缺失行=输入明细行数；耗时为单批真实运行墙钟时间',
          source: 'samples/bill-details.json（Synthea 公开字段口径派生）+ samples/transcripts.json',
          generated_at: new Date().toISOString(),
        },
        ...summary,
        per_consultation: perConsultation,
      }, null, 2) + '\n',
      'utf8',
    );
  }
  return { ...summary, perConsultation };
}

/** 零漏行与引用覆盖的硬断言（供测试与 CLI 使用） */
export function assertScaleInvariants(summary: ScaleSummary): void {
  const accounted = summary.coveredLines + summary.missingLines;
  if (accounted !== summary.lineCount) {
    throw new Error(`零漏行断言失败：输入 ${summary.lineCount} 行，已覆盖+依据缺失 ${accounted} 行`);
  }
  if (summary.citationCoverage < 100) {
    throw new Error(`引用覆盖断言失败：${summary.citationCoverage}% < 100%`);
  }
  if (summary.elapsedMs > 5000) {
    throw new Error(`性能断言失败：单批 ${summary.elapsedMs}ms > 5000ms`);
  }
}
