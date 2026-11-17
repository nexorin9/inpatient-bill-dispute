/**
 * 入站 / 出站适配器契约回归（Tasks 5 / 18 / 38 / 39）。
 * 真实端点不可达时，用本地 fetch 协议替身验证线上协议本身，不改写产品代码去适配替身。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, ErrorCode } from '../src/core/domain/errors.ts';
import { assertTripleBinding, parseBillLine, parseHisResponse } from '../src/core/adapters/his.ts';
import { exactMatchPrice, parsePriceBook } from '../src/core/adapters/pricing.ts';
import { buildImPayload, ImAdapter } from '../src/core/adapters/im.ts';
import { idempotencyKey, WorkOrderAdapter, validateHandoffRequest } from '../src/core/adapters/workorder.ts';
import { domainOf, requestJson } from '../src/core/adapters/http.ts';

const RAW_LINE = {
  line_no: 1,
  price_item_code: 'ITEM001',
  item_name: '床位费',
  amount: 100,
  fee_category: '甲类',
  fee_class: '床位费',
  occurred_at: '2026-03-02',
  dept_code: 'D001',
};

function rawResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    encounter_no: 'ZY2026000001',
    admission_date: '2026-03-01',
    discharge_date: '2026-03-10',
    lines: [RAW_LINE],
    payment: {
      total_amount: 100, insured_fund_paid: 60, supplementary_paid: 0,
      medical_aid_paid: 0, personal_burden: 40, other_paid: 0, personal_paid: 40,
    },
    ...overrides,
  };
}

test('HIS 三重绑定：住院号 / 行号 / 项目编码缺一即拒绝', () => {
  assert.doesNotThrow(() => assertTripleBinding('ZY2026000001', { lineNo: 1, priceItemCode: 'ITEM001' }));
  for (const bad of [
    { encounterNo: '', line: { lineNo: 1, priceItemCode: 'ITEM001' } },
    { encounterNo: 'ZY2026000001', line: { priceItemCode: 'ITEM001' } },
    { encounterNo: 'ZY2026000001', line: { lineNo: 1 } },
  ]) {
    assert.throws(
      () => assertTripleBinding(bad.encounterNo, bad.line),
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.BINDING_INCOMPLETE,
    );
  }
  assert.throws(
    () => parseBillLine({ ...RAW_LINE, fee_category: '丙类' }, 'ZY2026000001'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.PARSE_FAILED,
  );
});

test('HIS 响应：越界费用日期标记而不丢弃；行号重复与多候选住院拒绝', () => {
  const outOfPeriod = { ...RAW_LINE, line_no: 2, occurred_at: '2026-02-20', price_item_code: 'ITEM002' };
  const parsed = parseHisResponse(rawResponse({ lines: [RAW_LINE, outOfPeriod] }), 'ZY2026000001');
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(parsed.flags?.outOfPeriodLineNumbers, [2]);
  assert.equal(parsed.candidateCount, 1);

  assert.throws(
    () => parseHisResponse(rawResponse({ lines: [RAW_LINE, RAW_LINE] }), 'ZY2026000001'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.PARSE_FAILED,
  );
  assert.throws(
    () => parseHisResponse(rawResponse({ encounters: [rawResponse(), rawResponse()] }), 'ZY2026000001'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.AMBIGUOUS,
  );
});

test('价目目录：必须有版本号，按编码精确匹配，不做模糊猜测', () => {
  const book = parsePriceBook({
    version: 'PRICE-2026-03',
    items: [{ price_item_code: 'ITEM001', item_name: '床位费', insurance_attribute: '甲', unit_price: 20 }],
  });
  assert.equal(book.version, 'PRICE-2026-03');
  assert.equal(exactMatchPrice(book, 'ITEM001')?.priceItemCode, 'ITEM001');
  assert.equal(exactMatchPrice(book, 'ITEM00'), undefined);
  assert.throws(() => parsePriceBook({ items: [] }), (err: unknown) => err instanceof AppError);
});

test('IM 白名单：只推四字段，身份信息 / 金额一律中断推送', () => {
  const payload = buildImPayload({
    consultationNo: 'CS202611090001', priceItemCode: 'ITEM004',
    disputeCategory: 'to_insurance_office', draftNo: 'DR-0001',
  });
  assert.equal(payload.msgtype, 'markdown');
  for (const key of ['咨询编号', '收费项目编码', '争议分类', '解释稿编号']) {
    assert.ok(payload.markdown.content.includes(key));
  }
  assert.ok(!payload.markdown.content.includes('姓名'));
  assert.ok(!payload.markdown.content.includes('金额'));
  assert.throws(
    () => buildImPayload({
      consultationNo: 'CS202611090001', priceItemCode: 'ITEM004',
      disputeCategory: 'to_insurance_office', draftNo: '金额 3200 元',
    }),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.COMPLIANCE_VIOLATION,
  );
  assert.throws(
    () => buildImPayload({
      consultationNo: 'CS202611090001', priceItemCode: 'ITEM004',
      disputeCategory: 'to_insurance_office', draftNo: '姓名：张三',
    }),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.COMPLIANCE_VIOLATION,
  );
  const unconfigured = new ImAdapter({});
  assert.equal(unconfigured.isConfigured(), false);
});

test('工单写路径：幂等键稳定、5xx 指数退避重试、回执缺号不写状态、同键复用回执', async () => {
  const env = { WORKORDER_BASE_URL: 'https://workorder.example.test', WORKORDER_TOKEN: 'tok' };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let attempt = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    attempt += 1;
    if (attempt <= 2) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ work_order_no: 'WO-2026-0001', accepted_at: '2026-11-09T10:00:00.000Z' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const adapter = new WorkOrderAdapter(env, { maxRetries: 3, backoffMs: 1, transport: { fetchImpl, backoffMs: 1 } });
  assert.equal(adapter.isConfigured(), true);
  const request = {
    consultationNo: 'CS202611090001',
    encounterNo: 'ZY2026000001',
    targetDept: '医保办' as const,
    reasonCode: 'INSURANCE_ATTRIBUTE_DISPUTE',
    evidenceRefs: [{ type: 'price_item' as const, code: 'ITEM004', label: 'CT 平扫' }],
    draftSummary: '费用口径解释稿',
    submittedBy: 'clerk-01',
  };
  validateHandoffRequest(request);
  const first = await adapter.submit(request);
  assert.equal(first.ok, true);
  assert.equal(first.receipt?.workOrderNo, 'WO-2026-0001');
  assert.equal(first.retries, 2, '两个 5xx 应触发两次重试');
  assert.equal(calls.length, 3);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.equal(headers['Idempotency-Key'], first.idempotencyKey);
  assert.ok(calls[0]!.url.includes('/api/v1/consultations/CS202611090001/handoff'));

  const second = await adapter.submit(request);
  assert.equal(second.ok, true);
  assert.equal(second.retries, 0);
  assert.equal(calls.length, 3, '同幂等键重放不应再发请求');
  assert.equal(second.receipt?.workOrderNo, first.receipt?.workOrderNo);
  assert.equal(adapter.keyFor(request), idempotencyKey('ZY2026000001', 'INSURANCE_ATTRIBUTE_DISPUTE', 'ITEM004'));
  assert.notEqual(
    idempotencyKey('ZY2026000001', 'R', 'ITEM001'),
    idempotencyKey('ZY2026000001', 'R', 'ITEM002'),
  );

  const missingReceipt = new WorkOrderAdapter(env, {
    maxRetries: 0, transport: {
      fetchImpl: async () => new Response(JSON.stringify({ accepted_at: '2026-11-09T10:00:00.000Z' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    },
  });
  const bad = await missingReceipt.submit({ ...request, reasonCode: 'OTHER' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, ErrorCode.PARSE_FAILED);
  assert.equal(missingReceipt.cached(bad.idempotencyKey), undefined);
});

test('HTTP 传输层：4xx 不重试；域名解析不回显凭据', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 400 });
  };
  await assert.rejects(
    requestJson('https://his.example.test/api/v1/x', { fetchImpl, retries: 3, backoffMs: 1 }),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.HTTP_4XX,
  );
  assert.equal(calls, 1, '4xx 不应重试');
  assert.equal(domainOf('https://his.example.test:8443/api/v1/x'), 'his.example.test:8443');
});
