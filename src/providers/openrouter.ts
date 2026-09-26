import type { BalanceInfo, Provider } from "./types";
import { httpGetJson } from "../core/http";

interface OpenRouterKeyResponse {
  data?: {
    label?: string;
    usage?: number;
    /** 额度上限；接口对「没设上限的密钥」返回 null，不是数字 */
    limit?: number | null;
    is_free_tier?: boolean;
  };
}

interface OpenRouterCreditsResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
}

/**
 * 账户级余额：GET https://openrouter.ai/api/v1/credits
 * 密钥没设额度上限时只能靠它拿一个有意义的值（total_credits - total_usage）。
 */
async function creditsBalance(apiKey: string): Promise<number | null> {
  const data = (await httpGetJson("https://openrouter.ai/api/v1/credits", {
    Authorization: `Bearer ${apiKey}`,
  })) as OpenRouterCreditsResponse;
  const c = data.data;
  if (!c || typeof c.total_credits !== "number" || typeof c.total_usage !== "number") return null;
  return c.total_credits - c.total_usage;
}

/**
 * OpenRouter 官方密钥信息接口
 * GET https://openrouter.ai/api/v1/auth/key
 * 返回 data.usage（已用）/ data.limit（额度上限），余额 = limit - usage
 * 注意 limit 为 null 表示「这把密钥没有额度上限」，不能当成 0 去减。
 */
export const openrouterProvider: Provider = {
  id: "openrouter",
  name: "OpenRouter",
  balanceSupported: true,
  docs: "https://openrouter.ai/docs/api-reference/get-api-key",

  async getBalance(apiKey: string): Promise<BalanceInfo> {
    const data = (await httpGetJson("https://openrouter.ai/api/v1/auth/key", {
      Authorization: `Bearer ${apiKey}`,
    })) as OpenRouterKeyResponse;

    const info = data.data;
    if (!info) throw new Error("OpenRouter 返回数据异常：无 data");
    if (typeof info.usage !== "number") {
      throw new Error("OpenRouter 返回数据异常：无 usage");
    }

    // limit 为 null / undefined 都表示没设上限。此时拿 limit - usage 会得到负数或 0，
    // 既不是余额也会误触发低余额告警，所以改用账户级 credits 接口。
    if (typeof info.limit !== "number") {
      const remaining = await creditsBalance(apiKey);
      if (remaining === null) {
        throw new Error("OpenRouter 该密钥未设额度上限，且账户 credits 接口未返回可用余额");
      }
      return {
        balance: Math.max(0, remaining),
        currency: "USD",
        available: remaining,
        raw: data as unknown as Record<string, unknown>,
      };
    }

    const remaining = info.limit - info.usage;
    return {
      balance: Math.max(0, remaining),
      currency: "USD",
      // available 保留原值（可为负，表示已超额），不要夹到 0 把「超额多少」抹掉
      available: remaining,
      raw: data as unknown as Record<string, unknown>,
    };
  },
};
