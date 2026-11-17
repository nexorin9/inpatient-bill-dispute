/**
 * 院内 IM 群机器人推送（出站写，字段白名单）。
 *
 * POST $IM_WEBHOOK_URL，body { msgtype: 'markdown', markdown: { content } }
 * content 只允许拼装四个白名单字段：咨询编号、收费项目编码、争议分类、解释稿编号。
 * 出现姓名 / 证件号 / 床号 / 金额即抛错并中断推送（宁可失败也不泄漏）。
 */

import { AppError, ErrorCode } from '../domain/errors.ts';
import { requestJson, type HttpOptions } from './http.ts';

export interface ImWhitelistPayload {
  consultationNo: string;
  priceItemCode: string;
  disputeCategory: string;
  draftNo: string;
}

export interface ImOutcome {
  ok: boolean;
  errorCode?: string;
  /** 失败不阻断主流程，但必须可观测 */
  retryable: boolean;
  payload: { msgtype: 'markdown'; markdown: { content: string } };
  fields: string[];
}

const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '证件号', pattern: /\b\d{17}[\dXx]\b/ },
  { label: '电话', pattern: /\b1[3-9]\d{9}\b/ },
  { label: '床号', pattern: /床号\s*[:：]?\s*\d+/ },
  { label: '姓名', pattern: /姓名\s*[:：]?\s*[^\s,，。;；]{2,}/ },
  { label: '金额', pattern: /(金额|元|¥|￥|\d+\.\d{2})/ },
  { label: '住址', pattern: /住址\s*[:：]/ },
];

/** 白名单强制：只允许四个字段进入 content，且逐字段扫描禁含项 */
export function buildImPayload(fields: ImWhitelistPayload): {
  msgtype: 'markdown';
  markdown: { content: string };
} {
  const allowedKeys: Array<keyof ImWhitelistPayload> = [
    'consultationNo', 'priceItemCode', 'disputeCategory', 'draftNo',
  ];
  const labels: Record<keyof ImWhitelistPayload, string> = {
    consultationNo: '咨询编号', priceItemCode: '收费项目编码',
    disputeCategory: '争议分类', draftNo: '解释稿编号',
  };
  const contentLines: string[] = ['**费用咨询转办提醒**'];
  for (const key of allowedKeys) {
    const value = fields[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError(ErrorCode.COMPLIANCE_VIOLATION, { field: key, reason: '白名单字段缺失' });
    }
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(value)) {
        throw new AppError(ErrorCode.COMPLIANCE_VIOLATION, {
          field: key, forbidden: label, reason: 'IM 白名单字段含身份信息或金额，推送中断',
        });
      }
    }
    contentLines.push(`- ${labels[key]}：${value}`);
  }
  const content = contentLines.join('\n');
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(content.replace(/- (咨询编号|收费项目编码|争议分类|解释稿编号)：/g, ''))) {
      throw new AppError(ErrorCode.COMPLIANCE_VIOLATION, { forbidden: label, reason: 'IM 正文含禁含项' });
    }
  }
  return { msgtype: 'markdown', markdown: { content } };
}

export class ImAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: HttpOptions;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    transport: HttpOptions = {},
  ) {
    this.env = env;
    this.transport = transport;
  }

  isConfigured(): boolean {
    return Boolean(this.env.IM_WEBHOOK_URL);
  }

  async push(fields: ImWhitelistPayload): Promise<ImOutcome> {
    const payload = buildImPayload(fields);
    if (!this.isConfigured()) {
      return {
        ok: false, errorCode: ErrorCode.CREDENTIALS_MISSING, retryable: true,
        payload, fields: Object.keys(fields),
      };
    }
    try {
      await requestJson<Record<string, unknown>>(this.env.IM_WEBHOOK_URL!, {
        ...this.transport, method: 'POST', body: payload, retries: 0,
      });
      return { ok: true, retryable: false, payload, fields: Object.keys(fields) };
    } catch (err) {
      const error = err instanceof AppError ? err : new AppError(ErrorCode.PARSE_FAILED, { raw: String(err) });
      return { ok: false, errorCode: error.code, retryable: error.retryable, payload, fields: Object.keys(fields) };
    }
  }
}
