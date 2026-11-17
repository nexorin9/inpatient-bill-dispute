/**
 * 口径字典装载器 —— 外置、版本化、缺项显式标「依据缺失」而非静默降级。
 *
 * 归因时把三份字典版本一并快照写入咨询单（Task 31），价目改版后历史解释稿的依据
 * 指向快照中的具体版本，不在渲染时回查当前字典。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface SettlementField {
  code: string;
  name: string;
  partition: string;
  ordinal: number;
  provenance: 'official_listed' | 'partition_inferred';
  required: boolean;
  note?: string;
}

export interface SettlementDictionary {
  _meta: { version: string; effective_from: string; total: number; partition_counts: Record<string, number>; [k: string]: unknown };
  fields: SettlementField[];
}

export interface SmartRuleSpec {
  rule_id: string;
  basis_ref: string;
  name: string;
  trigger: string;
  dictionary: string;
  severity: 'low' | 'medium' | 'high';
}

export interface NegativeListDictionary {
  _meta: { version: string; effective_from: string; smart_rule_count: number; [k: string]: unknown };
  smart_rules: SmartRuleSpec[];
  charge_definitions: Array<{ id: string; name: string; definition: string }>;
}

export interface ReconciliationSpec {
  id: string;
  basis_ref: string;
  expression: string;
  left: string[];
  right: string[];
}

export interface ReconciliationDictionary {
  _meta: { version: string; effective_from: string; group_count: number; [k: string]: unknown };
  groups: ReconciliationSpec[];
}

export interface DictionaryBundle {
  settlement: SettlementDictionary;
  negativeList: NegativeListDictionary;
  reconciliation: ReconciliationDictionary;
}

const EXPECTED_PARTITIONS: Record<string, number> = {
  基本信息: 31,
  门诊慢特病诊疗信息: 6,
  住院诊疗信息: 58,
  医疗收费信息: 98,
};

/** 官方资产里必须能对上的关键字段名（dict:check 的官方对照） */
export const OFFICIAL_ANCHOR_FIELDS = [
  '清单流水号', '姓名', '证件号码', '金额合计', '床位费', '西药费',
  '医保统筹基金支付', '补充医疗保险支付', '医疗救助支付', '个人负担', '其他支付', '个人支付',
] as const;

function readJson<T>(relative: string): T {
  const url = new URL(relative, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

export function loadDictionaries(): DictionaryBundle {
  return {
    settlement: readJson<SettlementDictionary>('./settlement-fields.json'),
    negativeList: readJson<NegativeListDictionary>('./rules/negative-list.json'),
    reconciliation: readJson<ReconciliationDictionary>('./rules/reconciliation.json'),
  };
}

export interface DictCheckReport {
  ok: boolean;
  totalFields: number;
  partitionCounts: Record<string, number>;
  smartRuleCount: number;
  chargeDefinitionCount: number;
  reconciliationGroups: number;
  versions: { settlement: string; negativeList: string; reconciliation: string };
  problems: string[];
  missingCodes: string[];
}

/** 逐项校验：条目数、编号唯一性、分区计数、官方对照、版本与生效期 */
export function checkDictionaries(bundle: DictionaryBundle = loadDictionaries()): DictCheckReport {
  const problems: string[] = [];
  const missingCodes: string[] = [];
  const fields = bundle.settlement?.fields ?? [];
  const partitionCounts: Record<string, number> = {};
  for (const field of fields) partitionCounts[field.partition] = (partitionCounts[field.partition] ?? 0) + 1;

  if (fields.length !== 193) problems.push(`结算清单条目数应为 193，实际 ${fields.length}`);
  for (const [partition, expected] of Object.entries(EXPECTED_PARTITIONS)) {
    if (partitionCounts[partition] !== expected) {
      problems.push(`分区「${partition}」应有 ${expected} 项，实际 ${partitionCounts[partition] ?? 0} 项`);
    }
  }

  const codes = new Set<string>();
  for (const field of fields) {
    if (codes.has(field.code)) problems.push(`字段编号重复：${field.code}`);
    codes.add(field.code);
    if (!field.name || !field.partition || !field.required) {
      problems.push(`字段 ${field.code} 缺名称/分区/必填标记`);
    }
  }
  // 编号连续性：缺哪个编号就点名哪个（人为删一条时用于定位）
  for (const [partition, expected] of Object.entries(EXPECTED_PARTITIONS)) {
    const prefix = { 基本信息: 'BAS', 门诊慢特病诊疗信息: 'OUT', 住院诊疗信息: 'INP', 医疗收费信息: 'FEE' }[partition]!;
    for (let i = 1; i <= expected; i += 1) {
      const code = `${prefix}-${String(i).padStart(3, '0')}`;
      if (!codes.has(code)) missingCodes.push(code);
    }
  }
  if (missingCodes.length > 0) {
    problems.push(`依据缺失：缺少字段编号 ${missingCodes.slice(0, 8).join(', ')}${missingCodes.length > 8 ? ' …' : ''}`);
  }

  const fieldNames = new Set(fields.map((f) => f.name));
  for (const anchor of OFFICIAL_ANCHOR_FIELDS) {
    if (!fieldNames.has(anchor)) problems.push(`依据缺失：官方关键字段「${anchor}」未在字典中对照到`);
  }

  const smartRules = bundle.negativeList?.smart_rules ?? [];
  if (smartRules.length !== 7) problems.push(`§4 智能审核规则应有 7 条，实际 ${smartRules.length} 条`);
  for (const rule of smartRules) {
    if (rule.rule_id !== rule.basis_ref) problems.push(`规则 ${rule.rule_id} 的依据编号与官方条目号不一致`);
  }
  const chargeDefinitions = bundle.negativeList?.charge_definitions ?? [];
  if (chargeDefinitions.length !== 3) problems.push(`§3.3 收费类定义应有 3 条，实际 ${chargeDefinitions.length} 条`);

  const groups = bundle.reconciliation?.groups ?? [];
  if (groups.length !== 2) problems.push(`勾稽关系应有 2 组，实际 ${groups.length} 组`);
  for (const group of groups) {
    if (!group.basis_ref || group.left.length === 0 || group.right.length === 0) {
      problems.push(`勾稽组 ${group.id} 缺依据出处或左右表达式`);
    }
  }

  const versions = {
    settlement: bundle.settlement?._meta?.version ?? '',
    negativeList: bundle.negativeList?._meta?.version ?? '',
    reconciliation: bundle.reconciliation?._meta?.version ?? '',
  };
  for (const [name, version] of Object.entries(versions)) {
    if (!version) problems.push(`依据缺失：${name} 字典缺版本号`);
  }
  for (const [name, dict] of Object.entries({
    settlement: bundle.settlement, negativeList: bundle.negativeList, reconciliation: bundle.reconciliation,
  })) {
    if (!dict?._meta?.effective_from) problems.push(`依据缺失：${name} 字典缺生效日期`);
  }

  return {
    ok: problems.length === 0,
    totalFields: fields.length,
    partitionCounts,
    smartRuleCount: smartRules.length,
    chargeDefinitionCount: chargeDefinitions.length,
    reconciliationGroups: groups.length,
    versions,
    problems,
    missingCodes,
  };
}

export interface VersionSnapshot {
  priceVersion: string;
  dictionaryVersion: string;
  rulesVersion: string;
  reconciliationVersion: string;
  snapshotRef: string;
}

/** 生成一次归因的版本快照标识（内容寻址，同输入同 ref） */
export function makeSnapshot(
  priceVersion: string,
  bundle: DictionaryBundle = loadDictionaries(),
  extra: Record<string, unknown> = {},
): VersionSnapshot {
  const dictionaryVersion = bundle.settlement._meta.version;
  const rulesVersion = bundle.negativeList._meta.version;
  const reconciliationVersion = bundle.reconciliation._meta.version;
  const payload = { priceVersion, dictionaryVersion, rulesVersion, reconciliationVersion, ...extra };
  const snapshotRef = 'SNAP-' + createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return { priceVersion, dictionaryVersion, rulesVersion, reconciliationVersion, snapshotRef };
}

/** 按字段编号查依据；查不到返回 undefined，由调用方标「依据缺失 → 需人工判断」 */
export function findSettlementField(
  bundle: DictionaryBundle,
  code: string,
): SettlementField | undefined {
  return bundle.settlement.fields.find((f) => f.code === code);
}

/** 按费用归集类目找到官方清单字段编号（解释稿引用 settlement_field 用） */
export function settlementFieldForFeeClass(bundle: DictionaryBundle, feeClass: string): SettlementField | undefined {
  return bundle.settlement.fields.find((f) => f.partition === '医疗收费信息' && f.name === feeClass);
}
