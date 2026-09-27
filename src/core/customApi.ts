import { invoke } from "@tauri-apps/api/core";
import type { BalanceInfo, QuotaWindow } from "../providers/types";
import { getSetting, setSetting } from "./db";

/**
 * 自定义余额查询 API 的通用配置与提取逻辑。
 *
 * 一个配置实例 = 一个 baseUrl（可挂多把 API Key，每把 key 独立查询），
 * 与具体平台解耦：通过 JSON 路径 + 简单转换表达式从响应里提取余额。
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type FieldTransform = "none" | "subtract" | "divide" | "multiply";

export interface FieldRule {
  /** JSON 点路径（支持数组下标），如 "info.max_budget" 或 "data.balances[0].remaining" */
  source: string;
  /**
   * 主路径取不到值时的候选路径，按顺序依次尝试（对应 extractor 里的 `a ?? b ?? c`）。
   * 注意「取到 0」算取到值：余额为 0 是合法结果，不能被后面的候选路径顶掉。
   */
  altSources?: string[];
  /** 转换方式：none 直接取值；subtract/divide/multiply 对数值做运算 */
  transform: FieldTransform;
  /** 数值操作数（divide/multiply 必填；subtract 可留空改用 operandSource） */
  operand?: number;
  /** subtract 时减数从另一个字段取值，如 "info.spend" */
  operandSource?: string;
  /** 结果下限（如 remaining 不可为负，取 Math.max(clampMin, v)） */
  clampMin?: number;
}

/**
 * 时间窗口额度的提取规则（LiteLLM `/key/info` 形态）。
 *
 * 响应里有两块：额度定义列表（窗口名 + 上限 + 重置时间）与各窗口已用金额。
 * 未配置时使用 LiteLLM 默认路径；响应里没有对应路径则静默不展示限额，
 * 因此该功能对非 LiteLLM 的自定义 API 无副作用。
 */
export interface QuotaConfig {
  /** 额度列表路径（数组），如 "info.budget_limits" */
  limitsPath: string;
  /** 列表项中的窗口名字段，如 "budget_duration" */
  windowField: string;
  /** 列表项中的额度上限字段，如 "max_budget" */
  limitField: string;
  /** 列表项中的重置时间字段，如 "reset_at" */
  resetField?: string;
  /** 各窗口已用金额的路径模板，`{window}` 替换为窗口名 */
  usagePath: string;
  /** usagePath 取不到时的兜底：列表项内的已用金额字段名 */
  spentField?: string;
  /** 只展示这些窗口（按此顺序）；留空或都不存在时展示全部 */
  windows?: string[];
}

/**
 * 模型单价同步规则（LiteLLM `/model/info` 形态）。
 *
 * 从网关读取它自己那份模型清单（每个模型组 + 底层模型 + 每 token 单价），
 * 换算成「每百万 token」后写入 price_table —— 代理记账就是按这张表算费用的，
 * 所以同步后估算消耗会自动跟着网关的真实单价走，不必手工维护。
 */
export interface PriceSyncConfig {
  /** 模型清单接口路径，如 "/model/info" */
  modelInfoPath: string;
  /** 清单数组的 JSON 路径，如 "data" */
  listPath?: string;
  /** 模型组（对外别名）字段，如 "model_name" */
  groupField: string;
  /** 底层模型字段，如 "litellm_params.model"；与模型组不同时额外写一行 */
  modelField?: string;
  /** 输入单价字段 */
  inputCostField: string;
  /** 输出单价字段 */
  outputCostField: string;
  /** 缓存命中单价字段（可选） */
  cacheCostField?: string;
  /** 单价单位：perToken（网关原始值，需 ×1e6）或 perMillion（已是每百万） */
  costUnit: "perToken" | "perMillion";
  /** 网关单价的币种，如 "USD" */
  currency: string;
  /**
   * 汇率倍数：写入价格表前乘以此值。
   * 网关按美元计价、而本应用统一按人民币记账时填 7.1 之类；不换算填 1。
   */
  exchangeRate: number;
}

/**
 * 逐日 token 用量接口的提取规则（LiteLLM `/user/daily/activity` 形态）。
 *
 * 用来把网关自己记的逐日 token 搬进本地 daily_usage：本地代理只在流量经过它时
 * 才记得到 token，余额差值记账更是只有金额，所以「用量统计」里的 token 一直不准。
 */
export interface TokenSyncConfig {
  /** 逐日用量接口路径，如 "/user/daily/activity" */
  path: string;
  /** 结果数组的 JSON 路径，如 "results" */
  listPath: string;
  /** 日期字段，如 "date" */
  dateField: string;
  /** 指标对象路径，如 "metrics"；留空表示指标就在条目本身 */
  metricsPath?: string;
  /** 输入 token 字段，如 "prompt_tokens" */
  inputField: string;
  /** 输出 token 字段，如 "completion_tokens" */
  outputField: string;
  /** 缓存命中 token 字段，如 "cache_read_input_tokens" */
  cacheReadField?: string;
  /**
   * 当日消耗金额字段，如 "spend"。取到数字就一并写进 cost，
   * 让热力图与月度账单也有历史金额（该值与余额出自同一套预算账，单位一致）。
   * 留空或取不到时不动金额列，对没有该字段的接口无副作用。
   */
  costField?: string;
  /**
   * 每页条数。此类接口按页返回，**不传 page_size 只会拿到第一页** ——
   * 79 天的历史会看起来只有最近 7 天。默认 1000（实测一次即可取回全部历史）。
   */
  pageSize?: number;
  /** 最多翻多少页，防止 has_more 恒为真时死循环 */
  maxPages?: number;
}

export interface CustomApiConfig {
  /** 实例唯一标识，provider id = `custom:<id>` */
  id: string;
  /** 展示名称 */
  name: string;
  baseUrl: string;
  path: string;
  method: HttpMethod;
  /** 额外请求头；值里的 {{key}} 占位将被替换为当前这把 API Key */
  headers: Record<string, string>;
  query: Record<string, string>;
  /** 原始 JSON 文本请求体 */
  body: string;
  fields: {
    balance: FieldRule;
    available?: FieldRule;
    granted?: FieldRule;
    currency?: FieldRule;
  };
  /** 时间窗口额度提取规则（如 3 小时限额）；缺省走 LiteLLM 默认值 */
  quota?: QuotaConfig;
  /** 模型单价同步规则；缺省走 LiteLLM 默认值 */
  priceSync?: PriceSyncConfig;
  /** 逐日 token 用量同步规则；缺省走 LiteLLM 默认值 */
  tokenSync?: TokenSyncConfig;
  /** 是否随采集自动同步 token 用量（默认关；关掉则只有手动才会同步） */
  syncTokens?: boolean;
  /** 同步 token 时是否拉取全部历史（关掉则只同步最近若干天） */
  syncTokenHistory?: boolean;
  /** 是否自动注入 Authorization: Bearer <key> */
  bearerAuth: boolean;
  /** 封禁/无效判定字段路径（为真则视为无效），如 "info.blocked" */
  invalidPath?: string;
  /**
   * 「有效」判定字段路径：取到假值（false/0/""）则视为无效，取不到则视为有效。
   * 与 invalidPath 方向相反；对应的 extractor 写法是 `isValid: resp.is_active ?? true`。
   */
  validPath?: string;
  /** validPath 取不到值时的候选路径，按顺序尝试（如 `is_active ?? isValid`） */
  validAltPaths?: string[];
  /** 封禁时的提示文案 */
  invalidMessage?: string;
}

/** LiteLLM `/key/info` 的额度提取默认值：展示 3 小时窗口 */
export function litellmQuotaDefaults(): QuotaConfig {
  return {
    limitsPath: "info.budget_limits",
    windowField: "budget_duration",
    limitField: "max_budget",
    resetField: "reset_at",
    usagePath: "info.budget_limits_usage.{window}.current_spend",
    spentField: "current_spend",
    windows: ["3h"],
  };
}

/** LiteLLM `/model/info` 的单价同步默认值 */
export function litellmPriceDefaults(): PriceSyncConfig {
  return {
    modelInfoPath: "/model/info",
    listPath: "data",
    groupField: "model_name",
    modelField: "litellm_params.model",
    inputCostField: "model_info.input_cost_per_token",
    outputCostField: "model_info.output_cost_per_token",
    cacheCostField: "model_info.cache_read_input_token_cost",
    costUnit: "perToken",
    currency: "USD",
    exchangeRate: 1,
  };
}

/** LiteLLM `/user/daily/activity` 的逐日用量默认路径 */
export function litellmTokenSyncDefaults(): TokenSyncConfig {
  return {
    path: "/user/daily/activity",
    listPath: "results",
    dateField: "date",
    metricsPath: "metrics",
    inputField: "prompt_tokens",
    outputField: "completion_tokens",
    cacheReadField: "cache_read_input_tokens",
    costField: "spend",
    pageSize: 1000,
    maxPages: 20,
  };
}

const CONFIG_STORAGE_KEY = "custom_api_configs";

export function newConfigId(): string {
  // 自生成随机 id，避免在非 secure context 下 crypto.randomUUID 不可用
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

/**
 * LiteLLM `/key/info` 默认模板：
 *   total = info.max_budget, used = info.spend, remaining = max(0, total - used)
 *   unit = USD, isValid = !info.blocked
 * 用户一般只需填 name/baseUrl 与 key。
 */
export function litellmPreset(): CustomApiConfig {
  return {
    id: newConfigId(),
    name: "LiteLLM",
    baseUrl: "",
    path: "/key/info",
    method: "GET",
    headers: {},
    query: {},
    body: "",
    fields: {
      balance: {
        source: "info.max_budget",
        transform: "subtract",
        operandSource: "info.spend",
        clampMin: 0,
      },
      available: { source: "info.max_budget", transform: "none" },
      granted: { source: "info.spend", transform: "none" },
      currency: { source: "info.currency", transform: "none" },
    },
    quota: litellmQuotaDefaults(),
    priceSync: litellmPriceDefaults(),
    tokenSync: litellmTokenSyncDefaults(),
    syncTokens: false,
    syncTokenHistory: false,
    bearerAuth: true,
    invalidPath: "info.blocked",
    invalidMessage: "API Key 已被封禁",
  };
}

/**
 * 通用余额接口模板：`GET {baseUrl}/v1/usage`，Bearer 鉴权。
 *
 * 对应这样一份 extractor：
 *   remaining = resp.remaining ?? resp.quota.remaining ?? resp.balance
 *   unit      = resp.unit ?? resp.quota.unit ?? "USD"
 *   isValid   = resp.is_active ?? resp.isValid ?? true
 * 用本应用的声明式写法表达：路径候选放进 altSources / validAltPaths，
 * 「取不到就当有效」由 validPath 的判定方向保证（只有显式假值才算无效）。
 *
 * 额度窗口与单价同步沿用通用默认值（LiteLLM 形态）；响应里没有那些路径时
 * 限额块不展示、单价同步也不会被触发，对普通接口无副作用。
 */
export function genericUsagePreset(): CustomApiConfig {
  return {
    id: newConfigId(),
    name: "",
    baseUrl: "",
    path: "/v1/usage",
    method: "GET",
    headers: {},
    query: {},
    body: "",
    fields: {
      balance: {
        source: "remaining",
        altSources: ["quota.remaining", "balance"],
        transform: "none",
        clampMin: 0,
      },
      currency: {
        source: "unit",
        altSources: ["quota.unit"],
        transform: "none",
      },
    },
    quota: litellmQuotaDefaults(),
    priceSync: litellmPriceDefaults(),
    tokenSync: litellmTokenSyncDefaults(),
    syncTokens: false,
    syncTokenHistory: false,
    bearerAuth: true,
    validPath: "is_active",
    validAltPaths: ["isValid"],
    invalidMessage: "账户无效或已被封禁",
  };
}

export async function loadCustomConfigs(): Promise<CustomApiConfig[]> {
  const raw = await getSetting(CONFIG_STORAGE_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CustomApiConfig[];
    if (!Array.isArray(parsed)) return [];
    // 老配置没有 quota / priceSync 段：补上 LiteLLM 默认值，使既有账户无需重建即可用
    return parsed.map((c) => ({
      ...c,
      quota: c.quota ?? litellmQuotaDefaults(),
      priceSync: c.priceSync ?? litellmPriceDefaults(),
      tokenSync: c.tokenSync ?? litellmTokenSyncDefaults(),
    }));
  } catch {
    return [];
  }
}

export async function saveCustomConfigs(configs: CustomApiConfig[]): Promise<void> {
  await setSetting(CONFIG_STORAGE_KEY, JSON.stringify(configs));
}

// ---------------- JSON 路径提取 ----------------

/** 按点路径（支持数组下标）从对象里取值 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  const tokens = path
    .split(".")
    .flatMap((seg) => seg.split(/\[|\]/))
    .filter((s) => s !== "");
  let cur: unknown = obj;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(tok);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * 按顺序尝试多个路径，返回第一个「取到了值」的结果。
 * 只有 undefined / null 算取不到：0 与 "" 都是有效结果，不能被后面的候选顶掉
 * （余额 0 必须原样返回，否则会读成另一个字段的金额）。
 */
export function getByPaths(obj: unknown, paths: readonly (string | undefined)[]): unknown {
  for (const p of paths) {
    if (!p) continue;
    const v = getByPath(obj, p);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function extractField(resp: unknown, rule: FieldRule | undefined): number | string | undefined {
  if (!rule) return undefined;
  const raw = getByPaths(resp, [rule.source, ...(rule.altSources ?? [])]);
  if (rule.transform === "none") {
    const n = toNumber(raw);
    return n !== undefined ? n : typeof raw === "string" ? raw : undefined;
  }
  const base = toNumber(raw);
  if (base === undefined) return undefined;
  switch (rule.transform) {
    case "divide":
      return rule.operand ? base / rule.operand : base;
    case "multiply":
      return rule.operand !== undefined ? base * rule.operand : base;
    case "subtract": {
      let operand: number | undefined;
      if (rule.operand !== undefined) operand = rule.operand;
      else if (rule.operandSource) operand = toNumber(getByPath(resp, rule.operandSource));
      return operand !== undefined ? base - operand : base;
    }
    default:
      return base;
  }
}

/** 对提取结果应用下限约束（remaining >= clampMin） */
function applyClamp(v: number | undefined, rule: FieldRule | undefined): number | undefined {
  if (v === undefined) return v;
  if (rule?.clampMin !== undefined) return Math.max(rule.clampMin, v);
  return v;
}

/**
 * 从响应里解析时间窗口额度（如 LiteLLM 的 3h / 12h / 24h）。
 *
 * 解析不出的窗口会被跳过而非按 0 展示，避免路径写错时显示出假的「已用 0」。
 * 配置的 windows 全部不存在时退回展示响应里的全部窗口，便于排查配置。
 */
export function extractQuotas(resp: unknown, quota?: QuotaConfig): QuotaWindow[] {
  const q = quota ?? litellmQuotaDefaults();
  const rawLimits = getByPath(resp, q.limitsPath);
  if (!Array.isArray(rawLimits)) return [];

  let limits: { window: string; limit: number; resetAt?: string }[] = [];
  for (const item of rawLimits) {
    const window = String(getByPath(item, q.windowField) ?? "").trim();
    const limit = toNumber(getByPath(item, q.limitField));
    if (!window || limit === undefined || limit <= 0) continue;
    const resetRaw = q.resetField ? getByPath(item, q.resetField) : undefined;
    limits.push({
      window,
      limit,
      resetAt: typeof resetRaw === "string" && resetRaw !== "" ? resetRaw : undefined,
    });
  }

  if (q.windows && q.windows.length > 0) {
    const picked = q.windows
      .map((w) => limits.find((l) => l.window === w))
      .filter((l): l is { window: string; limit: number; resetAt?: string } => l !== undefined);
    if (picked.length > 0) limits = picked;
  }

  const out: QuotaWindow[] = [];
  for (const l of limits) {
    const usagePath = q.usagePath.replace(/\{\s*window\s*\}/g, l.window);
    let spent = toNumber(getByPath(resp, usagePath));
    if (spent === undefined && q.spentField) {
      const idx = rawLimits.findIndex(
        (it) => String(getByPath(it, q.windowField) ?? "").trim() === l.window
      );
      if (idx >= 0) spent = toNumber(getByPath(rawLimits[idx], q.spentField));
    }
    if (spent === undefined) continue;
    out.push({
      window: l.window,
      limit: l.limit,
      spent,
      remaining: l.limit - spent,
      ratio: spent / l.limit,
      resetAt: l.resetAt,
    });
  }
  return out;
}

// ---------------- 请求与解析 ----------------

export function buildUrl(cfg: CustomApiConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const path = cfg.path.startsWith("/") ? cfg.path : `/${cfg.path}`;
  // 避免用户已把完整路径（含 path）填进 baseUrl 时重复拼接
  if (path && base.endsWith(path)) {
    const qs = new URLSearchParams(cfg.query).toString();
    return qs ? `${base}?${qs}` : base;
  }
  const qs = new URLSearchParams(cfg.query).toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

export function buildHeaders(cfg: CustomApiConfig, apiKey: string): Array<[string, string]> {
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers)) {
    map[k] = v.replace(/\{\{\s*(?:key|apiKey)\s*\}\}/g, apiKey);
  }
  if (cfg.bearerAuth && apiKey) {
    map.Authorization = `Bearer ${apiKey}`;
  }
  return Object.entries(map);
}

export interface ExtractResult {
  info: BalanceInfo;
  raw: unknown;
}

/**
 * 把一次接口响应解析成 BalanceInfo（纯函数，不碰网络，便于单测）。
 *
 * 有效性两条判定方向相反，invalidPath 优先：
 * - invalidPath 取到真值 → 无效（`isValid: !resp.blocked`）
 * - validPath 取到假值 → 无效，取不到 → 有效（`isValid: resp.is_active ?? true`）
 */
export function parseCustomResponse(cfg: CustomApiConfig, resp: unknown): ExtractResult {
  if (cfg.invalidPath && getByPath(resp, cfg.invalidPath)) {
    throw new Error(cfg.invalidMessage ?? "账户无效或已被封禁");
  }
  if (cfg.validPath || cfg.validAltPaths?.length) {
    const v = getByPaths(resp, [cfg.validPath, ...(cfg.validAltPaths ?? [])]);
    if (v !== undefined && !v) {
      throw new Error(cfg.invalidMessage ?? "账户无效或已被封禁");
    }
  }

  const balance = applyClamp(
    toNumber(extractField(resp, cfg.fields.balance)),
    cfg.fields.balance
  );
  if (balance === undefined) {
    throw new Error(
      `无法从响应提取余额字段（路径：${cfg.fields.balance?.source ?? "(未配置)"}）`
    );
  }

  const available = applyClamp(toNumber(extractField(resp, cfg.fields.available)), cfg.fields.available);
  const granted = applyClamp(toNumber(extractField(resp, cfg.fields.granted)), cfg.fields.granted);
  const currencyRaw = extractField(resp, cfg.fields.currency);
  const currency = typeof currencyRaw === "string" && currencyRaw !== "" ? currencyRaw : "USD";
  const quotas = extractQuotas(resp, cfg.quota);

  return {
    info: {
      balance,
      currency,
      available,
      granted,
      quotas,
      raw: resp as Record<string, unknown>,
    },
    raw: resp,
  };
}

/**
 * 发起一次自定义余额查询并解析出 BalanceInfo。
 * `requestBody` 供测试请求复用：传入时用给定体，否则用配置里的 body。
 */
export async function requestCustomBalance(
  cfg: CustomApiConfig,
  apiKey: string,
  requestBody?: string
): Promise<ExtractResult> {
  let bodyValue: unknown = undefined;
  const bodyText = requestBody !== undefined ? requestBody : cfg.body;
  if (bodyText && bodyText.trim() !== "") {
    try {
      bodyValue = JSON.parse(bodyText);
    } catch {
      bodyValue = bodyText;
    }
  }

  const resp = await invoke<unknown>("http_request", {
    url: buildUrl(cfg),
    method: cfg.method,
    headers: buildHeaders(cfg, apiKey),
    body: bodyValue ?? null,
  });

  return parseCustomResponse(cfg, resp);
}
