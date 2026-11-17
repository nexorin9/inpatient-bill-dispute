/**
 * 禁语与越界校验（Task 25）—— 合规红线一次性收紧。
 *
 * 解释稿只允许描述费用口径与依据；命中禁语词表或越界内容
 * （诊断、治疗建议、代签、承诺报销、断定违规、点名科室责任人）时拒发并提示重写，
 * 不自动改写后放行。结构化字段（category / confidence / 说明文本）同样过检测。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type { ExplanationPart } from '../domain/contracts.ts';

export interface BannedTerm {
  term: string;
  invariant: string;
  category: 'diagnosis' | 'treatment' | 'signature' | 'reimbursement_promise' | 'violation_claim' | 'named_person';
}

/** 词表逐条可追溯到不变量说明（产品边界：只描述费用口径与依据） */
export const BANNED_TERMS: readonly BannedTerm[] = [
  { term: '诊断为', invariant: '不得输出诊断', category: 'diagnosis' },
  { term: '确诊', invariant: '不得输出诊断', category: 'diagnosis' },
  { term: '建议用药', invariant: '不得输出治疗建议', category: 'treatment' },
  { term: '建议治疗', invariant: '不得输出治疗建议', category: 'treatment' },
  { term: '建议手术', invariant: '不得输出治疗建议', category: 'treatment' },
  { term: '代签', invariant: '不得代签', category: 'signature' },
  { term: '我替您签', invariant: '不得代签', category: 'signature' },
  { term: '承诺报销', invariant: '不得承诺报销', category: 'reimbursement_promise' },
  { term: '肯定能报', invariant: '不得承诺报销', category: 'reimbursement_promise' },
  { term: '一定能报', invariant: '不得承诺报销', category: 'reimbursement_promise' },
  { term: '保证报销', invariant: '不得承诺报销', category: 'reimbursement_promise' },
  { term: '一定违规', invariant: '不得断定违规', category: 'violation_claim' },
  { term: '肯定是违规', invariant: '不得断定违规', category: 'violation_claim' },
  { term: '我们是错的', invariant: '不得代医院作责任认定', category: 'violation_claim' },
  { term: '某某医生', invariant: '不得点名科室责任人', category: 'named_person' },
  { term: '责任在', invariant: '不得点名科室责任人', category: 'named_person' },
  { term: '医生负全责', invariant: '不得点名科室责任人', category: 'named_person' },
];

export interface ComplianceViolation {
  term: string;
  invariant: string;
  location: string;
  excerpt: string;
}

export interface ComplianceVerdict {
  ok: boolean;
  violations: ComplianceViolation[];
  blockedPartIndexes: number[];
  errorCode?: string;
}

export function scanText(text: string, location: string): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];
  for (const banned of BANNED_TERMS) {
    const at = text.indexOf(banned.term);
    if (at >= 0) {
      violations.push({
        term: banned.term,
        invariant: banned.invariant,
        location,
        excerpt: text.slice(Math.max(0, at - 12), Math.min(text.length, at + banned.term.length + 12)),
      });
    }
  }
  return violations;
}

/** 不止扫正文：结构化字段（分类、置信度说明、备注）也要过一遍 */
export function checkCompliance(input: {
  parts: readonly ExplanationPart[];
  plainText?: string;
  structured?: Record<string, unknown>;
}): ComplianceVerdict {
  const violations: ComplianceViolation[] = [];
  const blockedPartIndexes: number[] = [];
  input.parts.forEach((part, index) => {
    const fields = [part.text ?? '', part.what, part.why, part.category];
    const found = fields.flatMap((field, fieldIndex) => scanText(field, `parts[${index}].${['text', 'what', 'why', 'category'][fieldIndex]}`));
    if (found.length > 0) {
      violations.push(...found);
      blockedPartIndexes.push(index);
    }
  });
  if (input.plainText) violations.push(...scanText(input.plainText, 'plain_text'));
  if (input.structured) {
    for (const [key, value] of Object.entries(input.structured)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      violations.push(...scanText(text, `structured.${key}`));
    }
  }
  if (input.structured?.category !== undefined && !['internal_check', 'to_insurance_office', 'needs_human'].includes(String(input.structured.category))) {
    violations.push({
      term: String(input.structured.category),
      invariant: '争议分类只允许三值',
      location: 'structured.category',
      excerpt: String(input.structured.category),
    });
  }
  return {
    ok: violations.length === 0,
    violations,
    blockedPartIndexes: [...new Set(blockedPartIndexes)],
    ...(violations.length > 0 ? { errorCode: ErrorCode.COMPLIANCE_VIOLATION } : {}),
  };
}

/** 命中即拒发：不自动改写后放行 */
export function assertCompliance(verdict: ComplianceVerdict): void {
  if (verdict.ok) return;
  throw new AppError(ErrorCode.COMPLIANCE_VIOLATION, {
    hits: verdict.violations.map((v) => `${v.location}: ${v.term}（${v.invariant}）`),
    reason: '内容触及合规红线，拒发并提示重写',
  });
}
