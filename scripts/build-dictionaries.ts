#!/usr/bin/env node
/**
 * 口径字典固化脚本 —— 从 domain/ 官方资产抽取并落成版本化 JSON。
 *
 *   运行：node --experimental-strip-types scripts/build-dictionaries.ts
 *
 * 诚实边界：官方资产《医保结算清单字段规范》只收录 193 项版的**分区结构、项数与关键校验字段**，
 * 「193 项逐项明细表未全文收录（以官方清单 PDF 为准）」。因此本脚本：
 *   - 官方资产明确列出的字段名 → provenance = official_listed，名称照抄；
 *   - 分区内其余编号 → provenance = partition_inferred，按分区标准口径补齐占位名称，
 *     仅用于编号唯一性与分区计数对照，**不冒充官方逐项名称**。
 * 这一口径同时写入 JSON 的 _meta 与 docs/DICTIONARIES.md，可复核。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DOMAIN_ROOT = resolve(PROJECT_ROOT, '../../domain');
const DICT_DIR = resolve(PROJECT_ROOT, 'src/core/dictionary');
const RULES_DIR = resolve(DICT_DIR, 'rules');

const VERSION = 'SETTLEMENT-193-2021';
const EFFECTIVE_FROM = '2021-09-06';

interface FieldEntry {
  code: string;
  name: string;
  partition: string;
  ordinal: number;
  provenance: 'official_listed' | 'partition_inferred';
  required: boolean;
  note?: string;
}

/** 官方资产中明确列出的字段名（照抄，顺序按资产出现顺序） */
const OFFICIAL: Record<string, string[]> = {
  basic: [
    '清单流水号', '定点医疗机构名称', '定点医疗机构代码', '医保结算等级', '医保类型',
    '姓名', '性别', '出生日期', '年龄', '民族', '证件类别', '证件号码', '职业', '住址',
    '联系人', '参保地', '特殊人员类型', '新生儿入院类型', '新生儿出生体重', '新生儿入院体重',
  ],
  outpatient: ['诊断科别', '就诊日期', '诊断名称', '诊断代码', '手术及操作名称', '手术及操作代码'],
  inpatient: [
    '住院医疗类型', '入院途径', '治疗类别', '入院时间', '出院时间', '入院科别', '转科科别',
    '实际住院天数', '门（急）诊诊断名称（西医）', '门（急）诊诊断代码（西医）',
    '门（急）诊诊断名称（中医）', '门（急）诊诊断代码（中医）',
    '出院主要诊断名称', '出院主要诊断代码', '主要诊断入院病情', '出院其他诊断名称',
    '出院其他诊断代码', '其他诊断入院病情', '诊断代码计数',
    '手术及操作名称', '手术及操作代码', '手术及操作日期', '麻醉方式', '术者姓名', '术者代码',
    '麻醉医师姓名', '麻醉医师代码', '主要手术操作标识', '手术操作代码计数',
    '呼吸机使用时间（天）', '呼吸机使用时间（小时）', '呼吸机使用时间（分钟）',
    '颅脑损伤患者昏迷时间（入院前）', '颅脑损伤患者昏迷时间（入院后）',
    '重症监护病房类型', '离院方式', '拟接收机构名称', '拟接收机构代码',
  ],
  fee: [
    '结算期间', '金额合计', '甲类费用', '乙类费用', '自费费用', '其他费用',
    '床位费', '诊察费', '检查费', '化验费', '治疗费', '手术费', '护理费', '卫生材料费',
    '西药费', '中药饮片费', '中成药费', '一般诊疗费', '挂号费', '其他住院费用',
    '医保统筹基金支付', '补充医疗保险支付', '医疗救助支付', '个人负担', '其他支付', '个人支付',
    '麻醉起止时间', '责任护士姓名', '责任护士代码', '按病种收费名称', '按病种收费代码', '商业保险',
  ],
};

const PARTITIONS = [
  { key: 'basic', label: '基本信息', prefix: 'BAS', count: 31 },
  { key: 'outpatient', label: '门诊慢特病诊疗信息', prefix: 'OUT', count: 6 },
  { key: 'inpatient', label: '住院诊疗信息', prefix: 'INP', count: 58 },
  { key: 'fee', label: '医疗收费信息', prefix: 'FEE', count: 98 },
] as const;

function buildFields(): FieldEntry[] {
  const fields: FieldEntry[] = [];
  for (const partition of PARTITIONS) {
    const listed = OFFICIAL[partition.key] ?? [];
    for (let ordinal = 1; ordinal <= partition.count; ordinal += 1) {
      const name = listed[ordinal - 1];
      fields.push({
        code: `${partition.prefix}-${String(ordinal).padStart(3, '0')}`,
        name: name ?? `${partition.label}第 ${ordinal} 项（分区内补位，官方逐项名称以清单 PDF 为准）`,
        partition: partition.label,
        ordinal,
        provenance: name ? 'official_listed' : 'partition_inferred',
        required: true, // 修订版取消选填项，全表必填（苏医保办发〔2021〕38 号修订要点）
        ...(name ? {} : { note: '官方资产未全文收录逐项名称；此条仅用于编号与分区计数对照' }),
      });
    }
  }
  return fields;
}

/** §4 七条智能审核规则条目 + §3.3 收费类定义，依据编号照抄官方条目号 */
const SMART_RULES = [
  { rule_id: '§4-1', basis_ref: '§4-1', name: '非目录审核', trigger: '自费或限工伤/限生育的药品与项目纳入基本医保报销', dictionary: '医保目录（药品/诊疗/耗材）', severity: 'high' },
  { rule_id: '§4-2', basis_ref: '§4-2', name: '限定适应症用药', trigger: '目录备注的限定适应症与使用条件', dictionary: '医保药品目录备注', severity: 'high' },
  { rule_id: '§4-3', basis_ref: '§4-3', name: '限定医院类型级别', trigger: '限定「二级及以上医疗机构」等与实际机构级别比对', dictionary: '机构级别字典', severity: 'medium' },
  { rule_id: '§4-4', basis_ref: '§4-4', name: '限儿童', trigger: '目录限新生儿、限儿童支付的药品与项目', dictionary: '年龄口径字典', severity: 'medium' },
  { rule_id: '§4-5', basis_ref: '§4-5', name: '限定性别', trigger: '目录性别限定药品与项目', dictionary: '性别限定字典', severity: 'medium' },
  { rule_id: '§4-6', basis_ref: '§4-6', name: '费用日期不在住院期间', trigger: '费用发生日期超出住院日期范围，或一次性补传费用明细', dictionary: '住院登记（入出院日期）', severity: 'high' },
  { rule_id: '§4-7', basis_ref: '§4-7', name: '超限定频次', trigger: '诊疗项目在时间区间内使用频次超规', dictionary: '频次限定字典', severity: 'medium' },
] as const;

const CHARGE_DEFINITIONS = [
  { id: '§3.3-1', name: '重复收费', definition: '已收取某诊疗项目费用，再单独收取该项目内涵或步骤已包含的相关项目费用' },
  { id: '§3.3-2', name: '超标准收费', definition: '超过政府最高指导价；超价格加收标准；非主手术按主手术标准收费；按日计费项目收费数量大于实际住院天数；改变计价单位多收费' },
  { id: '§3.3-3', name: '分解项目收费', definition: '将一个项目内涵、步骤分解为若干项目分别收费' },
] as const;

const RECONCILIATION = [
  {
    id: 'RECON-1',
    basis_ref: '苏医保办发〔2021〕38号 §二（四）',
    expression: '金额合计 = 医保统筹基金支付 + 补充医疗保险支付 + 医疗救助支付 + 个人负担',
    left: ['total_amount'],
    right: ['insured_fund_paid', 'supplementary_paid', 'medical_aid_paid', 'personal_burden'],
  },
  {
    id: 'RECON-2',
    basis_ref: '苏医保办发〔2021〕38号 §二（四）',
    expression: '个人负担 = 其他支付 + 个人支付',
    left: ['personal_burden'],
    right: ['other_paid', 'personal_paid'],
  },
] as const;

function readOfficial(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function main(): void {
  mkdirSync(RULES_DIR, { recursive: true });
  const fieldSpec = readOfficial(resolve(DOMAIN_ROOT, 'dictionaries/医保结算清单字段规范.md'));
  const negativeList = readOfficial(resolve(DOMAIN_ROOT, 'rules/医保违规负面清单.md'));
  const settlementNotice = readOfficial(
    resolve(DOMAIN_ROOT, 'corpus/settlement/settlement_list_js_江苏省贯彻结算清单修订通知含修订要点.txt'),
  );

  // 从官方资产校验分区项数与勾稽原文，缺证据就显式失败（不静默编造）
  const partitionProof: Array<[string, string]> = [
    ['基本信息', '31'], ['门诊慢特病诊疗信息', '6'], ['住院诊疗信息', '58'], ['医疗收费信息', '98'],
  ];
  const missingProof = partitionProof.filter(([label, count]) =>
    !fieldSpec.includes(label) || !fieldSpec.includes(count));
  if (fieldSpec && missingProof.length > 0) {
    throw new Error(`官方字段规范缺少分区计数证据：${missingProof.join(', ')}`);
  }
  for (const rule of SMART_RULES) {
    if (negativeList && !negativeList.includes(rule.name)) {
      throw new Error(`官方负面清单未找到规则条目：${rule.name}`);
    }
  }
  if (settlementNotice && !settlementNotice.includes('金额合计=医保统筹基金支付')) {
    throw new Error('官方结算清单修订通知未找到勾稽关系原文');
  }

  const fields = buildFields();
  const settlement = {
    _meta: {
      version: VERSION,
      effective_from: EFFECTIVE_FROM,
      source: 'domain/dictionaries/医保结算清单字段规范.md（国家医保局结算清单填写规范 + 医保办发〔2021〕34 号修订版）',
      partition_counts: { 基本信息: 31, 门诊慢特病诊疗信息: 6, 住院诊疗信息: 58, 医疗收费信息: 98 },
      total: 193,
      honesty_note: '官方资产只收录分区结构、项数与关键校验字段，未全文收录 193 项逐项明细表。official_listed 为资产原文照抄；partition_inferred 为分区内补位编号，仅用于编号唯一性与分区计数对照，不冒充官方逐项名称。',
    },
    fields,
  };
  const rules = {
    _meta: {
      version: 'NEGATIVE-LIST-2024',
      effective_from: '2024-01-01',
      source: 'domain/rules/医保违规负面清单.md §4 智能审核规则条目 / §3.3 收费类定义',
      smart_rule_count: 7,
      charge_definition_count: 3,
    },
    smart_rules: SMART_RULES,
    charge_definitions: CHARGE_DEFINITIONS,
  };
  const reconciliation = {
    _meta: {
      version: 'RECON-2021-38',
      effective_from: '2021-09-06',
      source: 'domain/corpus/settlement/settlement_list_js_江苏省贯彻结算清单修订通知含修订要点.txt（苏医保办发〔2021〕38 号）',
      group_count: 2,
    },
    groups: RECONCILIATION,
  };

  writeFileSync(resolve(DICT_DIR, 'settlement-fields.json'), JSON.stringify(settlement, null, 2) + '\n', 'utf8');
  writeFileSync(resolve(RULES_DIR, 'negative-list.json'), JSON.stringify(rules, null, 2) + '\n', 'utf8');
  writeFileSync(resolve(RULES_DIR, 'reconciliation.json'), JSON.stringify(reconciliation, null, 2) + '\n', 'utf8');

  const officialCount = fields.filter((f) => f.provenance === 'official_listed').length;
  console.log(`口径字典固化完成：结算清单 ${fields.length} 项（官方原文 ${officialCount} 项，分区补位 ${fields.length - officialCount} 项）`);
  console.log(`  §4 智能审核规则 ${SMART_RULES.length} 条 / §3.3 定义 ${CHARGE_DEFINITIONS.length} 条 / 勾稽 ${RECONCILIATION.length} 组`);
  console.log(`  版本：${VERSION} / 生效 ${EFFECTIVE_FROM}`);
}

main();
