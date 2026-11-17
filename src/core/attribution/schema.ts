/**
 * 单一 ModelGateway 的结构化输出协议（Task 6）。
 *
 * 请求装配：POST {OPENAI_BASE_URL}/chat/completions，携带 JSON Schema 约束
 * parts[{text, citation_indexes}] + attribution[{question_point, line_numbers[], category, confidence}]。
 * 响应校验失败不静默放行；业务层只依赖 ModelRequest / ModelResponse / AttributionPart 契约。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { AttributionItem, ModelResponse, ResponsePart } from '../domain/contracts.ts';

export interface ModelRequest {
  model: string;
  temperature: number;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  response_format: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
}

/** OpenAI-compatible JSON Schema（随请求发出，替身可在契约测试中逐字段断言） */
export const ATTRIBUTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['parts', 'attribution'],
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'citation_indexes'],
        properties: {
          text: { type: 'string' },
          citation_indexes: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
    attribution: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question_point', 'line_numbers', 'category', 'confidence'],
        properties: {
          question_point: { type: 'string' },
          line_numbers: { type: 'array', items: { type: 'integer', minimum: 1 } },
          category: { type: 'string', enum: ['internal_check', 'to_insurance_office', 'needs_human'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

export const RESPONSE_SCHEMA_NAME = 'inpatient_bill_attribution';

export function buildModelRequest(
  model: string,
  contextJson: string,
  systemPrompt: string,
  temperature = 0.1,
): ModelRequest {
  return {
    model,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contextJson },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: RESPONSE_SCHEMA_NAME, strict: true, schema: ATTRIBUTION_JSON_SCHEMA },
    },
  };
}

export const ATTRIBUTION_SYSTEM_PROMPT = [
  '你是住院收费处的费用口径解释助理。只描述费用口径与依据，不输出诊断或治疗建议，',
  '不承诺报销结果、不代签、不断定违规、不点名责任人。',
  '输出结构化 JSON：parts 为面向家属的解释分段（text + citation_indexes），',
  'attribution 为质疑点到明细行号的归并（含 category 与 confidence）。',
  '引用编号按依据首次出现顺序分配；不确定时把 category 标为 needs_human。',
].join('');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Schema 校验：失败抛 ERR_SCHEMA_INVALID，不静默放行 */
export function validateModelResponse(value: unknown): ModelResponse {
  if (!isRecord(value) || !Array.isArray(value.parts) || !Array.isArray(value.attribution)) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, { reason: '响应缺 parts / attribution 数组' });
  }
  const parts: ResponsePart[] = [];
  for (const [index, raw] of value.parts.entries()) {
    if (!isRecord(raw) || typeof raw.text !== 'string' || !Array.isArray(raw.citation_indexes) ||
      !raw.citation_indexes.every((n) => Number.isInteger(n) && Number(n) >= 1)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, { reason: `parts[${index}] 结构不合规` });
    }
    parts.push({ text: raw.text, citationIndexes: raw.citation_indexes as number[] });
  }
  const attribution: AttributionItem[] = [];
  for (const [index, raw] of value.attribution.entries()) {
    if (!isRecord(raw) || typeof raw.question_point !== 'string' ||
      !Array.isArray(raw.line_numbers) || !raw.line_numbers.every((n) => Number.isInteger(n)) ||
      typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1 ||
      !['internal_check', 'to_insurance_office', 'needs_human'].includes(String(raw.category))) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, { reason: `attribution[${index}] 结构不合规` });
    }
    attribution.push({
      questionPoint: raw.question_point,
      lineNumbers: raw.line_numbers as number[],
      category: raw.category as AttributionItem['category'],
      confidence: raw.confidence,
    });
  }
  return { parts, attribution };
}

/** 从 OpenAI-compatible chat/completions 响应体取出并校验结构化内容 */
export function parseChatCompletion(raw: unknown): { response: ModelResponse; usage?: Record<string, number> } {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new AppError(ErrorCode.PARSE_FAILED, { reason: 'chat/completions 响应缺 choices' });
  }
  const first = raw.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new AppError(ErrorCode.PARSE_FAILED, { reason: 'choices[0].message 缺失' });
  }
  const content = first.message.content;
  let parsed: unknown = content;
  if (typeof content === 'string') {
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { parsed = JSON.parse(cleaned); } catch (err) {
      throw new AppError(ErrorCode.PARSE_FAILED, { reason: 'message.content 不是合法 JSON' }, err);
    }
  }
  const usage = isRecord(raw.usage) ? raw.usage as unknown as Record<string, number> : undefined;
  return { response: validateModelResponse(parsed), usage };
}

/** 结构化 parts 的纯正文视图（Task 22 保真对照：正文与引用分离） */
export function plainText(parts: readonly ResponsePart[]): string {
  return parts.map((part) => part.text).join('');
}
