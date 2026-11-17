/**
 * 引用留痕导出包（Task 43）—— 给财务科与内审的那份证据。
 *
 * 导出 CSV + JSON：咨询级（编号、渠道、掩码住院号、状态、分类、金额、确认人时间）
 * + 解释级（条目文本、引用清单、依据出处、模型名与版本、耗时）两层结构。
 * 字段顺序固定、中文表头可读、JSON 带导出元信息；导出前扫描身份信息，命中即中止；
 * 支持按日期范围与状态过滤，导出条数与过滤结果一致。
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import type { LedgerFilter, Repositories } from '../../db/index.ts';
import { CATEGORY_LABELS, CHANNEL_LABELS } from '../config.ts';

const EXPORT_DIR = new URL('../../../outbox/', import.meta.url);

export const CSV_HEADERS = [
  '咨询编号', '渠道', '住院号(掩码)', '状态', '争议分类', '金额(元)', '确认人', '确认时间',
  '价目版本', '字典版本', '规则版本', '引用条数', '引用清单', '依据出处',
  '模型名', '模型版本', '归因轮次', '耗时(毫秒)', '降级标记', '创建时间',
] as const;

const IDENTITY_PATTERNS = [
  /\b\d{17}[\dXx]\b/, /\b1[3-9]\d{9}\b/, /床号\s*[:：]?\s*\d+/,
  /姓名\s*[:：]\s*[^\s,，。;；]{2,}/, /住址\s*[:：]/,
];

export interface ExportRow {
  consultationNo: string;
  channel: string;
  encounterNoMasked: string;
  status: string;
  category: string;
  amount: number;
  confirmedBy?: string;
  confirmedAt?: string;
  priceVersion?: string;
  dictionaryVersion?: string;
  rulesVersion?: string;
  citationCount: number;
  citations: string;
  basisRefs: string;
  model: string;
  modelVersion: string;
  sessionRounds: number;
  latencyMs: number;
  degraded: boolean;
  createdAt: string;
  explanationItems: Array<{
    text: string;
    lineNumbers: number[];
    citationIndexes: number[];
    basisRefs: string[];
    model: string;
    modelVersion: string;
    latencyMs: number;
    needsHuman: boolean;
  }>;
}

export interface ExportPackage {
  meta: {
    exportedAt: string;
    dictionaryVersionNote: string;
    rowCount: number;
    filter: LedgerFilter;
    format: 'csv+json';
  };
  rows: ExportRow[];
  csv: string;
  jsonPath?: string;
  csvPath?: string;
}

/** 脱敏检查：命中即中止导出，不产出半成品 */
export function assertExportSafe(value: string): void {
  for (const pattern of IDENTITY_PATTERNS) {
    if (pattern.test(value)) throw new Error('导出件含患者可识别信息，导出中止');
  }
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildExportRows(repos: Repositories, filter: LedgerFilter = {}): ExportRow[] {
  return repos.consultations.list({ ...filter, limit: 1000 }).map((record) => {
    const sessions = repos.sessions.list(record.consultationNo);
    const latest = sessions[sessions.length - 1];
    const citations = latest?.citations ?? [];
    const snapshot = record.snapshotRef ? repos.snapshots.load(record.snapshotRef) : undefined;
    const ruleHits = (snapshot?.ruleHits ?? []) as Array<{ basisRef: string }>;
    const row: ExportRow = {
      consultationNo: record.consultationNo,
      channel: CHANNEL_LABELS[record.channel] ?? record.channel,
      encounterNoMasked: record.encounterNoMasked,
      status: record.status,
      category: record.disputeCategory ? CATEGORY_LABELS[record.disputeCategory] ?? record.disputeCategory : '',
      amount: record.amount,
      ...(record.confirmedBy ? { confirmedBy: record.confirmedBy } : {}),
      ...(record.confirmedAt ? { confirmedAt: record.confirmedAt } : {}),
      ...(record.priceVersion ? { priceVersion: record.priceVersion } : {}),
      ...(record.dictionaryVersion ? { dictionaryVersion: record.dictionaryVersion } : {}),
      ...(record.rulesVersion ? { rulesVersion: record.rulesVersion } : {}),
      citationCount: citations.length,
      citations: citations.map((c) => `${c.type}:${c.code}`).join('|'),
      basisRefs: [...new Set(ruleHits.map((h) => h.basisRef))].join('|'),
      model: latest?.model ?? '确定性基线',
      modelVersion: latest?.modelVersion ?? '',
      sessionRounds: sessions.length,
      latencyMs: latest?.latencyMs ?? 0,
      degraded: latest?.degraded ?? false,
      createdAt: record.createdAt,
      explanationItems: (latest?.snapshot?.citations ?? []) as ExportRow['explanationItems'],
    };
    assertExportSafe(JSON.stringify(row));
    return row;
  });
}

export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push([
      row.consultationNo, row.channel, row.encounterNoMasked, row.status, row.category,
      row.amount.toFixed(2), row.confirmedBy ?? '', row.confirmedAt ?? '',
      row.priceVersion ?? '', row.dictionaryVersion ?? '', row.rulesVersion ?? '',
      row.citationCount, row.citations, row.basisRefs, row.model, row.modelVersion,
      row.sessionRounds, row.latencyMs, row.degraded ? '是' : '否', row.createdAt,
    ].map(csvCell).join(','));
  }
  // UTF-8 BOM：Excel 打开中文表头不乱码
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function exportAuditPackage(
  repos: Repositories,
  filter: LedgerFilter = {},
  options: { writeFile?: boolean; prefix?: string } = {},
): ExportPackage {
  const rows = buildExportRows(repos, filter);
  const csv = toCsv(rows);
  assertExportSafe(csv);
  const meta: ExportPackage['meta'] = {
    exportedAt: new Date().toISOString(),
    dictionaryVersionNote: '导出件引用的是各咨询单归因当时的版本快照，不是当前字典版本',
    rowCount: rows.length,
    filter,
    format: 'csv+json',
  };
  let jsonPath: string | undefined;
  let csvPath: string | undefined;
  if (options.writeFile !== false) {
    mkdirSync(EXPORT_DIR, { recursive: true });
    const prefix = options.prefix ?? 'audit-export';
    const jsonUrl = new URL(`${prefix}.json`, EXPORT_DIR);
    const csvUrl = new URL(`${prefix}.csv`, EXPORT_DIR);
    writeFileSync(jsonUrl, JSON.stringify({ ...meta, rows }, null, 2) + '\n', 'utf8');
    writeFileSync(csvUrl, csv, 'utf8');
    jsonPath = jsonUrl.pathname;
    csvPath = csvUrl.pathname;
  }
  return { meta, rows, csv, ...(jsonPath ? { jsonPath } : {}), ...(csvPath ? { csvPath } : {}) };
}
