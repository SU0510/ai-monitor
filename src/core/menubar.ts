import { currencySymbol, formatMoney, type QuotaView } from "./quota";

/**
 * macOS 菜单栏（托盘）显示配置与渲染。
 *
 * 纯函数，不依赖 Vue / Tauri：
 *  - 托盘实际显示（menubarSync 推送给 Rust）
 *  - 设置页的实时预览
 * 用的是同一个 renderMenubar，所以预览不可能与真实菜单栏不一致。
 *
 * 注意：set_title 在 Windows 上不受支持，菜单栏文字只在 macOS 生效；
 * Windows/Linux 靠 tooltip 与下拉菜单承载同样的信息，因此渲染结果三者都产出。
 */

export type MenubarMetric = "balance" | "todayCost" | "tokens" | "quota";

/** 标题排布方式：segments = 所有组件并排成一段；rotate = 定时轮播（同一 baseUrl 的多把 key 轮流单独出现） */
export type MenubarTitleMode = "segments" | "rotate";

export interface MenubarSlot {
  /** 稳定标识，供设置页排序/删除 */
  id: string;
  /** aggregate = 所有账户汇总；account = 指定某把 key（同一 baseUrl 的不同 key 各自成一个槽位） */
  kind: "aggregate" | "account";
  metric: MenubarMetric;
  /** kind === "account" 时有意义 */
  accountId?: number;
  /** metric === "quota" 时指定窗口；留空取该账户最紧的窗口 */
  window?: string;
  /** 覆盖显示名（默认用账户名） */
  label?: string;
  /** 紧凑格式：16.50 -> 16.5，1330 -> 1.3K */
  compact?: boolean;
}

export interface MenubarConfig {
  showTitle: boolean;
  showIcon: boolean;
  titleMode: MenubarTitleMode;
  /** 轮播间隔秒数（titleMode === "rotate"） */
  rotateSecs: number;
  /** 组件之间的分隔符 */
  separator: string;
  /** 要显示的组件（顺序即显示顺序） */
  slots: MenubarSlot[];
  /** 标题里最多出现几个「指定 key」槽位，超出折叠为 +N；仅 segments 模式生效 */
  maxSegments: number;
  /** 下拉菜单里逐 key 列出（列出的内容就是当前勾选的全部槽位） */
  menuAccounts: boolean;
  /** 轮播时把每帧补齐到最宽一帧，避免菜单栏左右跳动 */
  rotateFixedWidth: boolean;
  /** 极简模式：只留数字，去掉账户名与单位，金额固定 1 位小数 */
  minimal: boolean;
  /** 极简模式下是否带货币符号（¥）；关掉就是纯数字 */
  minimalSymbol: boolean;
}

export interface MenubarAccountData {
  id: number;
  /** 账户名（用户可在账户列表重命名） */
  label: string;
  currency: string;
  balance: number | null;
  todayCost: number;
  tokens: number;
  /** 该账户最紧的窗口额度 */
  quota: QuotaView | null;
}

export interface MenubarTotalsData {
  currency: string;
  balance: number;
  todayCost: number;
  tokens: number;
  quota: QuotaView | null;
}

export interface MenubarData {
  accounts: MenubarAccountData[];
  totals: MenubarTotalsData;
  /** 正在采集 / 上次采集有错误，用于在标题里体现状态 */
  collecting: boolean;
  hasError: boolean;
}

export interface MenubarMenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

export interface MenubarRender {
  /** 候选标题：segments 模式固定 1 条；rotate 模式多条（定时轮换） */
  titles: string[];
  /** Windows/Linux 上承载同信息的悬停提示（macOS 也有） */
  tooltip: string | null;
  /** 下拉菜单动态区（Rust 会在其后追加分隔线与固定操作项） */
  menu: MenubarMenuItem[];
  /** 因超出 maxSegments 被折叠的 key 数量 */
  overflow: number;
}

export const MENUBAR_CONFIG_KEY = "menubar_config";

export function defaultMenubarConfig(): MenubarConfig {
  return {
    showTitle: true,
    showIcon: true,
    titleMode: "segments",
    rotateSecs: 5,
    separator: "·",
    slots: [
      { id: "agg-balance", kind: "aggregate", metric: "balance" },
      { id: "agg-today", kind: "aggregate", metric: "todayCost" },
      { id: "agg-tokens", kind: "aggregate", metric: "tokens" },
    ],
    maxSegments: 3,
    menuAccounts: true,
    rotateFixedWidth: true,
    minimal: false,
    minimalSymbol: true,
  };
}

const METRICS: MenubarMetric[] = ["balance", "todayCost", "tokens", "quota"];
const MODES: MenubarTitleMode[] = ["segments", "rotate"];
const MAX_SLOTS = 12;

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** 正整数，越界回落默认值 */
function asPositiveInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function asMetric(v: unknown, fallback: MenubarMetric): MenubarMetric {
  return METRICS.includes(v as MenubarMetric) ? (v as MenubarMetric) : fallback;
}

/**
 * 把 settings 里读到的任意 JSON 归一化成合法配置。
 * 老版本没有这个键、或用户手改坏了 JSON，都要能安全退回默认值，
 * 否则菜单栏会直接空白（配置是整个渲染的唯一输入）。
 */
export function normalizeMenubarConfig(raw: unknown): MenubarConfig {
  const def = defaultMenubarConfig();
  if (!raw || typeof raw !== "object") return def;
  const o = raw as Record<string, unknown>;

  const slots: MenubarSlot[] = [];
  if (Array.isArray(o.slots)) {
    for (const item of o.slots.slice(0, MAX_SLOTS)) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;
      const kind = s.kind === "account" ? "account" : "aggregate";
      const metric = asMetric(s.metric, "balance");
      const accountId = typeof s.accountId === "number" ? s.accountId : undefined;
      // 指定账户但没给 accountId 的槽位渲染不出内容，属于坏配置
      if (kind === "account" && accountId === undefined) continue;
      slots.push({
        id: asString(s.id, `${kind}-${metric}-${slots.length}`),
        kind,
        metric,
        accountId,
        window: typeof s.window === "string" && s.window ? s.window : undefined,
        label: typeof s.label === "string" && s.label ? s.label : undefined,
        compact: typeof s.compact === "boolean" ? s.compact : undefined,
      });
    }
  }

  return {
    showTitle: asBool(o.showTitle, def.showTitle),
    showIcon: asBool(o.showIcon, def.showIcon),
    titleMode: MODES.includes(o.titleMode as MenubarTitleMode)
      ? (o.titleMode as MenubarTitleMode)
      : def.titleMode,
    rotateSecs: asPositiveInt(o.rotateSecs, def.rotateSecs, 2, 600),
    separator: asString(o.separator, def.separator).slice(0, 3),
    slots,
    maxSegments: asPositiveInt(o.maxSegments, def.maxSegments, 1, MAX_SLOTS),
    menuAccounts: asBool(o.menuAccounts, def.menuAccounts),
    rotateFixedWidth: asBool(o.rotateFixedWidth, def.rotateFixedWidth),
    minimal: asBool(o.minimal, def.minimal),
    minimalSymbol: asBool(o.minimalSymbol, def.minimalSymbol),
  };
}

/** token 数压缩（1330 -> 1.3K，2500000 -> 2.5M） */
export function compactTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "G";
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

/** 金额压缩（菜单栏宽度有限）：1.2K 级保留一位小数，百元级取整 */
export function compactMoney(amount: number, currency: string): string {
  const sym = currencySymbol(currency);
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 10_000) return `${sign}${sym}${(abs / 1000).toFixed(1)}K`;
  if (abs >= 100) return `${sign}${sym}${Math.round(abs)}`;
  if (abs >= 10) return `${sign}${sym}${abs.toFixed(1)}`;
  return `${sign}${sym}${abs.toFixed(2)}`;
}

function money(amount: number, currency: string, compact: boolean): string {
  return compact ? compactMoney(amount, currency) : formatMoney(amount, currency);
}

/** 极简模式的金额：固定 1 位小数、无千分位；withSymbol 决定要不要 ¥ */
export function formatMoney1(amount: number, currency: string, withSymbol: boolean): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount).toFixed(1);
  return withSymbol ? `${sign}${currencySymbol(currency)}${abs}` : `${sign}${abs}`;
}

/** 单条额度槽位的文案（如 "3h 55%"）；无额度数据返回 null */
function quotaText(q: QuotaView | null, window?: string): string | null {
  if (!q) return null;
  if (window && q.window !== window) return null;
  return `${q.window} ${q.pct}%`;
}

export interface SlotTextOptions {
  /** 指定 key 的槽位是否带账户名前缀（默认带；tooltip 与预览需要，极简模式不要） */
  label?: boolean;
  /** 极简模式：去掉账户名与单位，金额固定 1 位小数 */
  minimal?: boolean;
  /** 极简模式下是否带货币符号（默认带） */
  symbol?: boolean;
}

/**
 * 把一个槽位渲染成文本；数据缺失返回 null（该槽位不显示，而不是显示 0 或占位符）。
 */
export function slotText(
  slot: MenubarSlot,
  data: MenubarData,
  opts: SlotTextOptions = {}
): string | null {
  const minimal = opts.minimal === true;
  const withSymbol = opts.symbol !== false;
  const showLabel = (opts.label ?? true) && !minimal;

  const account =
    slot.kind === "account" ? data.accounts.find((a) => a.id === slot.accountId) : null;
  // 指定了账户但账户已删除：不显示，避免留下一个名字对不上的空槽
  if (slot.kind === "account" && !account) return null;

  const label = slot.label ?? account?.label ?? "";
  const compact = slot.compact === true;
  const prefix = showLabel && slot.kind === "account" && label ? `${label} ` : "";

  if (slot.metric === "balance") {
    if (slot.kind === "account") {
      if (account!.balance === null) return null;
      const v = account!.balance;
      const cur = account!.currency;
      return `${prefix}${minimal ? formatMoney1(v, cur, withSymbol) : money(v, cur, compact)}`;
    }
    const v = data.totals.balance;
    const cur = data.totals.currency;
    return minimal ? formatMoney1(v, cur, withSymbol) : money(v, cur, compact);
  }

  if (slot.metric === "todayCost") {
    const cost = slot.kind === "account" ? account!.todayCost : data.totals.todayCost;
    const currency = slot.kind === "account" ? account!.currency : data.totals.currency;
    // 极简模式下余额与花费都是裸数字，用「-」区分花费
    if (minimal) return `-${formatMoney1(Math.abs(cost), currency, withSymbol)}`;
    return `${prefix}-${money(cost, currency, compact)}`;
  }

  if (slot.metric === "tokens") {
    const tokens = slot.kind === "account" ? account!.tokens : data.totals.tokens;
    if (minimal) return compactTokens(tokens);
    return `${prefix}${compactTokens(tokens)} tok`;
  }

  const text = quotaText(slot.kind === "account" ? account!.quota : data.totals.quota, slot.window);
  if (text === null) return null;
  // 极简模式下只留百分比
  return minimal ? `${quotaPercentText(text)}` : `${prefix}${text}`;
}

/** 从 "3h 55%" 里取出 "55%"（极简模式不要窗口名） */
function quotaPercentText(text: string): string {
  const m = /(\d+%)$/.exec(text);
  return m ? m[1] : text;
}

/** 全角/中日韩字符在菜单栏里占两个字宽 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
}

/** 估算菜单栏里的占位宽度（全角算 2，半角算 1；比例字体下是近似值） */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

const NBSP = "\u00a0";

/**
 * 窄空格（U+2009）。极简模式一帧里塞的数字最多，分隔符两侧还用普通空格会显得松散，
 * 换成窄空格后数字与分隔符之间仍留空隙，但明显更紧。
 */
const THIN = "\u2009";

/**
 * 轮播时各帧长短不同会让菜单栏项左右跳动（名字长短、缺某个指标都会变）。
 * 菜单栏项由系统右对齐排布，所以把每帧尾部补不换行空格到同一宽度后，
 * 项的盒子宽度恒定，帧内文字起点也随之恒定，看起来就是「不动」。
 * 只有一帧时无需补齐。
 */
function padToWidest(titles: string[]): string[] {
  if (titles.length <= 1) return titles;
  const widest = Math.max(...titles.map(displayWidth));
  return titles.map((t) => t + NBSP.repeat(Math.max(0, widest - displayWidth(t))));
}

/** 采集状态前缀：出错优先于采集中（一眼能看出数据是旧的） */
function statePrefix(data: MenubarData): string {
  if (data.hasError) return "!";
  if (data.collecting) return "…";
  return "";
}

/**
 * 下拉菜单：把当前勾选的全部槽位列出来——汇总一行，每个 key 一行，
 * 行内把该 key 的所有槽位并在一起。菜单内容与菜单栏文字同源，改配置两边一起变。
 */
function buildMenu(cfg: MenubarConfig, data: MenubarData, sep: string): MenubarMenuItem[] {
  if (!cfg.menuAccounts) return [];
  const rows: MenubarMenuItem[] = [];

  const aggregateSlots = cfg.slots.filter((s) => s.kind === "aggregate");
  const aggParts = aggregateSlots
    .map((s) => slotText(s, data, { label: false }))
    .filter((x): x is string => x !== null);
  if (aggParts.length > 0) {
    const aggLabel = aggregateSlots.find((s) => s.label)?.label;
    const text = aggParts.join(sep);
    rows.push({ id: "agg", label: aggLabel ? `${aggLabel} ${text}` : text, enabled: true });
  }

  // 按配置顺序收集每个 key 的槽位（同一把 key 的多个指标并成一行）
  const order: number[] = [];
  const byAccount = new Map<number, MenubarSlot[]>();
  for (const s of cfg.slots) {
    if (s.kind !== "account") continue;
    const id = s.accountId as number;
    const list = byAccount.get(id);
    if (list) list.push(s);
    else {
      byAccount.set(id, [s]);
      order.push(id);
    }
  }

  for (const id of order) {
    const acc = data.accounts.find((a) => a.id === id);
    // 账户已删除：不列这一行，避免名字对不上的残留条目
    if (!acc) continue;
    const slots = byAccount.get(id)!;
    const parts = slots
      .map((s) => slotText(s, data, { label: false }))
      .filter((x): x is string => x !== null);
    if (parts.length === 0) continue;
    const label = slots.find((s) => s.label)?.label ?? acc.label;
    rows.push({ id: `acc-${id}`, label: `${label} ${parts.join(sep)}`, enabled: true });
  }

  return rows;
}

/**
 * 组装菜单栏最终显示内容。
 *
 * segments 模式：所有槽位并排，超出 maxSegments 的「指定 key」槽位折叠成 +N。
 * rotate 模式：汇总槽位合成一帧，每个「指定 key」各自一帧，由调用方定时轮换。
 */
export function renderMenubar(cfg: MenubarConfig, data: MenubarData): MenubarRender {
  const sep = ` ${cfg.separator} `;
  // 极简模式（只留数字）用窄空格分隔：数字与「·」之间更紧凑
  const tightSep = `${THIN}${cfg.separator}${THIN}`;
  const accountSlots = cfg.slots.filter((s) => s.kind === "account");
  const aggregateSlots = cfg.slots.filter((s) => s.kind === "aggregate");

  const menu = buildMenu(cfg, data, sep);

  const titles: string[] = [];
  let overflow = 0;

  if (cfg.showTitle) {
    const prefix = statePrefix(data);
    if (cfg.minimal) {
      // 极简：只按顺序排数字，不带账户名/单位，也不做 +N 折叠（本来就很短）
      const parts = cfg.slots
        .map((s) => slotText(s, data, { minimal: true, symbol: cfg.minimalSymbol }))
        .filter((x): x is string => x !== null);
      if (parts.length > 0) titles.push(prefix + parts.join(tightSep));
    } else if (cfg.titleMode === "rotate") {
      // 轮播：一帧内不混多个 key，这样同一 baseUrl 的多把 key 在时间上分开出现
      const aggText = aggregateSlots
        .map((s) => slotText(s, data, { label: false }))
        .filter((x): x is string => x !== null);
      if (aggText.length > 0) titles.push(prefix + aggText.join(sep));

      // 同一个 key 的槽位归到同一帧：不会出现「先显示这个 key 的余额、
      // 下一帧才显示它的限额」这种同一把 key 被拆开的情况。
      const groups = new Map<number, MenubarSlot[]>();
      for (const s of accountSlots) {
        const id = s.accountId as number;
        const list = groups.get(id);
        if (list) list.push(s);
        else groups.set(id, [s]);
      }
      for (const [id, slots] of groups) {
        const acc = data.accounts.find((a) => a.id === id);
        // 账户已删除：整帧跳过，不留一个名字对不上的空帧
        if (!acc) continue;
        // key 名在帧首出现一次，帧内各段不再重复
        const parts = slots
          .map((s) => slotText(s, data, { label: false }))
          .filter((x): x is string => x !== null);
        if (parts.length === 0) continue;
        const label = slots.find((s) => s.label)?.label ?? acc.label;
        titles.push(prefix + (label ? `${label} ` : "") + parts.join(sep));
      }
    } else {
      // 按用户配置的顺序渲染；只对「指定 key」槽位做数量折叠
      const shown: string[] = [];
      let accountCount = 0;
      for (const s of cfg.slots) {
        const text = slotText(s, data, { label: true });
        if (text === null) continue;
        if (s.kind === "account") {
          if (accountCount >= cfg.maxSegments) {
            overflow++;
            continue;
          }
          accountCount++;
        }
        shown.push(text);
      }
      if (shown.length > 0) {
        titles.push(prefix + shown.join(sep) + (overflow > 0 ? ` +${overflow}` : ""));
      }
    }
  }

  // tooltip 不折叠：菜单栏文字被系统截断时，悬停仍能看到全部 key
  const tooltipParts = cfg.slots
    .map((s) => slotText(s, data, { label: true }))
    .filter((x): x is string => x !== null);
  const tooltip = tooltipParts.length > 0 ? `AI Monitor${sep}${tooltipParts.join(sep)}` : null;

  // 轮播固定宽度：补齐后每帧盒子一样宽，切帧时菜单栏不再左右跳
  const finalTitles = cfg.rotateFixedWidth ? padToWidest(titles) : titles;

  return { titles: finalTitles, tooltip, menu, overflow };
}
