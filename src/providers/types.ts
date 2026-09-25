/**
 * Provider 统一接口规范
 *
 * 新增平台 = 在 src/providers/ 下新建一个文件，实现 Provider 接口，
 * 并在 index.ts 中注册即可。无需改动任何其他代码。
 */
/**
 * 时间窗口额度（如 LiteLLM `/key/info` 的 `budget_limits`：每 3h / 12h / 24h 一个额度）。
 * 用于展示「3 小时限额」这类窗口的已用比例与重置时间。
 */
export interface QuotaWindow {
  /** 窗口标识，如 "3h" / "12h" / "24h" */
  window: string;
  /** 窗口额度上限 */
  limit: number;
  /** 窗口内已用金额 */
  spent: number;
  /** 剩余额度（可为负，表示已超额） */
  remaining: number;
  /** 已用比例（0~1+，可能超额故不封顶） */
  ratio: number;
  /** 窗口重置时间（ISO 字符串，可能带时区偏移） */
  resetAt?: string;
}

export interface BalanceInfo {
  balance: number;
  currency: string;
  available?: number;
  granted?: number;
  /** 该账户的时间窗口额度（可选；不提供则不展示限额） */
  quotas?: QuotaWindow[];
  raw?: Record<string, unknown>;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  cost?: number;
}

export interface Provider {
  /** 唯一标识，如 'deepseek' */
  id: string;
  /** 展示名称，如 'DeepSeek' */
  name: string;
  /** 是否官方支持余额查询接口 */
  balanceSupported: boolean;
  /** 查询余额（必须） */
  getBalance(apiKey: string): Promise<BalanceInfo>;
  /** 查询某日用量（可选；不支持的平台可省略，走手动登记） */
  getDailyUsage?(apiKey: string, date: string): Promise<UsageInfo | null>;
  /** 文档/备注 */
  docs?: string;
}
