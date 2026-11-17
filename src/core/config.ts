/**
 * 运行期配置 —— 所有阈值与开关从环境变量读，业务代码不硬编码。
 * .env.example 里给出默认值与说明；.env 由 CLI / 主进程加载后注入 process.env。
 */

export interface AppConfig {
  /** 归因置信度阈值（Task 23）：低于此值判「需人工判断」 */
  minConfidence: number;
  /** 阈值附近带宽（±），落在带内同样拒答并保留原始分数 */
  confidenceMargin: number;
  /** 解释稿目标字数上限（Task 24） */
  maxExplanationChars: number;
  /** 是否输出引用编号（Task 21）：关闭后正文不得出现裸编号 */
  citationsEnabled: boolean;
  /** 模型超时（毫秒）与重试次数（Task 6） */
  modelTimeoutMs: number;
  modelMaxRetries: number;
  /** 工单退避重试（Task 38） */
  workorderMaxRetries: number;
  workorderBackoffMs: number;
  /** 金额勾稽容差，按分计（Task 29） */
  reconciliationToleranceCents: number;
  /** 分渠道超时时限，分钟（Task 41） */
  slaMinutes: Record<'counter' | 'phone' | 'online', number>;
  /** 数据源标注：真实端点或本地脱敏样例 */
  dataSource: 'his' | 'samples';
}

function num(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    minConfidence: num(env.ATTRIBUTION_MIN_CONFIDENCE, 0.65),
    confidenceMargin: num(env.ATTRIBUTION_CONFIDENCE_MARGIN, 0.05),
    maxExplanationChars: num(env.EXPLANATION_MAX_CHARS, 1200),
    citationsEnabled: (env.CITATIONS_ENABLED ?? 'true').toLowerCase() !== 'false',
    modelTimeoutMs: num(env.OPENAI_TIMEOUT_MS, 30_000),
    modelMaxRetries: Math.min(1, Math.max(0, num(env.OPENAI_MAX_RETRIES, 1))),
    workorderMaxRetries: Math.min(3, Math.max(0, num(env.WORKORDER_MAX_RETRIES, 3))),
    workorderBackoffMs: num(env.WORKORDER_BACKOFF_MS, 10),
    reconciliationToleranceCents: num(env.RECONCILIATION_TOLERANCE_CENTS, 0),
    slaMinutes: {
      counter: num(env.SLA_COUNTER_MINUTES, 30),
      phone: num(env.SLA_PHONE_MINUTES, 60),
      online: num(env.SLA_ONLINE_MINUTES, 240),
    },
    dataSource: env.HIS_BASE_URL && env.HIS_API_TOKEN ? 'his' : 'samples',
  };
}

/** 中文分类标签（界面、导出、打印稿共用） */
export const CATEGORY_LABELS: Record<string, string> = {
  internal_check: '院内核对',
  to_insurance_office: '需转医保办',
  needs_human: '需人工判断',
};

export const CHANNEL_LABELS: Record<string, string> = {
  counter: '窗口当面',
  phone: '电话',
  online: '线上留言',
};
