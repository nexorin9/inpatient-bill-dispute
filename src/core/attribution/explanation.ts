/**
 * 带引用解释稿生成（Task 21）。
 *
 * 每条解释只允许引用三类依据之一（price_item / settlement_field / rule），
 * 引用编号按首次出现顺序生成、同一依据复用编号，编号与依据本体分离存储；
 * 引用可按配置关闭（关闭后正文仍需自解释但不得出现裸编号）。
 * 依据缺失条目标「依据缺失 → 需人工判断」，不编造依据、不进入可外发队列。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import type {
  Citation,
  EvidenceRef,
  ExplanationPart,
  RuleHit,
} from '../domain/contracts.ts';
import type { BillDetail, BillLine, DisputeCategory, EvidenceType, PriceBook } from '../domain/types.ts';
import { exactMatchPrice } from '../adapters/pricing.ts';
import { settlementFieldForFeeClass, type DictionaryBundle } from '../dictionary/loader.ts';

export const ALLOWED_EVIDENCE_TYPES: readonly EvidenceType[] = [
  'price_item', 'settlement_field', 'rule',
];

const TYPE_LABELS: Record<EvidenceType, string> = {
  price_item: '价目',
  settlement_field: '清单字段',
  rule: '规则',
};

export function evidenceTypeLabel(type: EvidenceType): string {
  return TYPE_LABELS[type];
}

export interface RejectedRef {
  ref: EvidenceRef;
  code: string;
  reason: string;
}

/** 引用编号分配器：按首次出现顺序递增，同一依据复用同一编号 */
export class CitationAllocator {
  private readonly byKey = new Map<string, number>();
  readonly citations: Citation[] = [];
  readonly rejected: RejectedRef[] = [];

  private key(ref: EvidenceRef): string {
    return `${ref.type}|${ref.code}`;
  }

  allocate(ref: EvidenceRef, lineNumbers: readonly number[] = []): number | undefined {
    if (!ALLOWED_EVIDENCE_TYPES.includes(ref.type)) {
      this.rejected.push({ ref, code: ErrorCode.SCHEMA_INVALID, reason: '引用类型不在白名单（price_item / settlement_field / rule）' });
      return undefined;
    }
    const key = this.key(ref);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      const citation = this.citations.find((c) => c.index === existing);
      if (citation) {
        citation.lineNumbers = [...new Set([...citation.lineNumbers, ...lineNumbers])];
      }
      return existing;
    }
    const index = this.citations.length + 1;
    this.byKey.set(key, index);
    this.citations.push({
      index,
      type: ref.type,
      code: ref.code,
      label: ref.label,
      version: ref.version,
      lineNumbers: [...lineNumbers],
    });
    return index;
  }

  /** 编号严格递增断言（供测试与生成后自检） */
  assertStrictlyIncreasing(): void {
    for (let i = 1; i < this.citations.length; i += 1) {
      if (this.citations[i]!.index !== this.citations[i - 1]!.index + 1) {
        throw new AppError(ErrorCode.SCHEMA_INVALID, { reason: '引用编号未严格递增' });
      }
    }
  }
}

export interface ExplanationInput {
  bill: BillDetail;
  priceBook: PriceBook;
  bundle: DictionaryBundle;
  matches: Array<{ questionPoint: string; lineNumbers: number[]; category: DisputeCategory; confidence: number }>;
  ruleHits: RuleHit[];
  citationsEnabled: boolean;
  /** 依据缺失行（价目未命中 / 字典缺项） */
  evidenceMissingLineNumbers?: number[];
  /** 拒答行（低置信度 / 互斥候选） */
  refusedLineNumbers?: number[];
  priceVersion?: string;
  dictionaryVersion?: string;
  rulesVersion?: string;
}

export interface ExplanationOutput {
  parts: ExplanationPart[];
  citations: Citation[];
  rejectedRefs: RejectedRef[];
  plainText: string;
}

function familyWording(line: BillLine): string {
  return `${line.occurredAt} 的一笔「${line.itemName}」，金额 ${line.amount.toFixed(2)} 元`;
}

function attributeWording(attribute: string): string {
  const map: Record<string, string> = {
    甲: '属于医保目录内甲类项目，按本院价目口径结算',
    乙: '属于医保目录内乙类项目，按本院价目口径先由个人负担一部分',
    自费: '属于自费项目，按本院价目口径由个人承担',
  };
  return map[attribute] ?? '按本院价目目录的口径结算';
}

/** 渲染一条解释的家属可读正文（不出现字段名与内部术语；引用可关闭） */
export function renderPartBody(part: ExplanationPart, citations: Citation[], citationsEnabled: boolean): string {
  if (part.needsHuman) {
    return part.evidenceMissing
      ? '这一笔暂时缺少可核对的院内依据，需人工判断后再向家属说明。'
      : '这一笔存在多种可能，需人工判断后再向家属说明。';
  }
  const refs = citationsEnabled && part.citationIndexes.length > 0
    ? `（依据 ${part.citationIndexes.map((i) => `[${i}]`).join('')}）`
    : '（依据以院内价目与结算清单口径为准）';
  return `${part.what}；${part.why}${refs}`;
}

/** 关闭引用后正文不得出现裸编号 */
export function hasBareCitationNumber(text: string): boolean {
  return /\[\d+\]|（依据\s*\d+|^依据\s*\d+/mu.test(text);
}

export function buildExplanation(input: ExplanationInput): ExplanationOutput {
  const allocator = new CitationAllocator();
  const parts: ExplanationPart[] = [];
  const evidenceMissing = new Set(input.evidenceMissingLineNumbers ?? []);
  const refused = new Set(input.refusedLineNumbers ?? []);
  const lineByNo = new Map(input.bill.lines.map((line) => [line.lineNo, line]));
  const priceVersion = input.priceVersion ?? input.priceBook.version;
  const dictionaryVersion = input.dictionaryVersion ?? input.bundle.settlement._meta.version;
  const rulesVersion = input.rulesVersion ?? input.bundle.negativeList._meta.version;

  // 未被任何质疑点归并到的明细行也要覆盖（零漏行，Task 27）
  const matchedLines = new Set(input.matches.flatMap((m) => m.lineNumbers));
  const coverageItems = [...input.matches];
  for (const line of input.bill.lines) {
    if (matchedLines.has(line.lineNo)) continue;
    coverageItems.push({
      questionPoint: `明细行 ${line.lineNo}`,
      lineNumbers: [line.lineNo],
      category: 'internal_check',
      confidence: 1,
    });
  }

  for (const item of coverageItems) {
    for (const lineNo of item.lineNumbers) {
      const line = lineByNo.get(lineNo);
      if (!line) continue;
      const priceItem = exactMatchPrice(input.priceBook, line.priceItemCode);
      const needsHuman = evidenceMissing.has(lineNo) || refused.has(lineNo) || !priceItem ||
        item.category === 'needs_human';
      const evidenceMissingForLine = evidenceMissing.has(lineNo) || !priceItem;
      const highSeverity = input.ruleHits.some((h) => h.lineNo === lineNo && h.severity === 'high');

      const citationIndexes: number[] = [];
      if (!needsHuman && priceItem) {
        const priceRef = allocator.allocate({
          type: 'price_item', code: priceItem.priceItemCode,
          label: `本院价目目录「${priceItem.name}」`, version: priceVersion,
        }, [lineNo]);
        if (priceRef !== undefined) citationIndexes.push(priceRef);

        const field = settlementFieldForFeeClass(input.bundle, line.feeClass);
        if (field) {
          const fieldRef = allocator.allocate({
            type: 'settlement_field', code: field.code,
            label: `结算清单字段「${field.name}」`, version: dictionaryVersion,
          }, [lineNo]);
          if (fieldRef !== undefined) citationIndexes.push(fieldRef);
        }
        for (const ruleHit of input.ruleHits.filter((h) => h.lineNo === lineNo)) {
          const ruleRef = allocator.allocate({
            type: 'rule', code: ruleHit.basisRef,
            label: `审核规则 ${ruleHit.ruleId}`, version: rulesVersion,
          }, [lineNo]);
          if (ruleRef !== undefined) citationIndexes.push(ruleRef);
        }
      }

      const part: ExplanationPart = {
        lineNumbers: [lineNo],
        what: `这笔是${familyWording(line)}`,
        why: priceItem ? attributeWording(priceItem.insuranceAttribute) : '这一笔暂时缺少可核对的院内依据',
        citationIndexes,
        needsHuman,
        evidenceMissing: evidenceMissingForLine,
        category: needsHuman ? 'needs_human' : item.category,
        confidence: item.confidence,
        protected: needsHuman || highSeverity,
        text: '',
      };
      part.text = renderPartBody(part, allocator.citations, input.citationsEnabled);
      parts.push(part);
    }
  }

  allocator.assertStrictlyIncreasing();
  const plain = parts.map((part) => part.text ?? '').join('\n');
  if (!input.citationsEnabled && hasBareCitationNumber(plain)) {
    throw new AppError(ErrorCode.COMPLIANCE_VIOLATION, { reason: '引用关闭后正文仍出现裸编号' });
  }
  return { parts, citations: allocator.citations, rejectedRefs: allocator.rejected, plainText: plain };
}
