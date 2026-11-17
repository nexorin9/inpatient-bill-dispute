/**
 * 本院价目目录入站适配器（真实端点，须带版本号）。
 *
 * GET {PRICING_BASE_URL}/api/v1/price-items ｜ Authorization: Bearer $PRICING_API_TOKEN
 * 按 price_item_code 精确匹配；未命中一律标「依据缺失 → 需人工判断」，禁止模糊猜测。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { InsuranceAttribute, PriceBook, PriceItem } from '../domain/types.ts';
import { requestJson, type HttpOptions } from './http.ts';

const ATTRIBUTES: readonly InsuranceAttribute[] = ['甲', '乙', '自费'];

type RawPriceItem = Record<string, unknown>;

export function parsePriceItem(raw: RawPriceItem, defaultVersion: string): PriceItem {
  const get = (snake: string, camel: string): unknown => raw[snake] ?? raw[camel];
  const code = get('price_item_code', 'priceItemCode');
  const name = get('name', 'itemName') ?? get('item_name', 'itemName');
  const attribute = get('insurance_attribute', 'insuranceAttribute') as InsuranceAttribute;
  if (typeof code !== 'string' || code.length === 0) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'price_item_code' });
  }
  if (!ATTRIBUTES.includes(attribute)) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'insurance_attribute', value: String(attribute) });
  }
  const unitPrice = Number(get('unit_price', 'unitPrice'));
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'unit_price', value: String(unitPrice) });
  }
  return {
    priceItemCode: code,
    name: typeof name === 'string' ? name : code,
    insuranceAttribute: attribute,
    unitPrice,
    effectiveFrom: String(get('effective_from', 'effectiveFrom') ?? ''),
    version: String(get('version', 'version') ?? defaultVersion),
  };
}

export function parsePriceBook(raw: Record<string, unknown>): PriceBook {
  const version = String(raw.version ?? '');
  if (!version) throw new AppError(ErrorCode.EVIDENCE_MISSING, { reason: '价目目录缺版本号' });
  const items = (raw.items ?? []) as RawPriceItem[];
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(ErrorCode.PARSE_FAILED, { field: 'items', reason: '价目目录为空' });
  }
  const parsed = items.map((item) => parsePriceItem(item, version));
  const seen = new Set<string>();
  for (const item of parsed) {
    if (seen.has(item.priceItemCode)) {
      throw new AppError(ErrorCode.PARSE_FAILED, { field: 'price_item_code', value: item.priceItemCode, reason: '编码重复' });
    }
    seen.add(item.priceItemCode);
  }
  return { version, items: parsed };
}

/** 精确匹配：返回 undefined 而非猜一个近似编码 */
export function exactMatchPrice(book: PriceBook, code: string): PriceItem | undefined {
  return book.items.find((item) => item.priceItemCode === code);
}

export class PricingAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: HttpOptions;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    transport: HttpOptions = {},
  ) {
    this.env = env;
    this.transport = transport;
  }

  isConfigured(): boolean {
    return Boolean(this.env.PRICING_BASE_URL && this.env.PRICING_API_TOKEN);
  }

  async fetchPriceBook(): Promise<PriceBook> {
    if (!this.isConfigured()) {
      throw new AppError(ErrorCode.CREDENTIALS_MISSING, {
        missing: ['PRICING_BASE_URL', 'PRICING_API_TOKEN'].filter((k) => !this.env[k]),
        purpose: '本院价目目录',
      });
    }
    const base = this.env.PRICING_BASE_URL!.replace(/\/$/, '');
    const result = await requestJson<Record<string, unknown>>(`${base}/api/v1/price-items`, {
      ...this.transport,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.env.PRICING_API_TOKEN}`, ...(this.transport.headers ?? {}) },
    });
    return parsePriceBook(result.data);
  }
}
