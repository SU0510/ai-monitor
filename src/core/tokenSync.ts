/**
 * 从网关同步逐日用量（输入 / 输出 / 缓存命中 token，以及当日消耗金额）。
 *
 * 本地代理只在流量经过它时才记得到 token，余额差值记账更是只有金额没有 token；
 * 而 LiteLLM 一类网关自己就按 key 记了逐日用量，`/user/daily/activity` 能直接给出
 * prompt/completion/cache 三个口径和当天 spend。这里就是把那份数据搬进本地
 * daily_usage，让用量统计与热力图显示网关的真实数字。
 *
 * 两个容易踩的点：
 * 1. 该接口**分页**。不传 page_size 只返回第一页，79 天的历史看起来只有最近 7 天，
 *    所以这里既传 page_size 又跟着 has_more 翻页（两条路互不依赖，都能取全）。
 * 2. 写入是**覆盖**而非累加（同一天重复同步不会翻倍），金额同理 ——
 *    网关的 spend 与该账户余额出自同一套预算账，单位一致，可以直接覆盖余额差值。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  buildHeaders,
  getByPath,
  toNumber,
  type CustomApiConfig,
  type TokenSyncConfig,
} from "./customApi";
import { setDailyUsage } from "./db";

export interface DailyTokenRow {
  /** YYYY-MM-DD */
  date: string;
  input: number;
  output: number;
  cacheHit: number;
  /** 当日消耗；接口没给这个字段时保持 undefined（此时不动库里的金额列） */
  cost?: number;
}

/**
 * 解析逐日用量响应。解析不出合法日期的条目直接跳过（而不是当成今天），
 * 否则接口换形状时会把别人的用量写到错误的日期上。
 */
export function parseDailyActivity(cfg: TokenSyncConfig, resp: unknown): DailyTokenRow[] {
  const list = getByPath(resp, cfg.listPath) ?? resp;
  if (!Array.isArray(list)) return [];
  const out: DailyTokenRow[] = [];
  for (const item of list) {
    const dateRaw = getByPath(item, cfg.dateField);
    const date = typeof dateRaw === "string" ? dateRaw.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const metrics = cfg.metricsPath ? getByPath(item, cfg.metricsPath) : item;
    const row: DailyTokenRow = {
      date,
      input: toNumber(getByPath(metrics, cfg.inputField)) ?? 0,
      output: toNumber(getByPath(metrics, cfg.outputField)) ?? 0,
      cacheHit: cfg.cacheReadField ? (toNumber(getByPath(metrics, cfg.cacheReadField)) ?? 0) : 0,
    };
    // 金额只在真的取到数字时才带上：undefined 表示「这次没同步到金额」，
    // 写库时会保留原值，而不是把已有金额抹成 0
    if (cfg.costField) {
      const cost = toNumber(getByPath(metrics, cfg.costField));
      if (cost !== undefined && Number.isFinite(cost)) row.cost = cost;
    }
    out.push(row);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * 是否还有下一页。只认响应自身的字段：优先 metadata.has_more，
 * 没有就用 page < total_pages 推断；两者都没有则当作单页（对不分页的接口安全）。
 */
export function hasMorePages(resp: unknown): boolean {
  const meta = getByPath(resp, "metadata");
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  if (typeof m.has_more === "boolean") return m.has_more;
  const page = toNumber(m.page);
  const total = toNumber(m.total_pages);
  if (page !== undefined && total !== undefined) return page < total;
  return false;
}

/** 把多页结果按日期合并：同一天只留一条（后出现的页覆盖旧值），按日期升序 */
export function mergeDailyPages(cfg: TokenSyncConfig, pages: readonly unknown[]): DailyTokenRow[] {
  const byDate = new Map<string, DailyTokenRow>();
  for (const p of pages) {
    for (const r of parseDailyActivity(cfg, p)) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 同步窗口。全量历史给一个足够早的起点（接口只返回真实存在的日期），
 * 增量则只取最近 days 天（含今天）。
 */
export function buildTokenRange(
  history: boolean,
  today: Date,
  days: number
): { start: string; end: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (history) return { start: "2000-01-01", end: ymd(today) };
  const s = new Date(today);
  s.setDate(s.getDate() - Math.max(0, days - 1));
  return { start: ymd(s), end: ymd(today) };
}

/** 逐日用量接口的完整 URL（路径与查询参数都来自 tokenSync 配置） */
export function buildTokenUrl(
  cfg: CustomApiConfig,
  ts: TokenSyncConfig,
  start: string,
  end: string,
  page = 1
): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const path = ts.path.startsWith("/") ? ts.path : `/${ts.path}`;
  const qs = new URLSearchParams({ start_date: start, end_date: end });
  if (ts.pageSize && ts.pageSize > 0) qs.set("page_size", String(ts.pageSize));
  if (page > 1) qs.set("page", String(page));
  return `${base}${path}?${qs.toString()}`;
}

export interface TokenSyncResult {
  days: number;
  input: number;
  output: number;
  cacheHit: number;
  /** 本次同步到的消耗金额合计（接口没给金额字段时为 0） */
  cost: number;
  start: string;
  end: string;
}

/**
 * 拉取一个账户的逐日用量并写入本地。
 * `history` 为真时覆盖全部历史，否则只同步最近 `days` 天（默认 7 天）。
 *
 * 按 has_more 翻页直到取完（最多 maxPages 页）。某一页解析不出任何合法日期时
 * 停手：继续翻只会拿到同样的垃圾，还可能无限循环。
 */
export async function syncTokensForAccount(
  accountId: number,
  cfg: CustomApiConfig,
  apiKey: string,
  opts: { history: boolean; days?: number; today?: Date }
): Promise<TokenSyncResult> {
  const ts = cfg.tokenSync;
  const empty: TokenSyncResult = {
    days: 0,
    input: 0,
    output: 0,
    cacheHit: 0,
    cost: 0,
    start: "",
    end: "",
  };
  if (!ts) return empty;

  const { start, end } = buildTokenRange(opts.history, opts.today ?? new Date(), opts.days ?? 7);
  const maxPages = Math.max(1, Math.min(50, ts.maxPages ?? 20));
  const headers = buildHeaders(cfg, apiKey);

  const pages: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let resp: unknown;
    try {
      resp = await invoke<unknown>("http_request", {
        url: buildTokenUrl(cfg, ts, start, end, page),
        method: "GET",
        headers,
        body: null,
      });
    } catch (e) {
      // 第一页就失败 → 整轮失败（调用方决定怎么报）；后续页失败则保留已经拿到的数据。
      // 这类接口偶尔会返回一次 500，重试一下就好，不该让整轮同步作废。
      if (pages.length === 0) throw e;
      console.warn(`逐日用量第 ${page} 页拉取失败，保留已取到的数据`, e);
      break;
    }
    pages.push(resp);
    if (!hasMorePages(resp)) break;
    if (parseDailyActivity(ts, resp).length === 0) break;
  }

  const rows = mergeDailyPages(ts, pages);
  const sum: TokenSyncResult = { days: 0, input: 0, output: 0, cacheHit: 0, cost: 0, start, end };
  for (const r of rows) {
    await setDailyUsage(accountId, r.date, {
      input: r.input,
      output: r.output,
      cacheHit: r.cacheHit,
      cost: r.cost,
    });
    sum.days++;
    sum.input += r.input;
    sum.output += r.output;
    sum.cacheHit += r.cacheHit;
    sum.cost += r.cost ?? 0;
  }
  return sum;
}
