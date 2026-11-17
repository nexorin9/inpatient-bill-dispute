/**
 * 凭据位登记 —— 全系统对外接口的配置面真源。
 *
 * 所有端点地址与令牌一律从环境变量读，代码里不出现任何真实地址或密钥；
 * 界面与日志只消费「是否已配置」，不回显取值。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';

export type SlotGroup = 'model' | 'his' | 'pricing' | 'workorder' | 'im';

export interface CredentialSlot {
  /** 环境变量名 */
  env: string;
  /** 归属的外部系统分组 */
  group: SlotGroup;
  /** 用途说明（中文） */
  purpose: string;
  /** 是否为敏感项（是则绝不回显取值） */
  secret: boolean;
  /** 缺少时是否阻断归因主路径 */
  required: boolean;
  /** 默认值（非敏感项可为空串默认值） */
  defaultValue?: string;
}

export const CREDENTIAL_SLOTS: readonly CredentialSlot[] = [
  {
    env: 'OPENAI_BASE_URL',
    group: 'model',
    purpose: '模型网关端点（OpenAI-compatible，医院自建端点 / 本地模型 / 云服务共用）',
    secret: false,
    required: true,
  },
  {
    env: 'OPENAI_API_KEY',
    group: 'model',
    purpose: '模型网关访问令牌',
    secret: true,
    required: true,
  },
  {
    env: 'OPENAI_MODEL',
    group: 'model',
    purpose: '归因使用的模型名',
    secret: false,
    required: true,
  },
  {
    env: 'OPENAI_TIMEOUT_MS',
    group: 'model',
    purpose: '模型调用超时（毫秒）',
    secret: false,
    required: false,
    defaultValue: '30000',
  },
  {
    env: 'OPENAI_MAX_RETRIES',
    group: 'model',
    purpose: '模型调用最大重试次数（仅超时与 5xx 可重试）',
    secret: false,
    required: false,
    defaultValue: '1',
  },
  {
    env: 'HIS_BASE_URL',
    group: 'his',
    purpose: 'HIS 住院费用明细地址',
    secret: false,
    required: true,
  },
  {
    env: 'HIS_API_TOKEN',
    group: 'his',
    purpose: 'HIS 访问令牌',
    secret: true,
    required: true,
  },
  {
    env: 'PRICING_BASE_URL',
    group: 'pricing',
    purpose: '本院价目目录地址',
    secret: false,
    required: true,
  },
  {
    env: 'PRICING_API_TOKEN',
    group: 'pricing',
    purpose: '价目目录访问令牌',
    secret: true,
    required: true,
  },
  {
    env: 'WORKORDER_BASE_URL',
    group: 'workorder',
    purpose: '科室交办工单地址',
    secret: false,
    required: true,
  },
  {
    env: 'WORKORDER_TOKEN',
    group: 'workorder',
    purpose: '工单系统访问令牌',
    secret: true,
    required: true,
  },
  {
    env: 'IM_WEBHOOK_URL',
    group: 'im',
    purpose: '院内 IM 群机器人地址',
    secret: true,
    required: false,
  },
];

/** 分组的中文名 */
export const GROUP_LABELS: Record<SlotGroup, string> = {
  model: '模型网关',
  his: 'HIS 住院费用明细',
  pricing: '本院价目目录',
  workorder: '科室交办工单',
  im: '院内 IM 群机器人',
};

/** 单个凭据位的配置状态：只说「有没有」，不说「是什么」 */
export interface SlotStatus {
  env: string;
  group: SlotGroup;
  purpose: string;
  secret: boolean;
  required: boolean;
  configured: boolean;
}

/** 读取全部凭据位的配置状态（不回显取值） */
export function describeSlots(env: NodeJS.ProcessEnv = process.env): SlotStatus[] {
  return CREDENTIAL_SLOTS.map((slot) => ({
    env: slot.env,
    group: slot.group,
    purpose: slot.purpose,
    secret: slot.secret,
    required: slot.required,
    configured: hasValue(env[slot.env], slot),
  }));
}

/** 取凭据位的实际取值；缺值时抛 ERR_CREDENTIALS_MISSING，不静默降级到本地文件 */
export function requireSlot(env: NodeJS.ProcessEnv, slot: CredentialSlot): string {
  const raw = env[slot.env];
  if (!hasValue(raw, slot)) {
    throw new AppError(ErrorCode.CREDENTIALS_MISSING, {
      env: slot.env,
      purpose: slot.purpose,
    });
  }
  return (raw ?? '').trim();
}

/** 缺哪些必填项 */
export function missingRequiredSlots(env: NodeJS.ProcessEnv = process.env): SlotStatus[] {
  return describeSlots(env).filter((s) => s.required && !s.configured);
}

function hasValue(raw: string | undefined, slot: CredentialSlot): boolean {
  const value = (raw ?? '').trim();
  if (value.length > 0) return true;
  return slot.defaultValue !== undefined && slot.defaultValue.length > 0;
}
