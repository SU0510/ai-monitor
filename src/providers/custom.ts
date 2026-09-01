import type { BalanceInfo, Provider } from "./types";
import { requestCustomBalance, type CustomApiConfig } from "../core/customApi";

export const CUSTOM_PREFIX = "custom:";

/**
 * 由一份自定义 API 配置构建出一个 Provider。
 * 一个 baseUrl = 一个 provider 实例；多把 key 通过添加多个账户（同一 provider_id）实现。
 */
export function buildCustomProvider(cfg: CustomApiConfig): Provider {
  return {
    id: `${CUSTOM_PREFIX}${cfg.id}`,
    name: cfg.name,
    balanceSupported: true,
    docs: cfg.baseUrl,

    async getBalance(apiKey: string): Promise<BalanceInfo> {
      const { info } = await requestCustomBalance(cfg, apiKey);
      return info;
    },
  };
}
