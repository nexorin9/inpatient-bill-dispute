/**
 * 归因引擎 B 段回归（Tasks 6/7/18/19/20/21/22/23/24/25/26/27/33）。
 * 模型端点用本地 fetch 协议替身；报告明确标注这不是真实模型推理。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, ErrorCode } from '../src/core/domain/errors.ts';
import type { AttributionItem, ExplanationPart } from '../src/core/domain/contracts.ts';
import { loadConfig } from '../src/core/config.ts';
import { loadDictionaries } from '../src/core/dictionary/loader.ts';
import { loadSampleEncounters, loadSamplePriceBook } from '../src/core/adapters/samples.ts';

import {
  parseChineseNumber, parseSpokenAmount, extractQuestionPointsHeuristic,
  validateQuestionPoints,
} from '../src/core/attribution/question-points.ts';
import {
  ATTRIBUTION_JSON_SCHEMA, buildModelRequest, parseChatCompletion,
  plainText, validateModelResponse,
} from '../src/core/attribution/schema.ts';
import { ModelGateway } from '../src/core/attribution/model-gateway.ts';
import {
  assertContextSafe, buildAttributionContext, contextToJson,
  desensitizeText, maskEncounterNoFixed,
} from '../src/core/attribution/desensitize.ts';
import { mergeAttribution } from '../src/core/attribution/merge.ts';
import { CitationAllocator, buildExplanation, hasBareCitationNumber, renderPartBody } from '../src/core/attribution/explanation.ts';
import { applyAmbiguityPolicy, detectMutuallyExclusive } from '../src/core/attribution/ambiguity.ts';
import { explanationLength, rewriteIfOversized } from '../src/core/attribution/rewrite.ts';
import { checkCompliance, scanText } from '../src/core/attribution/compliance.ts';
import {
  DEGRADED_ALLOWED_STATUSES, allowedDegradedStatus, assertDegradedStatus, buildBaseline,
  degradationRecord,
} from '../src/core/attribution/baseline.ts';
import { assertReproducible, runBenchmark } from '../src/core/attribution/benchmark.ts';
import { assertScaleInvariants, runScaleAcceptance } from '../src/core/attribution/batch.ts';
import { buildCallMeta, assertMetaSafe, safeEndpointDomain } from '../src/core/attribution/errors.ts';

const BILL = loadSampleEncounters()[0]!;
const PRICE_BOOK = loadSamplePriceBook();
const BUNDLE = loadDictionaries();
const CONFIG = loadConfig({});

function part(overrides: Partial<ExplanationPart> = {}): ExplanationPart {
  return {
    lineNumbers: [1], what: '床位费', why: '按本院价目口径结算',
    citationIndexes: [], needsHuman: false, evidenceMissing: false,
    category: 'internal_check', protected: false, text: '床位费按价目口径结算',
    ...overrides,
  };
}

test('质疑点抽取：中文数字 / 口述金额 / 寒暄不调模型 / 原话回指校验', () => {
  assert.equal(parseChineseNumber('三千二'), 3200);
  assert.equal(parseChineseNumber('三百二'), 320);
  assert.equal(parseChineseNumber('一万二'), 12000);
  assert.equal(parseChineseNumber('三千二百'), 3200);
  assert.equal(parseChineseNumber('一万二千'), 12000);
  assert.equal(parseSpokenAmount('多出来3200 元')?.min, 3200 * 0.95);
  assert.equal(parseSpokenAmount('大概三千二')?.uncertain, true);
  assert.deepEqual(extractQuestionPointsHeuristic('您好'), []);
  const text = '上次多算了3200 元，病房的钱怎么这么贵？';
  const points = extractQuestionPointsHeuristic(text);
  assert.ok(points.length >= 1);
  assert.ok(points.every((p) => text.slice(p.charStart, p.charEnd) === p.sourceQuote));
  const validated = validateQuestionPoints(text, points);
  assert.equal(validated.rejected.length, 0);
  const bad = validateQuestionPoints(text, [{ ...points[0]!, sourceQuote: '不在原话里' }]);
  assert.equal(bad.rejected.length, 1);
  assert.equal(bad.rejected[0]!.code, ErrorCode.SCHEMA_INVALID);
});

test('结构化输出协议：json_schema strict / Schema 校验 / 代码块包裹的响应解析', () => {
  const req = buildModelRequest('qwen-test', '{}', 'system');
  assert.equal(req.response_format.type, 'json_schema');
  assert.equal(req.response_format.json_schema.strict, true);
  assert.equal(req.response_format.json_schema.schema, ATTRIBUTION_JSON_SCHEMA);
  const valid = {
    parts: [{ text: '按价目口径结算', citation_indexes: [1] }],
    attribution: [{ question_point: '床位费', line_numbers: [1], category: 'internal_check', confidence: 0.9 }],
  };
  assert.equal(validateModelResponse(valid).parts[0]!.citationIndexes[0], 1);
  assert.throws(() => validateModelResponse({ parts: [], attribution: [{}] }),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.SCHEMA_INVALID);
  const parsed = parseChatCompletion({
    choices: [{ message: { content: '```json\n' + JSON.stringify(valid) + '\n```' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(plainText(parsed.response.parts), '按价目口径结算');
  assert.equal(parsed.usage?.total_tokens, 15);
  assert.throws(() => parseChatCompletion({ choices: [] }),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.PARSE_FAILED);
});

test('ModelGateway：凭据缺失报错 / 成功调用可审计 / 5xx 重试 / 4xx 与 Schema 失败不重试', async () => {
  const empty = new ModelGateway({});
  assert.equal(empty.isConfigured(), false);
  await assert.rejects(empty.attribute('{}'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.CREDENTIALS_MISSING);

  const env = { OPENAI_BASE_URL: 'https://llm.example.test/v1', OPENAI_API_KEY: 'sk-test-key', OPENAI_MODEL: 'qwen-test' };
  const validBody = {
    choices: [{ message: { content: JSON.stringify({
      parts: [{ text: '说明', citation_indexes: [1] }],
      attribution: [{ question_point: 'p', line_numbers: [1], category: 'internal_check', confidence: 0.9 }],
    }) } }],
    usage: { total_tokens: 10 },
  };
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const okFetch: typeof fetch = async (url, init) => {
    seen.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return new Response(JSON.stringify(validBody), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const gateway = new ModelGateway(env, { fetchImpl: okFetch, config: { maxRetries: 1 } });
  const result = await gateway.attribute('{"masked_encounter_no":"****0001"}');
  assert.equal(result.response.parts.length, 1);
  assert.equal(result.meta.model, 'qwen-test');
  assert.equal(result.meta.schemaValid, true);
  assert.doesNotThrow(() => assertMetaSafe(result.meta));
  assert.equal(result.meta.endpointDomain, safeEndpointDomain(env.OPENAI_BASE_URL));
  assert.equal(seen[0]!.headers.Authorization, 'Bearer sk-test-key');
  assert.ok(seen[0]!.url.endsWith('/chat/completions'));
  assert.ok(!JSON.stringify(result.meta).includes('sk-test-key'), '留痕不得含密钥');

  let calls5xx = 0;
  const flaky: typeof fetch = async () => {
    calls5xx += 1;
    if (calls5xx === 1) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(validBody), { status: 200 });
  };
  const retried = await new ModelGateway(env, { fetchImpl: flaky, config: { maxRetries: 1 } }).attribute('{}');
  assert.equal(retried.meta.retries, 1);
  assert.equal(calls5xx, 2);

  let calls4xx = 0;
  const bad4xx: typeof fetch = async () => { calls4xx += 1; return new Response('{}', { status: 401 }); };
  await assert.rejects(new ModelGateway(env, { fetchImpl: bad4xx, config: { maxRetries: 1 } }).attribute('{}'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.HTTP_4XX);
  assert.equal(calls4xx, 1, '4xx 不重试');

  let callsSchema = 0;
  const badSchema: typeof fetch = async () => {
    callsSchema += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"parts":[]}' } }] }), { status: 200 });
  };
  await assert.rejects(new ModelGateway(env, { fetchImpl: badSchema, config: { maxRetries: 1 } }).attribute('{}'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.SCHEMA_INVALID);
  assert.equal(callsSchema, 1, 'Schema 失败不重试');

  const meta = buildCallMeta({ model: 'm', baseUrl: 'https://llm.example.test/v1', latencyMs: 1, retries: 0, schemaValid: true });
  assert.doesNotThrow(() => assertMetaSafe(meta));
  assert.throws(() => assertMetaSafe({ ...meta, errorCode: 'Bearer sk-abcdef123456' } as typeof meta));
});

test('脱敏上下文：身份原值不进模型，住院号只留后四位，摘要可复核', () => {
  assert.equal(maskEncounterNoFixed('ZY2026000001'), '****0001');
  const cleaned = desensitizeText('姓名：张三 证件号 110101199001011234 电话 13800138000 床号：12床');
  assert.ok(!cleaned.includes('张三'));
  assert.ok(!cleaned.includes('110101199001011234'));
  assert.ok(!cleaned.includes('13800138000'));
  const context = buildAttributionContext({
    bill: { ...BILL, patientName: '张三', idCardNo: '110101199001011234', bedNo: '12床' },
    priceItems: PRICE_BOOK.items,
    ruleHits: [],
    requestText: cleaned,
  });
  assert.doesNotThrow(() => assertContextSafe(context));
  const json = contextToJson(context);
  assert.ok(!json.includes('张三') && !json.includes('110101199001011234'));
  assert.ok(json.includes('****0001'));
});

test('n:m 归并：一点多行 / 多点一行，越界行号拒收并记错误码', () => {
  const items: AttributionItem[] = [
    { questionPoint: '病房和化验', lineNumbers: [1, 2], category: 'internal_check', confidence: 0.9 },
    { questionPoint: '手术', lineNumbers: [2, 3], category: 'internal_check', confidence: 0.8 },
  ];
  const ok = mergeAttribution(items, [1, 2, 3]);
  assert.equal(ok.matches.length, 2);
  assert.deepEqual(ok.lineToPoints[2], ['病房和化验', '手术']);
  assert.equal(ok.partial, false);
  const bad = mergeAttribution([{ ...items[0]!, lineNumbers: [1, 999] }], [1, 2, 3]);
  assert.equal(bad.matches.length, 0);
  assert.equal(bad.outOfBounds[0]!.code, ErrorCode.OUT_OF_BOUNDS);
  assert.deepEqual(bad.outOfBounds[0]!.invalidLineNumbers, [999]);
  assert.equal(bad.partial, true);
});

test('引用编号：白名单类型 / 首次出现递增 / 同依据复用 / 关闭引用无裸编号 / 零漏行', () => {
  const alloc = new CitationAllocator();
  const ref = { type: 'price_item' as const, code: 'ITEM001', label: '床位费' };
  assert.equal(alloc.allocate(ref, [1]), 1);
  assert.equal(alloc.allocate(ref, [2]), 1);
  assert.equal(alloc.allocate({ ...ref, code: 'ITEM002' }, [3]), 2);
  assert.equal(alloc.allocate({ type: 'diagnosis' as never, code: 'X', label: '越权类型' }), undefined);
  assert.equal(alloc.rejected.length, 1);
  assert.doesNotThrow(() => alloc.assertStrictlyIncreasing());

  const matches = BILL.lines.map((line) => ({
    questionPoint: `行 ${line.lineNo}`, lineNumbers: [line.lineNo],
    category: 'internal_check' as const, confidence: 1,
  }));
  const built = buildExplanation({
    bill: BILL, priceBook: PRICE_BOOK, bundle: BUNDLE, matches,
    ruleHits: [], citationsEnabled: true,
    evidenceMissingLineNumbers: [BILL.lines[0]!.lineNo],
  });
  assert.equal(built.parts.length, BILL.lines.length, '零漏行：每行都要有解释条目');
  assert.ok(built.citations.length > 0);
  assert.ok(built.citations.every((c, i) => c.index === i + 1));
  assert.ok(built.parts.some((p) => p.evidenceMissing && p.needsHuman));
  const off = buildExplanation({
    bill: BILL, priceBook: PRICE_BOOK, bundle: BUNDLE, matches,
    ruleHits: [], citationsEnabled: false,
  });
  assert.ok(off.parts.every((p) => !hasBareCitationNumber(renderPartBody(p, off.citations, false))));
});

test('置信度阈值与歧义：低分拒答、互斥候选列出、被拒条目隔离', () => {
  const cfg = { minConfidence: 0.75, confidenceMargin: 0.05 };
  const outcome = applyAmbiguityPolicy([
    { questionPoint: '低分', lineNumbers: [1], category: 'internal_check', confidence: 0.4 },
    { questionPoint: '高分', lineNumbers: [2], category: 'internal_check', confidence: 0.95 },
  ], cfg, { unmatched: ['完全没匹配上'] });
  assert.equal(outcome.accepted.length, 1);
  assert.equal(outcome.refusals.length, 2);
  assert.ok(outcome.isolated.every((i) => i.category === 'needs_human'));
  assert.equal(detectMutuallyExclusive([{
    questionPoint: '互斥', scores: [
      { lineNumbers: [1], confidence: 0.9 }, { lineNumbers: [2], confidence: 0.89 },
    ],
  }], 0.05).get('互斥')?.length, 2);
});

test('超长重写：压缩后仍超长则裁剪非保护项，保护项恒保留', () => {
  const long = Array.from({ length: 12 }, (_, i) => part({
    lineNumbers: [i + 1], what: '项目'.repeat(30), why: '说明'.repeat(30),
    text: '这是一段很长的家属可读说明文字'.repeat(8), confidence: 0.9,
  }));
  long.push(part({ lineNumbers: [99], protected: true, needsHuman: true, text: '需人工判断条目不可裁剪' }));
  const out = rewriteIfOversized(long, [], { maxExplanationChars: 300 });
  assert.ok(explanationLength(out.parts) <= 300);
  assert.ok(out.parts.some((p) => p.protected));
  assert.ok(out.charsAfter < out.charsBefore);
  assert.equal(out.finalLengthOk, true);
  assert.ok(out.compressed || out.trimmedLineNumbers.length > 0);
});

test('禁语合规：正文与结构化字段都扫，命中即拒发', () => {
  assert.equal(scanText('按价目口径结算', 'parts[0].text').length, 0);
  const verdict = checkCompliance({
    parts: [part({ text: '这属于违规收费，我可以代签并承诺报销' })],
    structured: { category: 'internal_check' },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errorCode, ErrorCode.COMPLIANCE_VIOLATION);
  assert.ok(verdict.blockedPartIndexes.includes(0));
  assert.equal(checkCompliance({
    parts: [part()], structured: { category: 'made_up_value' },
  }).ok, false);
});

test('降级链：只出确定性产物，状态只允许草稿待确认 / 待答复', () => {
  const baseline = buildBaseline({ bill: BILL, priceBook: PRICE_BOOK, bundle: BUNDLE, config: CONFIG, dataSource: 'samples' });
  assert.equal(baseline.source, 'deterministic_baseline');
  assert.equal(baseline.parts.length, BILL.lines.length);
  assert.equal(
    baseline.coveredLineNumbers.length + baseline.evidenceMissingLineNumbers.length,
    BILL.lines.length,
  );
  assert.deepEqual([...DEGRADED_ALLOWED_STATUSES], ['draft_pending_confirm', 'pending_reply']);
  assert.doesNotThrow(() => assertDegradedStatus('draft_pending_confirm'));
  assert.throws(() => assertDegradedStatus('answered'));
  assert.equal(allowedDegradedStatus('answered'), 'draft_pending_confirm');
  const record = degradationRecord(new AppError(ErrorCode.TIMEOUT, {}), 1);
  assert.equal(record.retries, 1);
  assert.ok(record.failureType);
});

test('对照基准与规模验收：两次重跑一致，语义路径优于纯规则基线，规模不变量成立', () => {
  const a = runBenchmark({ writeReport: false });
  const b = runBenchmark({ writeReport: false });
  assert.doesNotThrow(() => assertReproducible(a, b));
  assert.equal(a.model_path.sampleSize, 48);
  assert.equal(a.baseline_path.sampleSize, 48);
  assert.ok(a.model_path.coverage > a.baseline_path.coverage);
  assert.ok(a.model_path.misattribution <= a.baseline_path.misattribution);
  assert.ok(a._meta.model_path_note.includes('协议替身') || a._meta.model_path_note.includes('本地语义归并器'));

  const scale = runScaleAcceptance({ writeReport: false });
  assert.doesNotThrow(() => assertScaleInvariants(scale));
  assert.ok(scale.lineCount >= 300);
  assert.ok(scale.elapsedMs <= 5000);
});
