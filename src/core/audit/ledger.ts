/**
 * 台账检索与咨询单原样重放（Task 42）。
 *
 * 按状态 / 窗口 / 日期范围 / 争议分类过滤分页，回答住院服务中心「还剩哪些没答、归谁」；
 * 已答复咨询可被检索并原样重放其解释稿与引用清单（含当时的字典版本与价目版本快照），
 * 家属事后再来问时窗口直接调出上次那份，不重新生成、不改口径、不新增归因轮次。
 */

import type { DisputeCategory, ConsultationStatus } from '../domain/types.ts';
import type { Citation, RuleHit } from '../domain/contracts.ts';
import type { LedgerFilter, Repositories } from '../../db/index.ts';
import { reproduceSnapshot, type Reproduction } from '../rules/snapshot.ts';
import { CATEGORY_LABELS } from '../config.ts';

export interface LedgerQuery extends LedgerFilter {
  windowName?: string;
}

export interface LedgerRow {
  consultationNo: string;
  channel: string;
  encounterNoMasked: string;
  status: ConsultationStatus;
  amount: number;
  category?: DisputeCategory;
  assignedTo?: string;
  createdAt: string;
  workOrderNo?: string;
}

export interface ReplayResult {
  consultationNo: string;
  snapshotRef: string;
  reproduction: Reproduction;
  explanationText: string;
  citations: Citation[];
  /** 重放不新增归因轮次、不重跑模型 */
  sessionRoundsBefore: number;
  sessionRoundsAfter: number;
  modelCalls: 0;
}

export class LedgerService {
  private readonly repos: Repositories;

  constructor(repos: Repositories) {
    this.repos = repos;
  }

  search(query: LedgerQuery = {}): LedgerRow[] {
    const records = this.repos.consultations.list(query);
    return records
      .filter((record) => {
        if (query.windowName) {
          const binding = this.repos.queues.list().find((b) => b.windowName === query.windowName);
          if (!binding) return false;
          const expected = binding.disputeType;
          const label = record.disputeCategory ? CATEGORY_LABELS[record.disputeCategory] ?? '' : '';
          if (!label.includes(expected.slice(0, 2))) return false;
        }
        return true;
      })
      .map((record) => ({
        consultationNo: record.consultationNo,
        channel: record.channel,
        encounterNoMasked: record.encounterNoMasked,
        status: record.status,
        amount: record.amount,
        ...(record.disputeCategory ? { category: record.disputeCategory } : {}),
        ...(record.assignedTo ? { assignedTo: record.assignedTo } : {}),
        createdAt: record.createdAt,
        ...(record.workOrderNo ? { workOrderNo: record.workOrderNo } : {}),
      }));
  }

  /** 原样重放：取历史归因结果与引用清单，用快照版本，不重跑模型 */
  replay(consultationNo: string, operator: string): ReplayResult {
    const record = this.repos.consultations.find(consultationNo);
    if (!record) throw new Error(`咨询单不存在：${consultationNo}`);
    const before = this.repos.sessions.count(consultationNo);
    const reproduction = reproduceSnapshot(this.repos.snapshots, record.snapshotRef);
    const session = this.repos.sessions.latest(consultationNo);
    const ruleHits = (reproduction.ruleHits ?? []) as RuleHit[];
    const explanationText = [
      `# 咨询单原样重放 · ${consultationNo}`,
      `- 住院号（掩码）：${record.encounterNoMasked}`,
      `- 争议分类：${record.disputeCategory ? CATEGORY_LABELS[record.disputeCategory] : '未分类'}`,
      `- 价目版本：${reproduction.versions.priceVersion} ｜ 字典版本：${reproduction.versions.dictionaryVersion} ｜ 规则版本：${reproduction.versions.rulesVersion}`,
      `- 引用条数：${reproduction.citations.length}（与上次逐字一致，未重新生成）`,
      `- 规则命中：${ruleHits.length} 条`,
      '',
      '## 当时的依据清单',
      ...reproduction.readable,
      '',
      '## 当时的解释稿（原样重放，不重新生成）',
      ...reproduction.parts.map((part) => `- ${part.text ?? ''}`),
      '',
      '## 当时的上下文摘要',
      ...(session?.contextSummary ? [`- ${session.contextSummary}`] : []),
      '- 本件为历史快照复现，不重跑模型、不改写口径。',
    ].join('\n');

    this.repos.replayAudits.record(consultationNo, operator, reproduction.citations.length);
    return {
      consultationNo,
      snapshotRef: record.snapshotRef ?? '',
      reproduction,
      explanationText,
      citations: reproduction.citations,
      sessionRoundsBefore: before,
      sessionRoundsAfter: this.repos.sessions.count(consultationNo),
      modelCalls: 0,
    };
  }
}
