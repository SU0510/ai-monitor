import type { QuotaWindow } from "../providers/types";

/**
 * 时间窗口额度（如 LiteLLM 的 3h limit）的展示工具。
 * 纯函数，不依赖 Vue，便于在灵动岛与面板间共用同一套口径。
 */

/** 常见币种符号；未知币种直接显示代码 */
const SYMBOLS: Record<string, string> = {
  USD: "$",
  CNY: "¥",
  RMB: "¥",
  EUR: "€",
  GBP: "£",
  JPY: "JP¥",
};

export function currencySymbol(currency: string): string {
  return SYMBOLS[currency?.toUpperCase()] ?? (currency || "");
}

/** 金额展示：符号 + 两位小数 */
export function formatMoney(amount: number, currency: string): string {
  const v = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currencySymbol(currency)}${v}`;
}

/** 已用比例：返回百分数（可能 >100，表示已超额） */
export function quotaPercent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.round(ratio * 100);
}

/** 进度条宽度百分比（封顶 100，超额另用颜色表示） */
export function quotaBarWidth(ratio: number): number {
  return Math.min(100, Math.max(0, quotaPercent(ratio)));
}

export type QuotaLevel = "ok" | "warn" | "danger";

/** 用量档位：<70% 正常，70~90% 提醒，>=90% 告警 */
export function quotaLevel(ratio: number): QuotaLevel {
  const pct = quotaPercent(ratio);
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "ok";
}

/**
 * 距离窗口重置的倒计时压缩文案（如 "2h13m" / "45m" / "3d2h"）。
 * resetAt 解析失败或已过期返回 null。
 */
export function resetCountdown(resetAt: string | undefined, now = Date.now()): string | null {
  if (!resetAt) return null;
  const ts = new Date(resetAt).getTime();
  if (!Number.isFinite(ts)) return null;
  const ms = ts - now;
  if (ms <= 0) return null;

  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${Math.max(1, mins)}m`;
}

/** 取账户要展示的窗口额度（默认第一个，即配置里最靠前的窗口如 "3h"） */
export function primaryQuota(quotas: QuotaWindow[] | undefined): QuotaWindow | undefined {
  return quotas && quotas.length > 0 ? quotas[0] : undefined;
}

/** 解析窗口时长文案为分钟（"3h"→180、"24h"→1440、"1d"→1440、"30m"→30）；解析失败返回 Infinity */
export function windowMinutes(window: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(window.trim());
  if (!m) return Number.POSITIVE_INFINITY;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case "d":
      return n * 1440;
    case "h":
      return n * 60;
    case "s":
      return n / 60;
    default:
      return n;
  }
}

/** 视图直接可用的限额展示数据 */
export interface QuotaView {
  window: string;
  /** 已用百分比（可 >100） */
  pct: number;
  /** 进度条宽度百分比（0~100） */
  barPct: number;
  level: QuotaLevel;
  /** 剩余额度文案（已含币种符号；超额时为 0） */
  left: string;
  /** 已用金额文案（含币种符号） */
  usedText: string;
  /** 额度上限文案（含币种符号） */
  limitText: string;
  /** 超额金额文案（含币种符号；未超额为 0） */
  overText: string;
  /** 是否已超出额度（按实际金额判断，不用四舍五入后的百分比） */
  over: boolean;
  /** 重置倒计时文案；无重置时间时为 null */
  reset: string | null;
}

/** 把一条窗口额度整理成视图需要的字段；额度缺失返回 null */
export function quotaView(
  q: QuotaWindow | undefined,
  currency: string,
  now = Date.now()
): QuotaView | null {
  if (!q) return null;
  return {
    window: q.window,
    pct: quotaPercent(q.ratio),
    barPct: quotaBarWidth(q.ratio),
    level: quotaLevel(q.ratio),
    left: formatMoney(Math.max(0, q.remaining), currency),
    usedText: formatMoney(q.spent, currency),
    limitText: formatMoney(q.limit, currency),
    overText: formatMoney(Math.max(0, -q.remaining), currency),
    over: q.remaining <= 0,
    reset: resetCountdown(q.resetAt, now),
  };
}
