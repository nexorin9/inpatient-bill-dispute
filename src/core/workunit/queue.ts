/**
 * 队列与归因助手绑定（Task 35）。
 *
 * 争议类型（医保属性争议 / 金额疑问 / 重复收费疑问）↔ 收费窗口 ↔ 归因助手 / 交办通道；
 * 助手可停用，停用后该队列不再触发模型归因，改走确定性基线。绑定关系可配置、落库可查。
 */

import type { DisputeCategory } from '../domain/types.ts';
import { CHANNEL_LABELS } from '../config.ts';
import type { QueueBinding, QueueBindingRepository, Repositories } from '../../db/index.ts';

export const DEFAULT_BINDINGS: readonly QueueBinding[] = [
  {
    queueKey: 'Q-INSURANCE', disputeType: '医保属性争议', windowName: '住院收费处 1 号窗口',
    agentKey: 'assistant-insurance', handoffDept: '医保办', enabled: true,
    model: 'qwen2.5-instruct', promptKey: 'attribution-v1', conversationLimit: 20,
  },
  {
    queueKey: 'Q-AMOUNT', disputeType: '金额疑问', windowName: '住院收费处 2 号窗口',
    agentKey: 'assistant-amount', handoffDept: '财务科', enabled: true,
    model: 'qwen2.5-instruct', promptKey: 'attribution-v1', conversationLimit: 20,
  },
  {
    queueKey: 'Q-DUPLICATE', disputeType: '重复收费疑问', windowName: '住院收费处 3 号窗口',
    agentKey: 'assistant-duplicate', handoffDept: '医保办', enabled: true,
    model: 'qwen2.5-instruct', promptKey: 'attribution-v1', conversationLimit: 15,
  },
  {
    queueKey: 'Q-DEFAULT', disputeType: '其他', windowName: '住院收费处综合窗口',
    agentKey: 'assistant-default', handoffDept: '住院服务中心', enabled: true,
    model: 'qwen2.5-instruct', promptKey: 'attribution-v1', conversationLimit: 30,
  },
];

const CATEGORY_TO_QUEUE: Record<DisputeCategory | 'default', string> = {
  to_insurance_office: 'Q-INSURANCE',
  internal_check: 'Q-AMOUNT',
  needs_human: 'Q-DEFAULT',
  default: 'Q-DEFAULT',
};

export interface QueueResolution {
  binding: QueueBinding;
  /** 助手停用后不再触发模型归因，改走确定性基线 */
  useModel: boolean;
  handoffDept: string;
  warnings: string[];
  display: string;
}

export class QueueBindingService {
  private readonly repos: Repositories;

  constructor(repos: Repositories) {
    this.repos = repos;
  }

  /** 首次使用时把默认绑定落库（可配置，不硬编码在界面里） */
  ensureDefaults(): void {
    for (const binding of DEFAULT_BINDINGS) {
      if (!this.repos.queues.get(binding.queueKey)) this.repos.queues.upsert(binding);
    }
  }

  list(): QueueBinding[] {
    return this.repos.queues.list();
  }

  /** 停用助手：该队列不再触发模型归因 */
  setEnabled(queueKey: string, enabled: boolean): void {
    const binding = this.repos.queues.get(queueKey);
    if (!binding) throw new Error(`队列不存在：${queueKey}`);
    this.repos.queues.upsert({ ...binding, enabled });
  }

  /** 分类三值 → 队列与交办通道；映射缺失时显式报错并回落默认队列 */
  resolve(category: DisputeCategory | string): QueueResolution {
    this.ensureDefaults();
    const warnings: string[] = [];
    const queueKey = CATEGORY_TO_QUEUE[category as DisputeCategory] ?? 'Q-DEFAULT';
    if (!CATEGORY_TO_QUEUE[category as DisputeCategory]) {
      warnings.push(`争议类型「${category}」缺队列映射，已回落默认队列 Q-DEFAULT`);
    }
    let binding = this.repos.queues.get(queueKey);
    if (!binding) {
      warnings.push(`队列 ${queueKey} 未配置，已回落默认队列`);
      binding = this.repos.queues.get('Q-DEFAULT') ?? { ...DEFAULT_BINDINGS[3]! };
    }
    return {
      binding,
      useModel: binding.enabled,
      handoffDept: binding.handoffDept,
      warnings,
      display: `窗口：${binding.windowName} ｜ 助手：${binding.agentKey ?? '未绑定'} ｜ 交办：${binding.handoffDept}`,
    };
  }

  /** 绑定查询接口：供界面显示「这条咨询归哪个窗口、哪个助手、哪个交办部门」 */
  describe(consultationNo: string): string {
    const record = this.repos.consultations.find(consultationNo);
    const resolution = this.resolve(record?.disputeCategory ?? 'default');
    const channel = record ? CHANNEL_LABELS[record.channel] ?? record.channel : '未知渠道';
    return `${channel} ｜ ${resolution.display}${resolution.warnings.length > 0 ? ` ｜ ${resolution.warnings.join('；')}` : ''}`;
  }
}

export type { QueueBindingRepository };
