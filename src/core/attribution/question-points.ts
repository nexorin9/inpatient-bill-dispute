/**
 * 质疑点抽取（Task 7）—— 家属口语诉求 → 结构化质疑点集合。
 *
 * 每点带原文片段、字符位置与类型；source_quote 必须是原话子串、char 区间必须落在原文范围内，
 * 不合法的条目丢弃并记错误码。口述金额解析为数值区间，解析不出标 uncertain 而非猜一个数。
 * 空诉求或纯寒暄不调模型，直接给确定性结论。
 */

import type { QuestionPoint, QuestionKind, SpokenAmount } from '../domain/contracts.ts';
import type { ModelGateway } from './model-gateway.ts';

export const NO_QUESTION_CONCLUSION = '未识别到费用相关质疑';

const GREETINGS = /^(你好|您好|在吗|在么|谢谢|多谢|麻烦了|打扰了|早上好|下午好|嗯|哦|好的|收到)[\s，。！!？?、]*$/u;

const KIND_PATTERNS: Array<{ kind: QuestionKind; pattern: RegExp }> = [
  { kind: 'duplicate_charge', pattern: /(重复|收了两次|又收|多收|算重了|一笔变两笔)/ },
  { kind: 'insurance_attribute', pattern: /(医保|报销|自费|甲类|乙类|不能报|不给报|统筹)/ },
  { kind: 'amount', pattern: /(多算|多少钱|贵|金额|合计|总共|加起来|收费|价格|费用|块|元|千|万)/ },
  { kind: 'fee_item', pattern: /(化验|检查|床位|药|手术|护理|材料|诊察|治疗|项目|这笔|哪笔)/ },
];

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000, 万: 10000,
};

/**
 * 中文数字串 → 数值。
 * 支持口语省写：「三千二」= 3200、「三百二」= 320、「一万二」= 12000，
 * 也支持完整写法「三千二百」「一万二千」。省写的尾数按上一个大单位降一档计权。
 */
export function parseChineseNumber(raw: string): number | undefined {
  let total = 0;
  let section = 0;
  let current = 0;
  let lastUnit = 1;
  for (const ch of raw) {
    const digit = CN_DIGITS[ch];
    if (digit === undefined) return undefined;
    if (digit >= 10) {
      if (digit === 10000) {
        total += (section + current) * 10000;
        section = 0;
      } else {
        section += (current || 1) * digit;
      }
      current = 0;
      lastUnit = digit;
    } else {
      current = digit;
    }
  }
  // 尾数省写：三千二 → 2×(1000/10)、一万二 → 2×(10000/10)
  const tail = current > 0 && lastUnit >= 10 ? current * (lastUnit / 10) : current;
  const value = total + section + tail;
  return value > 0 ? value : undefined;
}

/** 口述金额归一：允许误差与不确定标记；解析不出返回 uncertain */
export function parseSpokenAmount(text: string): SpokenAmount | undefined {
  const uncertain = /(大概|大约|好像|左右|差不多|记不清|不确定|可能)/.test(text);
  // ① 阿拉伯数字（含千分位、单位元/块）
  const arabic = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:元|块|块钱)?/u);
  if (arabic?.[1]) {
    const value = Number(arabic[1].replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) {
      return { min: value * 0.95, max: value * 1.05, uncertain, raw: arabic[0] };
    }
  }
  // ② 「3 千 2」「3千2」「3 万 2」混合写法
  const mixed = text.match(/(\d+(?:\.\d+)?)\s*([千万])\s*(\d+(?:\.\d+)?)?/u);
  if (mixed?.[1] && mixed[2]) {
    const unit = mixed[2] === '万' ? 10000 : 1000;
    const base = Number(mixed[1]) * unit;
    const tail = mixed[3] ? Number(mixed[3]) * (unit / 10) : 0;
    const value = base + tail;
    return { min: value * 0.95, max: value * 1.05, uncertain, raw: mixed[0] };
  }
  // ③ 纯中文数字
  const chinese = text.match(/[零〇一二两三四五六七八九十百千万]{2,8}/u);
  if (chinese?.[0]) {
    const value = parseChineseNumber(chinese[0]);
    if (value !== undefined) {
      return { min: value * 0.95, max: value * 1.05, uncertain: true, raw: chinese[0] };
    }
  }
  if (uncertain) return { min: 0, max: 0, uncertain: true, raw: text };
  return undefined;
}

function classifyKind(text: string): QuestionKind {
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'other';
}

/** 确定性抽取（无模型 / 降级 / 本地基线共用） */
export function extractQuestionPointsHeuristic(text: string): QuestionPoint[] {
  if (isEmptyOrGreeting(text)) return [];
  const clauses = text
    .split(/[。！？!?；;，,、\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  const points: QuestionPoint[] = [];
  let cursor = 0;
  for (const clause of clauses) {
    const start = text.indexOf(clause, cursor);
    if (start < 0) continue;
    cursor = start + clause.length;
    if (GREETINGS.test(clause)) continue;
    const kind = classifyKind(clause);
    if (kind === 'other' && !/\d/.test(clause) && !/(贵|多|少|算|收|报)/.test(clause)) continue;
    const spokenAmount = parseSpokenAmount(clause);
    points.push({
      id: `Q${String(points.length + 1).padStart(2, '0')}`,
      text: clause,
      sourceQuote: clause,
      charStart: start,
      charEnd: start + clause.length,
      kind,
      ...(spokenAmount ? { spokenAmount } : {}),
    });
  }
  return points;
}

export function isEmptyOrGreeting(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || GREETINGS.test(trimmed);
}

export interface ExtractionOutcome {
  points: QuestionPoint[];
  /** 被丢弃的非法条目与错误码 */
  rejected: Array<{ reason: string; code: string; point: string }>;
  usedModel: boolean;
  conclusion: string;
}

/** 逐条校验 source_quote 为原话子串且 char 区间合法；不合法丢弃并记错误码 */
export function validateQuestionPoints(text: string, points: QuestionPoint[]): ExtractionOutcome {
  const accepted: QuestionPoint[] = [];
  const rejected: ExtractionOutcome['rejected'] = [];
  for (const point of points) {
    if (!text.includes(point.sourceQuote)) {
      rejected.push({ reason: 'source_quote 不是原话子串', code: 'ERR_SCHEMA_INVALID', point: point.sourceQuote });
      continue;
    }
    if (point.charStart < 0 || point.charEnd > text.length || point.charStart >= point.charEnd ||
      text.slice(point.charStart, point.charEnd) !== point.sourceQuote) {
      rejected.push({ reason: 'char 区间越界或与原话不符', code: 'ERR_OUT_OF_BOUNDS', point: point.sourceQuote });
      continue;
    }
    accepted.push({ ...point, id: `Q${String(accepted.length + 1).padStart(2, '0')}` });
  }
  return {
    points: accepted,
    rejected,
    usedModel: false,
    conclusion: accepted.length > 0 ? `识别到 ${accepted.length} 个费用相关质疑点` : NO_QUESTION_CONCLUSION,
  };
}

/**
 * 抽取入口：传入 gateway 时走模型结构化输出；空输入 / 纯寒暄不调模型。
 * 模型返回的 question_point 逐条回指原话，找不到子串的条目丢弃并记错误码。
 */
export async function extractQuestionPoints(
  text: string,
  options: { gateway?: ModelGateway; contextJson?: string } = {},
): Promise<ExtractionOutcome> {
  if (isEmptyOrGreeting(text)) {
    return { points: [], rejected: [], usedModel: false, conclusion: NO_QUESTION_CONCLUSION };
  }
  const base = validateQuestionPoints(text, extractQuestionPointsHeuristic(text));
  if (!options.gateway) return base;

  const result = await options.gateway.attribute(options.contextJson ?? JSON.stringify({ request_text: text }));
  const modelPoints: QuestionPoint[] = [];
  for (const item of result.response.attribution) {
    const quote = findQuote(text, item.questionPoint);
    if (!quote) continue;
    modelPoints.push({
      id: `Q${String(modelPoints.length + 1).padStart(2, '0')}`,
      text: item.questionPoint,
      sourceQuote: quote.quote,
      charStart: quote.start,
      charEnd: quote.end,
      kind: classifyKind(item.questionPoint),
      ...(parseSpokenAmount(item.questionPoint) ? { spokenAmount: parseSpokenAmount(item.questionPoint) } : {}),
    });
  }
  const validated = validateQuestionPoints(text, modelPoints);
  return { ...validated, usedModel: true };
}

/** 模型给的质疑点在原话里找最长可回指片段 */
function findQuote(text: string, point: string): { quote: string; start: number; end: number } | undefined {
  const exact = text.indexOf(point);
  if (exact >= 0) return { quote: point, start: exact, end: exact + point.length };
  // 取质疑点中的关键词片段做子串回指
  const keywords = point.split(/[\s，。、？?！!]/u).filter((s) => s.length >= 2);
  for (const keyword of keywords.sort((a, b) => b.length - a.length)) {
    const start = text.indexOf(keyword);
    if (start >= 0) return { quote: keyword, start, end: start + keyword.length };
  }
  return undefined;
}
