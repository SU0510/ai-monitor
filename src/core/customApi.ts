import { invoke } from "@tauri-apps/api/core";
import type { BalanceInfo } from "../providers/types";
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
  /** 转换方式：none 直接取值；subtract/divide/multiply 对数值做运算 */
  transform: FieldTransform;
  /** 数值操作数（divide/multiply 必填；subtract 可留空改用 operandSource） */
  operand?: number;
  /** subtract 时减数从另一个字段取值，如 "info.spend" */
  operandSource?: string;
  /** 结果下限（如 remaining 不可为负，取 Math.max(clampMin, v)） */
  clampMin?: number;
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
  /** 是否自动注入 Authorization: Bearer <key> */
  bearerAuth: boolean;
  /** 封禁/无效判定字段路径（为真则视为无效），如 "info.blocked" */
  invalidPath?: string;
  /** 封禁时的提示文案 */
  invalidMessage?: string;
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
    bearerAuth: true,
    invalidPath: "info.blocked",
    invalidMessage: "API Key 已被封禁",
  };
}

export async function loadCustomConfigs(): Promise<CustomApiConfig[]> {
  const raw = await getSetting(CONFIG_STORAGE_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CustomApiConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveCustomConfigs(configs: CustomApiConfig[]): Promise<void> {
  await setSetting(CONFIG_STORAGE_KEY, JSON.stringify(configs));
}

// ---------------- JSON 路径提取 ----------------

/** 按点路径（支持数组下标）从对象里取值 */
function getByPath(obj: unknown, path: string): unknown {
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

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function extractField(resp: unknown, rule: FieldRule | undefined): number | string | undefined {
  if (!rule) return undefined;
  const raw = getByPath(resp, rule.source);
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

// ---------------- 请求与解析 ----------------

function buildUrl(cfg: CustomApiConfig): string {
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

function buildHeaders(cfg: CustomApiConfig, apiKey: string): Array<[string, string]> {
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

  // 封禁判定
  if (cfg.invalidPath && getByPath(resp, cfg.invalidPath)) {
    throw new Error(cfg.invalidMessage ?? "账户无效或已被封禁");
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

  return {
    info: {
      balance,
      currency,
      available,
      granted,
      raw: resp as Record<string, unknown>,
    },
    raw: resp,
  };
}
