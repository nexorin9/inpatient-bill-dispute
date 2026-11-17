/**
 * HTTP 传输层 —— 四端真实端点共用的请求装配、超时、错误归一与退避重试。
 * 产品代码只认真实协议（Authorization: Bearer / Idempotency-Key / JSON），
 * 契约测试用 tests/fixtures 下的本地协议替身，不改写这里去适配替身。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';

export interface HttpOptions {
  timeoutMs?: number;
  /** 仅超时与 5xx 重试；4xx 与解析失败不重试 */
  retries?: number;
  backoffMs?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 可注入的 fetch（兼容测试用本地协议替身时无需注入，直接改 base URL） */
  fetchImpl?: typeof fetch;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  latencyMs: number;
  retries: number;
}

function endpointDomain(url: string): string {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

export function domainOf(url: string): string {
  return endpointDomain(url);
}

/** 把传输异常归一为统一错误码；未知异常收敛为 PARSE_FAILED */
export function normalizeTransportError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|timeout|timed out/i.test(message)) {
    return new AppError(ErrorCode.TIMEOUT, { raw: message }, err);
  }
  return new AppError(ErrorCode.PARSE_FAILED, { raw: message }, err);
}

/**
 * 发一次 JSON 请求并解析。超时/5xx 按 options.retries 退避重试；
 * 4xx / JSON 解析失败 / Schema 校验失败不重试（Schema 校验由调用方做）。
 */
export async function requestJson<T>(
  url: string,
  options: HttpOptions = {},
): Promise<HttpResult<T>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = Math.max(0, Math.min(3, options.retries ?? 0));
  const backoffMs = options.backoffMs ?? 10;
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  let lastError: AppError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers ?? {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 500) {
        throw new AppError(ErrorCode.HTTP_5XX, { status: response.status, url: endpointDomain(url) });
      }
      if (response.status >= 400) {
        throw new AppError(ErrorCode.HTTP_4XX, { status: response.status, url: endpointDomain(url) });
      }

      let data: T;
      try {
        data = (await response.json()) as T;
      } catch (err) {
        throw new AppError(ErrorCode.PARSE_FAILED, { status: response.status }, err);
      }
      return { data, status: response.status, latencyMs: Date.now() - started, retries: attempt };
    } catch (err) {
      const normalized = normalizeTransportError(err);
      lastError = normalized;
      const retryable = normalized.code === ErrorCode.TIMEOUT || normalized.code === ErrorCode.HTTP_5XX;
      if (!retryable || attempt >= maxRetries) throw normalized;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
    }
  }
  throw lastError ?? new AppError(ErrorCode.PARSE_FAILED, { url });
}
