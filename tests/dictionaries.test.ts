/**
 * 口径字典层回归（Tasks 4 / 31）。
 * 数字必须来自官方资产的固化结果，缺项必须显式报出，不得静默降级。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OFFICIAL_ANCHOR_FIELDS,
  checkDictionaries,
  findSettlementField,
  loadDictionaries,
  makeSnapshot,
  settlementFieldForFeeClass,
} from '../src/core/dictionary/loader.ts';
import { loadConfig } from '../src/core/config.ts';

test('字典自检：193 项 / 31-6-58-98 分区 / §4 七条 / 勾稽两组', () => {
  const report = checkDictionaries();
  assert.equal(report.ok, true, report.problems.join('；'));
  assert.equal(report.totalFields, 193);
  assert.deepEqual(
    ['基本信息', '门诊慢特病诊疗信息', '住院诊疗信息', '医疗收费信息'].map((p) => report.partitionCounts[p]),
    [31, 6, 58, 98],
  );
  assert.equal(report.smartRuleCount, 7);
  assert.equal(report.chargeDefinitionCount, 3);
  assert.equal(report.reconciliationGroups, 2);
  assert.deepEqual(report.missingCodes, []);
});

test('官方关键字段锚点逐一在位，且分区推断条目被诚实标注', () => {
  const bundle = loadDictionaries();
  for (const anchor of OFFICIAL_ANCHOR_FIELDS) {
    assert.ok(bundle.settlement.fields.some((f) => f.name === anchor), `官方关键字段缺失：${anchor}`);
  }
  const official = bundle.settlement.fields.filter((f) => f.provenance === 'official_listed');
  const inferred = bundle.settlement.fields.filter((f) => f.provenance === 'partition_inferred');
  assert.ok(official.length > 0, '应存在官方原文收录的关键字段');
  assert.ok(inferred.length > 0, '应存在按官方分区补位、明确标注的条目');
  assert.equal(official.length + inferred.length, 193);
  assert.ok(inferred.every((f) => typeof f.note === 'string' && f.note.length > 0));
  const first = bundle.settlement.fields[0]!;
  assert.equal(findSettlementField(bundle, first.code)?.code, first.code);
  assert.equal(findSettlementField(bundle, 'NOT-A-CODE'), undefined);
});

test('人为删掉一个官方关键字段 → 自检不通过且精确报出缺失编号', () => {
  const bundle = loadDictionaries();
  const removed = OFFICIAL_ANCHOR_FIELDS[0]!;
  const broken = {
    ...bundle,
    settlement: {
      ...bundle.settlement,
      fields: bundle.settlement.fields.filter((f) => f.name !== removed),
    },
  };
  const report = checkDictionaries(broken);
  assert.equal(report.ok, false);
  assert.equal(report.missingCodes.length, 1);
  assert.ok(report.problems.some((p) => p.includes(removed)));
  assert.ok(report.problems.some((p) => p.includes('依据缺失')));
});

test('版本快照固定三份字典版本，同输入得到同一内容寻址 ref', () => {
  const bundle = loadDictionaries();
  const snap = makeSnapshot('PRICE-2026-03', bundle);
  assert.equal(snap.priceVersion, 'PRICE-2026-03');
  assert.equal(snap.dictionaryVersion, bundle.settlement._meta.version);
  assert.equal(snap.rulesVersion, bundle.negativeList._meta.version);
  assert.equal(snap.reconciliationVersion, bundle.reconciliation._meta.version);
  assert.ok(snap.snapshotRef.startsWith('SNAP-'));
  assert.equal(makeSnapshot('PRICE-2026-03', bundle).snapshotRef, snap.snapshotRef);
  assert.notEqual(makeSnapshot('PRICE-2026-04', bundle).snapshotRef, snap.snapshotRef);
});

test('费用归集类目 ↔ 结算清单字段可查；阈值配置有默认值', () => {
  const bundle = loadDictionaries();
  const fee = settlementFieldForFeeClass(bundle, '床位费');
  assert.ok(fee, '官方收费分区应能查到「床位费」字段');
  assert.equal(fee.partition, '医疗收费信息');
  assert.equal(settlementFieldForFeeClass(bundle, '不存在的项目'), undefined);
  const config = loadConfig({});
  assert.ok(config.minConfidence > 0 && config.minConfidence < 1);
  assert.ok(config.maxExplanationChars > 0);
  assert.equal(config.citationsEnabled, true);
});
