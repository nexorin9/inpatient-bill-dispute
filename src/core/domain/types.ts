/**
 * 领域类型 —— 住院费用争议解释系统
 *
 * 只放「院内业务事实」，不放流程逻辑（状态机在 state-machine.ts，错误码在 errors.ts）。
 * 字段命名与 spec.md「最小数据格式与字段要求」一一对应；HIS / 价目返回的字段在
 * adapters 层完成映射，core 层只认这里的类型。
 */

/** 医保费用类别（明细行上的口径标注） */
export type FeeCategory = '甲类' | '乙类' | '自费' | '其他';

/** 价目目录上的医保属性（甲 / 乙 / 自费三值，与费用类别取值不同源，核对时须成对看） */
export type InsuranceAttribute = '甲' | '乙' | '自费';

/** 结算清单医疗收费信息区里的费用归集类目（如 西药费 / 检查费 / 床位费） */
export type FeeClass =
  | '床位费'
  | '诊察费'
  | '检查费'
  | '化验费'
  | '治疗费'
  | '手术费'
  | '护理费'
  | '卫生材料费'
  | '西药费'
  | '中药饮片费'
  | '中成药费'
  | '一般诊疗费'
  | '挂号费'
  | '其他';

/** 一条住院费用明细行 */
export interface BillLine {
  /** 明细行号：与住院号、收费项目编码构成三重绑定 */
  lineNo: number;
  /** 本院收费项目编码 */
  priceItemCode: string;
  /** 收费项目名称 */
  itemName: string;
  /** 金额（元，保留两位） */
  amount: number;
  /** 医保费用类别 */
  feeCategory: FeeCategory;
  /** 费用归集类目 */
  feeClass: FeeClass;
  /** 费用发生日期 YYYY-MM-DD；越出入院出院区间的行不丢弃，交给规则层判定 */
  occurredAt: string;
  /** 科室编码 */
  deptCode: string;
}

/** 住院结算的各支付口径（金额勾稽双向校验的输入） */
export interface PaymentBreakdown {
  totalAmount: number;
  insuredFundPaid: number;
  supplementaryPaid: number;
  medicalAidPaid: number;
  personalBurden: number;
  otherPaid: number;
  personalPaid: number;
}

/** 入站字段规范校验的非阻断标记（越界日期不丢弃，供 §4 第 6 条使用） */
export interface BillDetailFlags {
  outOfPeriodLineNumbers: number[];
  warnings: string[];
}

/** 一次住院的费用明细整体 */
export interface BillDetail {
  encounterNo: string;
  patientName: string;
  idCardNo: string;
  bedNo: string;
  admissionDate: string;
  dischargeDate: string;
  lines: BillLine[];
  payment: PaymentBreakdown;
  /** 适配器解析时产生的非阻断标记 */
  flags?: BillDetailFlags;
  /** 原样响应中出现的住院记录条数，>1 时要求人工选定 */
  candidateCount?: number;
}

/** 本院价目目录条目（须带版本号，价目改版后历史解释稿的依据不被改写） */
export interface PriceItem {
  priceItemCode: string;
  name: string;
  insuranceAttribute: InsuranceAttribute;
  unitPrice: number;
  effectiveFrom: string;
  version?: string;
}

/** 本院价目目录整体（带版本） */
export interface PriceBook {
  version: string;
  items: PriceItem[];
}

/** 解释稿允许引用的依据类型 —— 只有这三类，其他一律拒收 */
export type EvidenceType = 'price_item' | 'settlement_field' | 'rule';

/** 一条依据引用（编号与依据本体分离存储，编号按首次出现顺序分配） */
export interface EvidenceRef {
  type: EvidenceType;
  /** 依据本体标识：价目编码 / 清单字段号 / 规则条目号 */
  code: string;
  /** 人读的依据名称 */
  label: string;
  /** 依据所属版本快照（价目版本 / 字典版本 / 规则集版本） */
  version?: string;
}

/** 咨询单渠道：窗口当面 / 电话 / 线上留言 */
export type ConsultationChannel = 'counter' | 'phone' | 'online';

/** 咨询单六态 */
export type ConsultationStatus =
  | 'pending_reply'
  | 'draft_pending_confirm'
  | 'answered'
  | 'transferred'
  | 'closed'
  | 'withdrawn';

/** 争议分类三值 */
export type DisputeCategory = 'internal_check' | 'to_insurance_office' | 'needs_human';

/** 一条费用咨询单 */
export interface Consultation {
  consultationNo: string;
  channel: ConsultationChannel;
  /** 完整住院号：只存本地台账，不进日志、不进模型上下文 */
  encounterNo: string;
  /** 掩码住院号（后 4 位）：日志、留痕、界面一律用这个 */
  encounterNoMasked: string;
  /** 家属诉求原文（脱敏后） */
  requestText: string;
  status: ConsultationStatus;
  disputeCategory?: DisputeCategory;
  /** 争议金额（元） */
  amount: number;
  /** 确认时间；未确认为空，是唯一放行闸门的判据 */
  confirmedAt?: string;
  confirmedBy?: string;
  /** 转办工单号（回执写回后落库） */
  workOrderNo?: string;
  createdAt: string;
  updatedAt: string;
}
