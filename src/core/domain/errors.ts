/**
 * 统一错误码归一 —— 全系统只有这一个错误面。
 *
 * 外部世界的不确定（模型超时、工单 5xx、HIS 返回缺字段）先归一到这里，
 * 再由界面提示与留痕共用，避免每个模块各写一套错误文案。
 */

/** 七类基础技术错误 + 业务闸门错误 */
export const ErrorCode = {
  /** 连接或读取超时 */
  TIMEOUT: 'ERR_TIMEOUT',
  /** 上游返回 4xx（请求本身有问题，重试无意义） */
  HTTP_4XX: 'ERR_HTTP_4XX',
  /** 上游返回 5xx（上游临时故障，可退避重试） */
  HTTP_5XX: 'ERR_HTTP_5XX',
  /** 响应解析失败（非 JSON / 结构残缺） */
  PARSE_FAILED: 'ERR_PARSE_FAILED',
  /** 结构化结果 Schema 校验失败 */
  SCHEMA_INVALID: 'ERR_SCHEMA_INVALID',
  /** 依据缺失：价目未命中、字典缺项、规则依据不可得 */
  EVIDENCE_MISSING: 'ERR_EVIDENCE_MISSING',
  /** 歧义：命中多条互斥明细 / 住院号命中多条住院记录 */
  AMBIGUOUS: 'ERR_AMBIGUOUS',
  /** 凭据缺失：环境变量未配置 */
  CREDENTIALS_MISSING: 'ERR_CREDENTIALS_MISSING',
  /** 未确认即外发：绕过确认闸门 */
  CONFIRM_REQUIRED: 'ERR_CONFIRM_REQUIRED',
  /** 已确认但内容不满足外发条件（如需人工判断条目），与「未确认」区分开 */
  OUTBOUND_BLOCKED: 'ERR_OUTBOUND_BLOCKED',
  /** 非法状态跃迁 */
  ILLEGAL_TRANSITION: 'ERR_ILLEGAL_TRANSITION',
  /** 三重绑定缺一（住院号 / 明细行号 / 收费项目编码） */
  BINDING_INCOMPLETE: 'ERR_BINDING_INCOMPLETE',
  /** 归并行号越界：模型返回了本次住院不存在的行号 */
  OUT_OF_BOUNDS: 'ERR_OUT_OF_BOUNDS',
  /** 禁语 / 越界内容命中 */
  COMPLIANCE_VIOLATION: 'ERR_COMPLIANCE_VIOLATION',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误分类：决定界面提示措辞与是否允许退避重试 */
export type ErrorCategory =
  | 'timeout'
  | 'upstream_client'
  | 'upstream_server'
  | 'parse'
  | 'schema'
  | 'evidence'
  | 'ambiguity'
  | 'config'
  | 'gate'
  | 'state'
  | 'binding'
  | 'compliance';

interface ErrorMeta {
  category: ErrorCategory;
  /** 界面可直接展示的中文文案 */
  message: string;
  /** 是否值得退避重试（超时 / 5xx 可重试；4xx / 校验失败不可重试） */
  retryable: boolean;
}

const ERROR_META: Record<ErrorCodeValue, ErrorMeta> = {
  [ErrorCode.TIMEOUT]: { category: 'timeout', message: '请求超时，未在时限内拿到响应', retryable: true },
  [ErrorCode.HTTP_4XX]: { category: 'upstream_client', message: '上游系统拒绝了请求，请检查参数与凭据', retryable: false },
  [ErrorCode.HTTP_5XX]: { category: 'upstream_server', message: '上游系统暂时不可用', retryable: true },
  [ErrorCode.PARSE_FAILED]: { category: 'parse', message: '响应内容解析失败', retryable: false },
  [ErrorCode.SCHEMA_INVALID]: { category: 'schema', message: '返回结构不符合约定格式', retryable: false },
  [ErrorCode.EVIDENCE_MISSING]: { category: 'evidence', message: '依据缺失，需人工判断', retryable: false },
  [ErrorCode.AMBIGUOUS]: { category: 'ambiguity', message: '存在多种可能，需人工选定', retryable: false },
  [ErrorCode.CREDENTIALS_MISSING]: { category: 'config', message: '未配置该系统的接口凭据', retryable: false },
  [ErrorCode.CONFIRM_REQUIRED]: { category: 'gate', message: '尚未经收费员确认，不得外发', retryable: false },
  [ErrorCode.OUTBOUND_BLOCKED]: { category: 'gate', message: '该咨询不满足外发条件，不得外发', retryable: false },
  [ErrorCode.ILLEGAL_TRANSITION]: { category: 'state', message: '当前状态不允许该操作', retryable: false },
  [ErrorCode.BINDING_INCOMPLETE]: { category: 'binding', message: '住院号、明细行号、收费项目编码缺一不可', retryable: false },
  [ErrorCode.OUT_OF_BOUNDS]: { category: 'binding', message: '引用了本次住院不存在的明细行', retryable: false },
  [ErrorCode.COMPLIANCE_VIOLATION]: { category: 'compliance', message: '内容触及合规红线，不能发出', retryable: false },
};

/** 全系统抛出的唯一错误类型 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCodeValue, details: Record<string, unknown> = {}, cause?: unknown) {
    const meta = ERROR_META[code];
    // 同一错误码在不同场景有不同原因（如闸门拒绝可能是「未确认」也可能是「需人工判断」），
    // 把调用方给出的可读原因附在消息后面，避免界面把已确认的单子误报成未确认。
    const reasonText = typeof details.reason === 'string' ? details.reason.trim() : '';
    const reason = reasonText.length > 0 && reasonText !== meta.message
      ? `（${reasonText}）`
      : '';
    super(meta.message + reason);
    this.name = 'AppError';
    this.code = code;
    this.category = meta.category;
    this.retryable = meta.retryable;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }

  /** 供留痕与界面直接消费的可读结构 */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** 把任意异常归一为 AppError：已归一的原样透传，未知异常按解析失败处理 */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError(ErrorCode.PARSE_FAILED, { raw: err.message }, err);
  }
  return new AppError(ErrorCode.PARSE_FAILED, { raw: String(err) }, err);
}

/** 错误码 → 界面文案 */
export function errorMessage(code: ErrorCodeValue): string {
  return ERROR_META[code].message;
}

/** 该错误码是否值得退避重试 */
export function isRetryable(code: ErrorCodeValue): boolean {
  return ERROR_META[code].retryable;
}
