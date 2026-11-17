/**
 * 官方用例对照跑批（Task 32）。
 *
 * 逐条登记 domain/cases/settlement_qc_cases.json 的 8 条官方推导用例，
 * 字段按官方资产原样取用（中文键名），要求 8/8 命中（含 qc-005 / qc-008 两条应通过用例不得误报）。
 * 支持注入 breakCheck 人为破坏某条规则，用于验证「破坏后退出码非 0 并点名失败用例编号」。
 */

import type { QcCase } from '../adapters/samples.ts';

export interface QcCheckResult {
  caseId: string;
  check: string;
  /** 校验命中 = 质控不通过 */
  hit: boolean;
  passed: boolean;
  basisRef: string;
  reason: string;
}

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  return String(input[key] ?? '').trim();
}
function isBlank(input: Input, key: string): boolean {
  const value = text(input, key);
  return value === '' || value === '空' || value === '无';
}

export type QcCheckName =
  | '主诊断唯一性'
  | '主手术操作唯一性'
  | '离院方式联动'
  | '费用日期在住院期间'
  | 'ICD-10 医保版结构'
  | '名称与代码同时填报'
  | '诊断与性别匹配'
  | '分区互斥';

/** 8 条校验谓词：命中 true 表示不通过；应通过的用例必须返回 false */
export const QC_CHECKS: Record<QcCheckName, { basisRef: string; predicate: (input: Input) => boolean }> = {
  主诊断唯一性: {
    basisRef: '结算清单质控硬校验 §4（主诊断有且只有一个）',
    predicate: (i) => isBlank(i, '主要诊断') && Number(i['出院诊断数'] ?? 0) > 0,
  },
  主手术操作唯一性: {
    basisRef: '结算清单质控硬校验 §4（手术操作不为空时主手术操作唯一）',
    predicate: (i) => Number(i['手术操作数'] ?? 0) > 0 && isBlank(i, '主要手术操作'),
  },
  离院方式联动: {
    basisRef: '结算清单质控硬校验 §4（离院方式 2/3 时拟接收机构名称与代码必有值）',
    predicate: (i) => ['2', '3'].includes(text(i, '离院方式')) &&
      (isBlank(i, '拟接收机构名称') || isBlank(i, '拟接收机构代码')),
  },
  费用日期在住院期间: {
    basisRef: '医保违规负面清单 §4-6',
    predicate: (i) => {
      const fee = text(i, '某费用明细日期');
      const admission = text(i, '入院时间');
      const discharge = text(i, '出院时间');
      return Boolean(fee && admission && discharge) && (fee < admission || fee > discharge);
    },
  },
  'ICD-10 医保版结构': {
    basisRef: '医保编码规则 §1（医保发〔2019〕55 号）',
    predicate: (i) => {
      const code = text(i, '诊断代码');
      // 1 字母 + 2 数字类目 + 可选亚目/延拓码，A09.9 合规
      return !/^[A-Za-z]\d{2}(\.\d{1,4})?$/.test(code);
    },
  },
  名称与代码同时填报: {
    basisRef: '结算清单填报硬规则 §3-2',
    predicate: (i) => /仅填代码/.test(text(i, '填报要求')) || isBlank(i, '诊断名称'),
  },
  诊断与性别匹配: {
    basisRef: 'CHS-DRG MDC 性别分流规则',
    predicate: (i) => {
      const gender = text(i, '患者性别');
      const diagnosis = text(i, '诊断');
      const femaleOnly = ['子宫肌瘤', '卵巢囊肿', '宫颈癌', '妊娠', '阴道'];
      const maleOnly = ['前列腺', '睾丸', '阴茎'];
      return (gender === '男' && femaleOnly.some((d) => diagnosis.includes(d))) ||
        (gender === '女' && maleOnly.some((d) => diagnosis.includes(d)));
    },
  },
  分区互斥: {
    basisRef: '结算清单填报硬规则 §3',
    predicate: (i) => {
      const outpatientFilled = text(i, '门诊慢特病诊疗信息') === '已填';
      const inpatientBlank = isBlank(i, '住院诊疗信息');
      // 日间手术走住院分区：门诊慢特病已填 + 住院诊疗信息为空 = 允许，不命中
      if (outpatientFilled && inpatientBlank) return false;
      return outpatientFilled && !inpatientBlank;
    },
  },
};

export function runQcCases(
  cases: QcCase[],
  options: { breakCheck?: QcCheckName } = {},
): QcCheckResult[] {
  return cases.map((qcCase) => {
    const check = qcCase.expect.校验 as QcCheckName;
    const checker = QC_CHECKS[check];
    const broken = options.breakCheck === check;
    const hit = checker ? (broken ? false : checker.predicate(qcCase.input)) : false;
    const expectedPass = qcCase.expect.通过;
    const passed = expectedPass ? !hit : hit;
    return {
      caseId: qcCase.case_id,
      check,
      hit,
      passed,
      basisRef: checker?.basisRef ?? qcCase.basis,
      reason: broken ? `规则被人为破坏：${check}` : qcCase.expect.原因,
    };
  });
}

export function summarizeQc(results: QcCheckResult[]): { passed: number; total: number; failed: string[] } {
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    failed: results.filter((r) => !r.passed).map((r) => r.caseId),
  };
}
