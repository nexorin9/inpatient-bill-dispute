/**
 * 单一 ModelGateway 客户端（OpenAI-compatible，Task 6 / 18）。
 *
 * base_url / api_key / model / timeout / max_retries 全部从环境变量读；
 * 业务层不直接耦合厂商 SDK、不硬编码端点或密钥，医院自建端点与云服务共用同一配置面。
 * 传输策略：连接与读取超时按 OPENAI_TIMEOUT_MS 控制；仅超时与 5xx 重试 ≤1 次，
 * 4xx 与 Schema 校验失败不重试。每次调用留可审计元数据（见 errors.ts）。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { ModelCallMeta, ModelResponse } from '../domain/contracts.ts';
import { buildCallMeta, errorKindForStatus, normalizeModelError } from './errors.ts';
import {
  ATTRIBUTION_SYSTEM_PROMPT,
  buildModelRequest,
  parseChatCompletion,
  type ModelRequest,
} from './schema.ts';

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    baseUrl: (env.OPENAI_BASE_URL ?? '').replace(/\/$/, ''),
    apiKey: env.OPENAI_API_KEY ?? '',
    model: env.OPENAI_MODEL ?? '',
    timeoutMs: Number.isFinite(Number(env.OPENAI_TIMEOUT_MS)) ? Number(env.OPENAI_TIMEOUT_MS) : 30_000,
    maxRetries: Math.min(1, Math.max(0, Number(env.OPENAI_MAX_RETRIES ?? 1) || 0)),
  };
}

export interface GatewayResult {
  response: ModelResponse;
  meta: ModelCallMeta;
  request: ModelRequest;
}

interface ChatRaw extends Record<string, unknown> {
  choices?: unknown;
  usage?: unknown;
}

export class ModelGateway {
  private readonly config: GatewayConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    options: { fetchImpl?: typeof fetch; config?: Partial<GatewayConfig> } = {},
  ) {
    this.config = { ...loadGatewayConfig(env), ...(options.config ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.apiKey && this.config.model);
  }

  /** 一次调用拿到结构化归因结果；失败抛归一错误码，由降级链接住 */
  async attribute(contextJson: string, systemPrompt = ATTRIBUTION_SYSTEM_PROMPT): Promise<GatewayResult> {
    if (!this.isConfigured()) {
      throw normalizeModelError('credentials_missing', {
        missing: ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL']
          .filter((key) => !this.config[key === 'OPENAI_BASE_URL' ? 'baseUrl' : key === 'OPENAI_API_KEY' ? 'apiKey' : 'model']),
      });
    }
    const request = buildModelRequest(this.config.model, contextJson, systemPrompt);
    const url = `${this.config.baseUrl}/chat/completions`;
    const started = Date.now();
    let retries = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (response.status >= 400) {
          throw normalizeModelError(errorKindForStatus(response.status), { status: response.status });
        }
        let raw: ChatRaw;
        try { raw = (await response.json()) as ChatRaw; } catch (err) {
          throw normalizeModelError('json_parse', {}, err);
        }
        const { response: parsed, usage } = parseChatCompletion(raw);
        const meta = buildCallMeta({
          model: this.config.model,
          baseUrl: this.config.baseUrl,
          usage: usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
          latencyMs: Date.now() - started,
          retries,
          schemaValid: true,
        });
        return { response: parsed, meta, request };
      } catch (err) {
        const error = err instanceof AppError ? err : normalizeModelError('json_parse', { raw: String(err) });
        const retryable = error.code === ErrorCode.TIMEOUT || error.code === ErrorCode.HTTP_5XX;
        if (!retryable || attempt >= this.config.maxRetries) {
          if (error.code === ErrorCode.SCHEMA_INVALID || error.code === ErrorCode.PARSE_FAILED) {
            // 留痕里标记 Schema 校验结果
            throw new AppError(error.code, {
              ...error.details,
              audit: buildCallMeta({
                model: this.config.model, baseUrl: this.config.baseUrl,
                latencyMs: Date.now() - started, retries, schemaValid: false,
                errorCode: error.code,
              }),
            });
          }
          throw error;
        }
        retries = attempt + 1;
      }
    }
    throw normalizeModelError('read_timeout', { retries });
  }
}
