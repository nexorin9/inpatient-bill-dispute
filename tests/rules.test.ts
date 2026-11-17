/**
 * 守门规则层 C 段回归（Tasks 8 / 9 / 28 / 29 / 30 / 31 / 32）。
 * 规则只给命中条目与依据编号，不给自由文本；缺依据必须显式标「依据缺失」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, ErrorCode } from '../src/core/domain/errors.ts';
import type { RuleHit } from '../src/core/domain/contracts.ts';
import { loadDictionaries, makeSnapshot } from '../src/core/dictionary/loader.ts';
import { loadQcCases, loadSampleEncounters, loadSamplePriceBook } from '../src/core/adapters/samples.ts';
import { createRepositories, openStore } from '../src/db/index.ts';

import { RuleRegistry, hasFreeText, missingEvidenceHit, runRules } from '../src/core/rules/engine.ts';
import { SMART_RULE_IDS, createDefaultRuleRegistry } from '../src/core/rules/index.ts';
import { reconcile, reconcileLinesToTotal, toCents } from '../src/core/rules/reconciliation.ts';
import { assertGuardrailBinding, checkLine, guardrailHits } from '../src/core/rules/guardrail.ts';
import { arbitrate, isNeedsHuman, isOutboundAllowed, ruleOnlyCategory } from '../src/core/rules/classification.ts';
import { QC_CHECKS, runQcCases, summarizeQc } from '../src/core/rules/qc-cases.ts';
import { buildSnapshotPayload, reproduceSnapshot } from '../src/core/rules/snapshot.ts';

const BILL = loadSampleEncounters()[0]!;
const BOOK = loadSamplePriceBook();
const BUNDLE = loadDictionaries();

function ruleHit(overrides: Partial<RuleHit> = {}): RuleHit {
  return {
    ruleId: '§4-1', basisRef: '§4-1', severity: 'low',
    evidence: {}, ...overrides,
  };
}

test('规则引擎：无依据编号拒绝注册 / 重复编号拒绝 / 按生效版本取用 / 无自由文本', () => {
  const registry = new RuleRegistry('RULES-2026-03');
  assert.throws(() => registry.register({
    id: 'NO-BASIS', basisRef: '', severity: 'low', effectiveVersion: 'RULES-2026-03', predicate: () => [],
  }), (err: unknown) => err instanceof AppError && err.code === ErrorCode.EVIDENCE_MISSING);
  const rule = {
    id: 'R1', basisRef: '§3.3-1', severity: 'low' as const,
    effectiveVersion: 'RULES-2026-01', predicate: () => [ruleHit()],
  };
  registry.register(rule);
  assert.throws(() => registry.register(rule),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.EVIDENCE_MISSING);
  assert.equal(registry.active('RULES-2026-01').length, 1);
  assert.equal(registry.active('RULES-2025-12').length, 0);
  const hits = runRules({ bill: BILL, bundle: BUNDLE }, registry);
  assert.equal(hits.length, 1);
  assert.equal(hasFreeText(hits[0]!), false);
});

test('§4 七条规则全部注册且各有官方依据编号；缺字典时输出「依据缺失」', () => {
  const registry = createDefaultRuleRegistry();
  assert.equal(SMART_RULE_IDS.length, 7);
  const active = registry.active();
  assert.equal(active.length, 7);
  assert.ok(active.every((r) => r.basisRef.startsWith('§4-')));
  const missing = missingEvidenceHit('§4-1', '§4-1', '负面清单');
  assert.equal(missing.evidenceMissing, true);
  assert.equal(missing.missingDictionary, '负面清单');
  assert.equal(hasFreeText(missing), false);
});

test('金额勾稽双向校验：平衡不命中；任一口径失衡精确报出差额（按分）', () => {
  const balanced = {
    totalAmount: 100, insuredFundPaid: 60, supplementaryPaid: 0, medicalAidPaid: 0,
    personalBurden: 40, otherPaid: 10, personalPaid: 30,
  };
  assert.deepEqual(reconcile(balanced, 0, BUNDLE.reconciliation), []);
  assert.equal(toCents(100.005), 10001);
  const broken = { ...balanced, insuredFundPaid: 57.5 };
  const hits = reconcile(broken, 0, BUNDLE.reconciliation);
  assert.equal(hits.length, 2, '自上而下与自下而上双向都应命中');
  assert.ok(hits.some((h) => h.direction === 'top_down'));
  assert.ok(hits.some((h) => h.direction === 'bottom_up'));
  assert.ok(hits.every((h) => h.basisRef.includes('38号')));
  const split = reconcile({ ...balanced, personalPaid: 20 }, 0, BUNDLE.reconciliation);
  assert.equal(split.length, 1);
  assert.equal(split[0]!.direction, 'personal_split');
  assert.deepEqual(reconcile(broken, 1000, BUNDLE.reconciliation), [], '容差内不误报');
  assert.equal(reconcileLinesToTotal([40, 60], 100, 0), undefined);
  assert.equal(reconcileLinesToTotal([40, 60], 99, 0)?.diffCents, 100);
});

test('医保属性 / 价目版本守门：编码未命中即依据缺失，三重绑定缺一即拒绝', () => {
  const missingCode = checkLine({ lineNo: 1, priceItemCode: 'NOT-IN-BOOK', feeCategory: '甲类' }, BOOK);
  assert.equal(missingCode.evidenceMissing, true);
  assert.equal(checkLine({ lineNo: 1, priceItemCode: 'NOT-IN-BOOK', feeCategory: '甲类' }, undefined).evidenceMissing, true);
  const known = BILL.lines.find((l) => BOOK.items.some((i) => i.priceItemCode === l.priceItemCode))!;
  const verdict = checkLine(known, BOOK);
  assert.equal(verdict.lineNo, known.lineNo);
  assert.doesNotThrow(() => assertGuardrailBinding(BILL));
  assert.throws(() => assertGuardrailBinding({ ...BILL, lines: [{ ...known, priceItemCode: '' }] }),
    (err: unknown) => err instanceof AppError);
  const hits = guardrailHits({ bill: BILL, priceBook: BOOK, bundle: BUNDLE });
  assert.ok(Array.isArray(hits));
});

test('三值分类融合：依据缺失 / 歧义判需人工；高风险判需转医保办；模型冲突以规则为准', () => {
  const base = { ruleHits: [ruleHit()], reconciliationHits: [] };
  const plain = ruleOnlyCategory(base);
  assert.equal(plain.category, 'internal_check');
  assert.equal(isOutboundAllowed('internal_check'), true);
  assert.equal(isOutboundAllowed('needs_human'), false);
  assert.equal(isNeedsHuman('needs_human'), true);
  const missing = ruleOnlyCategory({ ...base, evidenceMissingCount: 2 });
  assert.equal(missing.category, 'needs_human');
  const ambiguous = ruleOnlyCategory({ ...base, ambiguous: true });
  assert.equal(ambiguous.category, 'needs_human');
  const highRisk = ruleOnlyCategory({
    ruleHits: [ruleHit({ ruleId: '§4-6', basisRef: '§4-6', severity: 'high' })],
    reconciliationHits: [],
  });
  assert.equal(highRisk.category, 'to_insurance_office');
  const conflict = arbitrate({ ...base, evidenceMissingCount: 2, modelCategory: 'internal_check' });
  assert.equal(conflict.category, 'needs_human');
  assert.equal(conflict.arbitration?.finalCategory, 'needs_human');
  assert.equal(conflict.arbitration?.modelCategory, 'internal_check');
  assert.throws(() => ruleOnlyCategory({ ruleHits: [], reconciliationHits: [] }),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.EVIDENCE_MISSING);
});

test('官方质控 8 例全命中；人为破坏一条校验即出现可定位失败', () => {
  const cases = loadQcCases();
  assert.equal(cases.length, 8);
  assert.equal(Object.keys(QC_CHECKS).length, 8);
  const results = runQcCases(cases);
  assert.equal(summarizeQc(results).passed, 8);
  const broken = runQcCases(cases, { breakCheck: '主诊断唯一性' });
  assert.equal(summarizeQc(broken).passed, 7);
  assert.ok(summarizeQc(broken).failed.length === 1);
  assert.ok(broken.some((r) => r.reason.includes('人为破坏')));
});

test('版本快照原样重放：解释稿 parts / 引用 / 规则命中与当时版本逐字一致', () => {
  const repos = createRepositories(openStore(':memory:'));
  const versions = makeSnapshot('PRICE-2026-03', BUNDLE);
  const citations = [{
    index: 1, type: 'price_item' as const, code: 'ITEM001', label: '床位费', lineNumbers: [1],
  }];
  const parts = [{
    lineNumbers: [1], what: '床位费', why: '按价目口径结算', citationIndexes: [1],
    needsHuman: false, evidenceMissing: false, category: 'internal_check' as const,
    protected: false, text: '当时那句解释',
  }];
  const payload = buildSnapshotPayload(versions, {
    citations, parts, ruleHits: [ruleHit()],
    evidenceRefs: [{ type: 'price_item', code: 'ITEM001', label: '床位费' }],
    priceItemCodes: ['ITEM001', 'ITEM001'],
  });
  repos.snapshots.save(versions.snapshotRef, payload as unknown as Record<string, unknown>);
  const reproduction = reproduceSnapshot(repos.snapshots, versions.snapshotRef);
  assert.deepEqual(reproduction.citations, payload.citations);
  assert.deepEqual(reproduction.parts, parts);
  assert.equal(reproduction.versions.priceVersion, 'PRICE-2026-03');
  assert.equal(reproduction.versions.dictionaryVersion, BUNDLE.settlement._meta.version);
  assert.throws(() => reproduceSnapshot(repos.snapshots, 'SNAP-MISSING'),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.EVIDENCE_MISSING);
  assert.throws(() => reproduceSnapshot(repos.snapshots, undefined),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.EVIDENCE_MISSING);
  repos.store.close();
});
