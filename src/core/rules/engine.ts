/**
 * 规则引擎内核 —— 规则 = 谓词 + 依据引用（官方条目号）+ 严重度 + 生效版本。
 *
 * 引擎只输出命中条目与依据编号，不产出任何自由文本（措辞由归因引擎负责）。
 * 该层是模型的确定性基线与守门闸门：模型输出必须过此层才可进入解释稿。
 * 新增规则只需注册规则对象与谓词函数，不改引擎内核。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { RuleHit } from '../domain/contracts.ts';
import type { BillDetail, PriceBook } from '../domain/types.ts';
import type { DictionaryBundle, VersionSnapshot } from '../dictionary/loader.ts';

export type Severity = 'low' | 'medium' | 'high';

/** 规则执行上下文：本次住院明细 + 价目 + 院内字典（字典缺项时标依据缺失） */
export interface RuleContext {
  bill: BillDetail;
  priceBook?: PriceBook;
  /** 咨询发生日，用于价目版本是否过期的守门 */
  consultationDate?: string;
  /** 版本快照（历史复现时传入） */
  snapshot?: VersionSnapshot;
  dictionaries?: {
    /** 医保目录编码集合（§4-1 非目录审核） */
    catalogCodes?: Set<string>;
    /** 限定适应症用药字典：编码 → 允许的适应症 */
    indications?: Record<string, string>;
    /** 实际适应症（院内诊断口径） */
    actualIndication?: string;
    /** 机构级别（§4-3） */
    hospitalLevel?: string;
    /** 要求的机构级别 */
    requiredHospitalLevel?: string;
    /** 患者年龄 / 性别（§4-4 / §4-5） */
    patientAge?: number;
    patientGender?: '男' | '女';
    /** 目录限定：编码 → { minAge?, maxAge?, gender?, maxFrequency? } */
    itemLimits?: Record<string, {
      minAge?: number; maxAge?: number; gender?: '男' | '女'; maxFrequency?: number;
      hospitalLevel?: string;
    }>;
    /** 明细实际使用频次（编码 → 次数） */
    observedFrequency?: Record<string, number>;
  };
  bundle?: DictionaryBundle;
}

export interface Rule {
  id: string;
  /** 官方条目号，必须可追溯到「依据是哪一条」 */
  basisRef: string;
  severity: Severity;
  effectiveVersion: string;
  predicate: (ctx: RuleContext) => RuleHit[];
}

export class RuleRegistry {
  private readonly rules = new Map<string, Rule>();
  readonly version: string;

  constructor(version = 'RULES-2026-03') {
    this.version = version;
  }

  /** 无依据编号的规则不允许注册（启动期校验拒绝） */
  register(rule: Rule): void {
    if (!rule.basisRef || rule.basisRef.trim().length === 0) {
      throw new AppError(ErrorCode.EVIDENCE_MISSING, { ruleId: rule.id, reason: '规则缺依据编号，拒绝注册' });
    }
    if (this.rules.has(rule.id)) {
      throw new AppError(ErrorCode.EVIDENCE_MISSING, { ruleId: rule.id, reason: '规则编号重复' });
    }
    this.rules.set(rule.id, rule);
  }

  list(): Rule[] {
    return [...this.rules.values()];
  }

  get(id: string): Rule | undefined {
    return this.rules.get(id);
  }

  /** 按生效版本取用：历史归因不受新版本改写影响 */
  active(version: string = this.version): Rule[] {
    return this.list().filter((rule) => rule.effectiveVersion <= version);
  }
}

/** 执行器：只输出命中条目（规则 id + 依据编号 + 命中证据字段） */
export function runRules(ctx: RuleContext, registry: RuleRegistry, version?: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of registry.active(version)) {
    hits.push(...rule.predicate(ctx));
  }
  return hits;
}

/** 引擎输出不含自然语言自由文本字段（供单测断言） */
export function hasFreeText(hit: RuleHit): boolean {
  return Object.entries(hit.evidence).some(([key, value]) =>
    typeof value === 'string' && /(说明|解释|建议|描述|message|text)/i.test(key) && value.length > 20);
}

/** 依据缺失命中：不默认通过，显式标「依据缺失 → 需人工判断」并写明缺哪本字典 */
export function missingEvidenceHit(ruleId: string, basisRef: string, dictionary: string, evidence: Record<string, unknown> = {}): RuleHit {
  return {
    ruleId,
    basisRef,
    severity: 'medium',
    evidence,
    evidenceMissing: true,
    missingDictionary: dictionary,
  };
}

/** 构造一条命中（结构固定，措辞留给归因引擎） */
export function hit(rule: Pick<Rule, 'id' | 'basisRef' | 'severity'>, lineNo: number | undefined, evidence: Record<string, unknown>): RuleHit {
  return {
    ruleId: rule.id,
    basisRef: rule.basisRef,
    severity: rule.severity,
    ...(lineNo !== undefined ? { lineNo } : {}),
    evidence,
  };
}
