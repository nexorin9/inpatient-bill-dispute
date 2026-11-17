/**
 * 医保违规负面清单 §4 七条智能审核规则化（依据编号照抄官方条目号）。
 *
 * 每条带可核对的触发条件；条件依赖院内字典，字典缺项时输出
 * 「依据缺失 → 需人工判断」并写明缺哪本字典，而不是默认通过。
 */

import type { RuleHit } from '../domain/contracts.ts';
import type { BillLine } from '../domain/types.ts';
import { hit, missingEvidenceHit, type RuleContext, type RuleRegistry } from './engine.ts';

export const SMART_RULE_IDS = [
  '§4-1', '§4-2', '§4-3', '§4-4', '§4-5', '§4-6', '§4-7',
] as const;

const RULE_VERSION = 'RULES-2026-03';

/** §4-1 非目录审核：明细编码在本院价目目录中不存在即命中，依据可回指价目版本 */
export function checkNonCatalog(ctx: RuleContext): RuleHit[] {
  if (!ctx.priceBook) {
    return [missingEvidenceHit('§4-1', '§4-1', '本院价目目录')];
  }
  const codes = new Set(ctx.priceBook.items.map((item) => item.priceItemCode));
  return ctx.bill.lines
    .filter((line) => !codes.has(line.priceItemCode))
    .map((line) => hit(
      { id: '§4-1', basisRef: '§4-1', severity: 'high' },
      line.lineNo,
      { price_item_code: line.priceItemCode, price_version: ctx.priceBook!.version, reason_code: 'NOT_IN_CATALOG' },
    ));
}

/** §4-2 限定适应症用药：字典缺项 → 依据缺失 */
export function checkIndication(ctx: RuleContext): RuleHit[] {
  const indications = ctx.dictionaries?.indications;
  if (!indications || !ctx.dictionaries?.actualIndication) {
    return [missingEvidenceHit('§4-2', '§4-2', '医保药品目录备注（限定适应症）')];
  }
  return ctx.bill.lines
    .filter((line) => {
      const allowed = indications[line.priceItemCode];
      return Boolean(allowed) && allowed !== ctx.dictionaries?.actualIndication;
    })
    .map((line) => hit(
      { id: '§4-2', basisRef: '§4-2', severity: 'high' },
      line.lineNo,
      { price_item_code: line.priceItemCode, required: indications[line.priceItemCode], actual: ctx.dictionaries?.actualIndication },
    ));
}

/** §4-3 限定医院类型级别 */
export function checkHospitalLevel(ctx: RuleContext): RuleHit[] {
  const dict = ctx.dictionaries;
  if (!dict?.requiredHospitalLevel || !dict.hospitalLevel) {
    return [missingEvidenceHit('§4-3', '§4-3', '机构级别字典')];
  }
  if (dict.hospitalLevel === dict.requiredHospitalLevel) return [];
  return ctx.bill.lines.map((line) => hit(
    { id: '§4-3', basisRef: '§4-3', severity: 'medium' },
    line.lineNo,
    { required_level: dict.requiredHospitalLevel, actual_level: dict.hospitalLevel },
  ));
}

/** §4-4 限儿童 */
export function checkChildLimit(ctx: RuleContext): RuleHit[] {
  const limits = ctx.dictionaries?.itemLimits;
  const age = ctx.dictionaries?.patientAge;
  if (!limits || age === undefined) {
    return [missingEvidenceHit('§4-4', '§4-4', '年龄口径字典（患者年龄与目录限儿童标记）')];
  }
  return ctx.bill.lines
    .filter((line) => {
      const limit = limits[line.priceItemCode];
      if (!limit) return false;
      return (limit.maxAge !== undefined && age > limit.maxAge) ||
        (limit.minAge !== undefined && age < limit.minAge);
    })
    .map((line) => hit(
      { id: '§4-4', basisRef: '§4-4', severity: 'medium' },
      line.lineNo,
      { patient_age: age, limit: limits[line.priceItemCode], price_item_code: line.priceItemCode },
    ));
}

/** §4-5 限定性别 */
export function checkGenderLimit(ctx: RuleContext): RuleHit[] {
  const limits = ctx.dictionaries?.itemLimits;
  const gender = ctx.dictionaries?.patientGender;
  if (!limits || !gender) {
    return [missingEvidenceHit('§4-5', '§4-5', '性别限定字典（患者性别与目录性别限定标记）')];
  }
  return ctx.bill.lines
    .filter((line) => {
      const limit = limits[line.priceItemCode];
      return Boolean(limit?.gender) && limit!.gender !== gender;
    })
    .map((line) => hit(
      { id: '§4-5', basisRef: '§4-5', severity: 'medium' },
      line.lineNo,
      { patient_gender: gender, required_gender: limits[line.priceItemCode]?.gender },
    ));
}

/** §4-6 费用日期不在住院期间：越出区间即命中，依据条目号照抄官方编号 */
export function checkFeeDateOutOfPeriod(ctx: RuleContext): RuleHit[] {
  const { admissionDate, dischargeDate } = ctx.bill;
  if (!admissionDate || !dischargeDate) {
    return [missingEvidenceHit('§4-6', '§4-6', '住院登记（入院/出院日期）')];
  }
  return ctx.bill.lines
    .filter((line) => line.occurredAt < admissionDate || line.occurredAt > dischargeDate)
    .map((line) => hit(
      { id: '§4-6', basisRef: '§4-6', severity: 'high' },
      line.lineNo,
      { occurred_at: line.occurredAt, admission_date: admissionDate, discharge_date: dischargeDate },
    ));
}

/** §4-7 超限定频次 */
export function checkFrequency(ctx: RuleContext): RuleHit[] {
  const limits = ctx.dictionaries?.itemLimits;
  const observed = ctx.dictionaries?.observedFrequency;
  if (!limits || !observed) {
    return [missingEvidenceHit('§4-7', '§4-7', '频次限定字典（目录限次与明细实际次数）')];
  }
  const hits: RuleHit[] = [];
  for (const [code, count] of Object.entries(observed)) {
    const max = limits[code]?.maxFrequency;
    if (max !== undefined && count > max) {
      const line: BillLine | undefined = ctx.bill.lines.find((l) => l.priceItemCode === code);
      hits.push(hit(
        { id: '§4-7', basisRef: '§4-7', severity: 'medium' },
        line?.lineNo,
        { price_item_code: code, observed_frequency: count, max_frequency: max },
      ));
    }
  }
  return hits;
}

/** 把七条注册进注册表；扩展新规则只需再加一条 register，不动引擎内核 */
export function registerNegativeListRules(registry: RuleRegistry): RuleRegistry {
  registry.register({ id: '§4-1', basisRef: '§4-1', severity: 'high', effectiveVersion: RULE_VERSION, predicate: checkNonCatalog });
  registry.register({ id: '§4-2', basisRef: '§4-2', severity: 'high', effectiveVersion: RULE_VERSION, predicate: checkIndication });
  registry.register({ id: '§4-3', basisRef: '§4-3', severity: 'medium', effectiveVersion: RULE_VERSION, predicate: checkHospitalLevel });
  registry.register({ id: '§4-4', basisRef: '§4-4', severity: 'medium', effectiveVersion: RULE_VERSION, predicate: checkChildLimit });
  registry.register({ id: '§4-5', basisRef: '§4-5', severity: 'medium', effectiveVersion: RULE_VERSION, predicate: checkGenderLimit });
  registry.register({ id: '§4-6', basisRef: '§4-6', severity: 'high', effectiveVersion: RULE_VERSION, predicate: checkFeeDateOutOfPeriod });
  registry.register({ id: '§4-7', basisRef: '§4-7', severity: 'medium', effectiveVersion: RULE_VERSION, predicate: checkFrequency });
  return registry;
}

export const NEGATIVE_LIST_PREDICATES = {
  '§4-1': checkNonCatalog,
  '§4-2': checkIndication,
  '§4-3': checkHospitalLevel,
  '§4-4': checkChildLimit,
  '§4-5': checkGenderLimit,
  '§4-6': checkFeeDateOutOfPeriod,
  '§4-7': checkFrequency,
} as const;
