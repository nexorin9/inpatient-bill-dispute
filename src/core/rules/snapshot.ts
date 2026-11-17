/**
 * 口径与规则版本快照（Task 31）。
 *
 * 归因时把当时的价目版本、结算清单字典版本、规则集版本一并快照写入咨询单与归因留痕；
 * 解释稿每条引用指向快照中的具体版本，不在渲染时回查当前字典。
 * 价目改版、规则更新之后，历史解释稿仍可复现当时依据；
 * 快照缺失时明确标「历史依据不可复现」，不用当前版本顶替。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { Citation, EvidenceRef, ExplanationPart, RuleHit } from '../domain/contracts.ts';
import type { VersionSnapshot } from '../dictionary/loader.ts';
import type { SnapshotRepository } from '../../db/repositories/sessions.ts';

export interface SnapshotPayload extends VersionSnapshot {
  createdAt: string;
  /** 依据本体与版本的映射：解释稿引用只查这里 */
  citations: Citation[];
  /** 当时的解释稿正文（重放与打印稿原样取用，不重新生成） */
  parts: ExplanationPart[];
  ruleHits: RuleHit[];
  evidenceRefs: EvidenceRef[];
  priceItemCodeSet: string[];
  dictionaryAnchors: string[];
}

export function buildSnapshotPayload(
  versions: VersionSnapshot,
  input: {
    citations: Citation[];
    parts: ExplanationPart[];
    ruleHits: RuleHit[];
    evidenceRefs: EvidenceRef[];
    priceItemCodes: string[];
    dictionaryAnchors?: string[];
    createdAt?: string;
  },
): SnapshotPayload {
  return {
    ...versions,
    createdAt: input.createdAt ?? new Date().toISOString(),
    citations: input.citations.map((c) => ({ ...c, version: c.version ?? versions.dictionaryVersion })),
    parts: input.parts,
    ruleHits: input.ruleHits,
    evidenceRefs: input.evidenceRefs,
    priceItemCodeSet: [...new Set(input.priceItemCodes)],
    dictionaryAnchors: input.dictionaryAnchors ?? [],
  };
}

export interface Reproduction {
  snapshotRef: string;
  versions: Pick<VersionSnapshot, 'priceVersion' | 'dictionaryVersion' | 'rulesVersion' | 'reconciliationVersion'>;
  citations: Citation[];
  parts: ExplanationPart[];
  ruleHits: RuleHit[];
  readable: string[];
}

/** 按咨询单取快照并重建当时的依据清单，输出可读复核件 */
export function reproduceSnapshot(
  repo: SnapshotRepository,
  snapshotRef: string | undefined,
): Reproduction {
  if (!snapshotRef) {
    throw new AppError(ErrorCode.EVIDENCE_MISSING, { reason: '历史依据不可复现：咨询单缺版本快照' });
  }
  const raw = repo.load(snapshotRef);
  if (!raw || Object.keys(raw).length === 0) {
    throw new AppError(ErrorCode.EVIDENCE_MISSING, {
      snapshotRef, reason: '历史依据不可复现：快照缺失，不用当前版本顶替',
    });
  }
  const payload = raw as unknown as SnapshotPayload;
  const readable = payload.citations.map((c) =>
    `[${c.index}] ${c.type} ${c.code} ${c.label}（依据版本 ${c.version ?? payload.dictionaryVersion}）`);
  return {
    snapshotRef,
    versions: {
      priceVersion: payload.priceVersion,
      dictionaryVersion: payload.dictionaryVersion,
      rulesVersion: payload.rulesVersion,
      reconciliationVersion: payload.reconciliationVersion,
    },
    citations: payload.citations,
    parts: payload.parts ?? [],
    ruleHits: payload.ruleHits,
    readable,
  };
}
