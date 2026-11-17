/**
 * 模型侧错误码归一与可审计调用元数据（Task 18）。
 *
 * 七类错误语义映射到统一错误码与可读文案，供界面提示与留痕共用；
 * 每次调用记录 model / 端点域 / tokens / latency / 重试次数 / Schema 校验结果，
 * 不记录 API key、不记录患者可识别信息。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { ModelCallMeta } from '../domain/contracts.ts';

export const MODEL_ERROR_TABLE: Record<string, { code: string; message: string; retryable: boolean }> = {
  connect_timeout: { code: ErrorCode.TIMEOUT, message: '连接模型网关超时', retryable: true },
  read_timeout: { code: ErrorCode.TIMEOUT, message: '读取模型响应超时', retryable: true },
  http_4xx: { code: ErrorCode.HTTP_4XX, message: '模型网关拒绝了请求（参数或凭据有误）', retryable: false },
  http_5xx: { code: ErrorCode.HTTP_5XX, message: '模型网关暂时不可用', retryable: true },
  json_parse: { code: ErrorCode.PARSE_FAILED, message: '模型响应不是合法 JSON', retryable: false },
  schema_invalid: { code: ErrorCode.SCHEMA_INVALID, message: '模型结构化输出不符合约定格式', retryable: false },
  credentials_missing: { code: ErrorCode.CREDENTIALS_MISSING, message: '模型网关凭据未配置', retryable: false },
};

export type ModelErrorKind = keyof typeof MODEL_ERROR_TABLE;

export function normalizeModelError(
  kind: ModelErrorKind,
  details: Record<string, unknown> = {},
  cause?: unknown,
): AppError {
  const entry = MODEL_ERROR_TABLE[kind]!;
  return new AppError(entry.code as AppError['code'], { kind, ...details }, cause);
}

/** 从响应状态码归一：4xx / 5xx 分开，便于决定是否重试 */
export function errorKindForStatus(status: number): ModelErrorKind {
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

export interface CallMetaInput {
  model: string;
  baseUrl: string;
  modelVersion?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latencyMs: number;
  retries: number;
  schemaValid: boolean;
  errorCode?: string;
}

/** 端点域（不含路径与密钥），可审计且不泄漏凭据 */
export function safeEndpointDomain(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return 'invalid-endpoint'; }
}

export function buildCallMeta(input: CallMetaInput): ModelCallMeta {
  return {
    model: input.model,
    modelVersion: input.modelVersion,
    endpointDomain: safeEndpointDomain(input.baseUrl),
    promptTokens: input.usage?.prompt_tokens,
    completionTokens: input.usage?.completion_tokens,
    totalTokens: input.usage?.total_tokens,
    latencyMs: input.latencyMs,
    retries: input.retries,
    schemaValid: input.schemaValid,
    errorCode: input.errorCode,
  };
}

/** 调用审计元数据不得含 API key 与可识别信息 */
export function assertMetaSafe(meta: ModelCallMeta): void {
  const serialized = JSON.stringify(meta);
  if (/sk-[A-Za-z0-9]{8,}|Bearer\s+\S+/i.test(serialized) || /\b\d{17}[\dXx]\b/.test(serialized)) {
    throw new Error('模型调用留痕含敏感信息，拒绝写入');
  }
}
