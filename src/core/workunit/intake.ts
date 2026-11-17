/**
 * 多通道诉求归一（Task 10）—— 窗口当面 / 电话 / 线上留言 → 一条费用咨询单。
 *
 * 三入口各录一条应得到三条独立咨询单，渠道标记正确；
 * 同一住院号 + 同一诉求指纹 24 小时内再次提交时提示「疑似重复咨询」，不自动合并。
 */

import { createHash } from 'node:crypto';

import { STATUS_LABELS } from '../domain/state-machine.ts';
import type { ConsultationChannel } from '../domain/types.ts';
import { maskEncounterNo } from '../domain/mask.ts';
import { desensitizeText } from '../attribution/desensitize.ts';
import type { Repositories } from '../../db/index.ts';

export const CHANNELS: readonly ConsultationChannel[] = ['counter', 'phone', 'online'];

export interface IntakeInput {
  channel: ConsultationChannel;
  requestText: string;
  encounterNo: string;
  operator: string;
  /** 注入时钟，便于测试 24 小时窗口 */
  now?: string;
  /** 显式指定编号（批量导入 / 测试用） */
  consultationNo?: string;
}

export interface IntakeOutcome {
  consultationNo: string;
  channel: ConsultationChannel;
  duplicateHint?: string;
  statusLabel: string;
  requestTextStored: string;
}

export function requestFingerprint(encounterNo: string, requestText: string): string {
  const normalized = requestText.replace(/\s+/gu, '').toLowerCase();
  return createHash('sha256').update(`${encounterNo}|${normalized}`).digest('hex');
}

export function nextConsultationNo(seq: number, at: string): string {
  const date = at.slice(0, 10).replace(/-/g, '');
  return `CS${date}${String(seq).padStart(4, '0')}`;
}

/** 统一 intake 入口：原文脱敏后原样留存，渠道与来源标记落库 */
export function intake(input: IntakeInput, repos: Repositories): IntakeOutcome {
  if (!CHANNELS.includes(input.channel)) {
    throw new Error(`未知渠道：${String(input.channel)}`);
  }
  const now = input.now ?? new Date().toISOString();
  const since = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const fingerprint = requestFingerprint(input.encounterNo, input.requestText);
  const duplicates = repos.fingerprints.findRecent(fingerprint, since);
  const stored = desensitizeText(input.requestText);
  const seq = repos.consultations.count() + 1;
  const consultationNo = input.consultationNo ?? nextConsultationNo(seq, now);

  repos.consultations.insert({
    consultationNo,
    channel: input.channel,
    encounterNo: input.encounterNo,
    encounterNoMasked: maskEncounterNo(input.encounterNo),
    requestText: stored,
    status: 'pending_reply',
    amount: 0,
    handoffFailed: false,
    createdAt: now,
    updatedAt: now,
  });
  repos.fingerprints.record(fingerprint, consultationNo, now);

  return {
    consultationNo,
    channel: input.channel,
    ...(duplicates.length > 0
      ? { duplicateHint: `疑似重复咨询：24 小时内已有 ${duplicates.join('、')}，本条仍独立建档，不自动合并` }
      : {}),
    statusLabel: STATUS_LABELS.pending_reply,
    requestTextStored: stored,
  };
}
