/**
 * 咨询超时升级（Task 41）—— 时钟注入，升级给住院服务中心。
 *
 * 待答复或草稿待确认状态超过配置时限未答复即升级，并留升级记录；
 * 超时口径按渠道可配（窗口当面与线上留言不同时限），不得写死；
 * 同一咨询在同一时限内只升级一次，不反复打扰住院服务中心。
 */

import type { AppConfig } from '../config.ts';
import type { Repositories, SlaEscalationRecord } from '../../db/index.ts';
import type { ConsultationChannel, ConsultationStatus } from '../domain/types.ts';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

/** 测试用假时钟：可推进时间，生产不直接调 Date.now */
export class FakeClock implements Clock {
  private current: Date;

  constructor(current: Date = new Date('2026-11-09T09:00:00.000Z')) {
    this.current = current;
  }
  now(): Date { return new Date(this.current); }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
  set(iso: string): void { this.current = new Date(iso); }
}

const SCAN_STATUSES: readonly ConsultationStatus[] = ['pending_reply', 'draft_pending_confirm'];

export interface SlaScanOutcome {
  escalated: SlaEscalationRecord[];
  unchanged: string[];
  scanned: number;
}

export class SlaEscalationService {
  private readonly repos: Repositories;
  private readonly config: AppConfig;
  private readonly clock: Clock;

  constructor(
    repos: Repositories,
    config: AppConfig,
    clock: Clock = new SystemClock(),
  ) {
    this.repos = repos;
    this.config = config;
    this.clock = clock;
  }

  /** 按渠道取时限（分钟） */
  limitFor(channel: ConsultationChannel): number {
    return this.config.slaMinutes[channel] ?? this.config.slaMinutes.counter;
  }

  /** 扫描待答复与草稿待确认，超时即升级 */
  scan(): SlaScanOutcome {
    const now = this.clock.now();
    const candidates = this.repos.consultations.list({ limit: 1000 })
      .filter((c) => SCAN_STATUSES.includes(c.status));
    const escalated: SlaEscalationRecord[] = [];
    const unchanged: string[] = [];

    for (const record of candidates) {
      const limitMinutes = this.limitFor(record.channel);
      const elapsedMinutes = (now.getTime() - new Date(record.createdAt).getTime()) / 60_000;
      if (elapsedMinutes <= limitMinutes) {
        unchanged.push(record.consultationNo);
        continue;
      }
      const slaKey = `${record.consultationNo}|${limitMinutes}`;
      const entry: SlaEscalationRecord = {
        consultationNo: record.consultationNo,
        fromStatus: record.status,
        limitMinutes,
        escalatedTo: '住院服务中心',
        escalatedAt: now.toISOString(),
        slaKey,
      };
      if (this.repos.sla.tryEscalate(entry)) escalated.push(entry);
      else unchanged.push(record.consultationNo);
    }
    return { escalated, unchanged, scanned: candidates.length };
  }

  /** 未答复清单视图：按在手人分组，标出超时项 */
  unansweredByAssignee(): Array<{
    assignee: string;
    items: Array<{ consultationNo: string; status: ConsultationStatus; overdue: boolean; limitMinutes: number }>;
  }> {
    const now = this.clock.now().getTime();
    const groups = new Map<string, Array<{ consultationNo: string; status: ConsultationStatus; overdue: boolean; limitMinutes: number }>>();
    for (const record of this.repos.consultations.list({ limit: 1000 }).filter((c) => SCAN_STATUSES.includes(c.status))) {
      const assignee = record.assignedTo ?? '未派单';
      const limitMinutes = this.limitFor(record.channel);
      const overdue = (now - new Date(record.createdAt).getTime()) / 60_000 > limitMinutes;
      const items = groups.get(assignee) ?? [];
      items.push({ consultationNo: record.consultationNo, status: record.status, overdue, limitMinutes });
      groups.set(assignee, items);
    }
    return [...groups.entries()].map(([assignee, items]) => ({ assignee, items }));
  }
}
