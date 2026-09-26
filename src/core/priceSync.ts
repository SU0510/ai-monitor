import { invoke } from "@tauri-apps/api/core";
import { setSetting, upsertPrice } from "./db";
import {
  buildHeaders,
  buildUrl,
  getByPath,
  litellmPriceDefaults,
  loadCustomConfigs,
  toNumber,
  type CustomApiConfig,
  type PriceSyncConfig,
} from "./customApi";
import { CUSTOM_PREFIX } from "../providers/custom";

/**
 * 从网关自动读取模型清单（模型组 / 底层模型 / 单价）并写入 price_table。
 *
 * 为什么要写进 price_table：本地代理（src-tauri/src/proxy.rs）就是按这张表
 * 精确匹配 provider_id + model 来估算每次请求费用的，所以同步之后估算消耗
 * 会直接跟随网关的真实单价，不需要手工逐个维护。
 */

export interface GatewayModelPrice {
  /** 模型组（对外别名）——客户端请求里实际发送的名字，代理按它匹配 */
  group: string;
  /** 底层模型；与模型组相同则为空 */
  model?: string;
  /** 每百万 token 单价（已按 costUnit 与 exchangeRate 换算） */
  input: number;
  output: number;
  cache: number;
  currency: string;
}

const PER_MILLION = 1_000_000;

function toPerMillion(value: number | undefined, unit: PriceSyncConfig["costUnit"]): number {
  if (value === undefined) return 0;
  return unit === "perToken" ? value * PER_MILLION : value;
}

/**
 * 解析网关的模型清单。
 *
 * 取不到任何单价的条目会被跳过而不是写成 0：单价 0 会让代理把该模型的费用
 * 恒算为 0，是「看起来正常但账单全是错的」那种故障。
 */
export function parseGatewayPrices(resp: unknown, cfg?: PriceSyncConfig): GatewayModelPrice[] {
  const c = cfg ?? litellmPriceDefaults();
  const list = c.listPath ? getByPath(resp, c.listPath) : resp;
  const items = Array.isArray(list) ? list : [];
  const rate = Number.isFinite(c.exchangeRate) && c.exchangeRate > 0 ? c.exchangeRate : 1;
  // 保留 9 位小数：既压掉浮点噪声，又不会把小额单价（如 perMillion 单位下的 2.5e-6）抹成 0
  const round = (n: number): number => +n.toFixed(9);

  const out: GatewayModelPrice[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const group = String(getByPath(item, c.groupField) ?? "").trim();
    if (!group || seen.has(group)) continue;
    const inputRaw = toNumber(getByPath(item, c.inputCostField));
    const outputRaw = toNumber(getByPath(item, c.outputCostField));
    if (inputRaw === undefined && outputRaw === undefined) continue;
    const cacheRaw = c.cacheCostField ? toNumber(getByPath(item, c.cacheCostField)) : undefined;
    const modelRaw = c.modelField ? getByPath(item, c.modelField) : undefined;
    const model = typeof modelRaw === "string" ? modelRaw.trim() : "";
    seen.add(group);
    out.push({
      group,
      model: model && model !== group ? model : undefined,
      input: round(toPerMillion(inputRaw, c.costUnit) * rate),
      output: round(toPerMillion(outputRaw, c.costUnit) * rate),
      cache: round(toPerMillion(cacheRaw, c.costUnit) * rate),
      currency: c.currency,
    });
  }
  return out;
}

/** 拉取网关模型清单（模型接口路径与余额接口不同，复用同一套 URL/请求头构造） */
export async function fetchGatewayPrices(
  cfg: CustomApiConfig,
  apiKey: string
): Promise<GatewayModelPrice[]> {
  const sync = cfg.priceSync ?? litellmPriceDefaults();
  const probe: CustomApiConfig = {
    ...cfg,
    path: sync.modelInfoPath,
    method: "GET",
    query: {},
    body: "",
  };
  const resp = await invoke<unknown>("http_request", {
    url: buildUrl(probe),
    method: "GET",
    headers: buildHeaders(probe, apiKey),
    body: null,
  });
  return parseGatewayPrices(resp, sync);
}

export interface PriceSyncResult {
  providerId: string;
  /** 写入 price_table 的行数（模型组 + 底层模型） */
  rows: number;
  /** 网关返回的模型组数量 */
  groups: number;
  currency: string;
}

/**
 * 同步某一个自定义 API（即某个网关）的模型单价。
 * 需要传一把能读取该网关模型清单的 key（多数网关要求管理密钥）。
 */
export async function syncGatewayPrices(
  configId: string,
  apiKey: string
): Promise<PriceSyncResult> {
  const configs = await loadCustomConfigs();
  const cfg = configs.find((c) => c.id === configId);
  if (!cfg) throw new Error("自定义 API 配置不存在，请先在账户页重新保存该网关");

  const prices = await fetchGatewayPrices(cfg, apiKey);
  if (prices.length === 0) {
    throw new Error("网关未返回任何带单价的模型，请检查接口路径与 JSON 路径配置");
  }

  const providerId = `${CUSTOM_PREFIX}${cfg.id}`;
  let rows = 0;
  for (const p of prices) {
    const payload = {
      providerId,
      inputPrice: p.input,
      outputPrice: p.output,
      cacheHitPrice: p.cache,
      currency: p.currency,
    };
    // 模型组是请求里真正发送的名字，必须写入（代理按它匹配）；
    // 底层模型名一并写入，便于直接用底层名请求时也能计费。
    await upsertPrice({ ...payload, model: p.group });
    rows++;
    if (p.model) {
      await upsertPrice({ ...payload, model: p.model });
      rows++;
    }
  }

  await setSetting(`price_sync_at_${cfg.id}`, new Date().toISOString());
  return {
    providerId,
    rows,
    groups: prices.length,
    currency: cfg.priceSync?.currency ?? "USD",
  };
}
