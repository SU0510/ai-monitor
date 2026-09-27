/**
 * 日历热力图（GitHub 贡献图那种）的纯计算部分。
 *
 * 这里刻意不碰 Vue / DOM：布局几何和分档规则都能直接用 node 跑单测，
 * 见 scripts/heatmap.test.mjs。
 */

export interface HeatmapCell {
  /** YYYY-MM-DD（本地日期） */
  date: string;
  /** 当天的度量值。具体是金额还是 token 由调用方决定，分档只看相对大小 */
  value: number;
  /** 0=无用量，1~4 依次加深 */
  level: number;
}

/** 本地当天零点。直接拿 Date.now() 相减会在跨时区/夏令时下把日期算偏一天 */
export function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 分位阈值。GitHub 也是按分位数分档的：
 * 若按最大值等比缩放，只要有一天用量特别大，其余所有天都会被压进最浅一档，整张图就看不出深浅。
 * 返回 null 表示一个非零日都没有。
 */
export function levelThresholds(values: number[]): readonly [number, number, number] | null {
  const vals = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const n = vals.length;
  // 取 1-based 分位点（第 ceil(q*n) 个）再换成下标，这样四档人数才是真的各占 1/4。
  // 若直接用 floor(q*n)，第三档阈值会落在最大值上，于是最高分档永远取不到（最大值只到 3 档）。
  const at = (q: number) => {
    const idx = Math.max(0, Math.min(n - 1, Math.ceil(q * n) - 1));
    // 再兜一层：阈值一律不取最大值，否则非零天数很少时（只有 2~3 天）最深那档永远出不来
    return vals[n >= 2 ? Math.min(idx, n - 2) : idx];
  };
  return [at(0.25), at(0.5), at(0.75)] as const;
}

export function levelOf(value: number, th: readonly [number, number, number] | null): number {
  if (value <= 0) return 0;
  if (!th) return 1;
  if (value <= th[0]) return 1;
  if (value <= th[1]) return 2;
  if (value <= th[2]) return 3;
  return 4;
}

/**
 * 逐日格子。
 *
 * 起点取「months-1 个月前的那个月的 1 号」再回退到所在周的周日：
 * - 按自然月对齐，月份标签才会落在整月边界上（回推 months*30 天会从一个月的中间开始）
 * - 回退到周日保证「一列正好一周」，行即星期几
 *
 * 返回顺序就是填充顺序：每 7 个一列，直接丢进 grid-auto-flow: column 即可。
 */
export function buildHeatmapCells(
  daily: Map<string, number>,
  months: number,
  today: Date
): HeatmapCell[] {
  const end = startOfDay(today);
  const rangeStart = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
  const cur = new Date(rangeStart);
  cur.setDate(cur.getDate() - cur.getDay()); // 回退到周日

  const th = levelThresholds([...daily.values()]);
  const out: HeatmapCell[] = [];
  while (cur <= end) {
    const key = ymd(cur);
    const value = daily.get(key) ?? 0;
    out.push({ date: key, value, level: levelOf(value, th) });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export function weekCount(cells: HeatmapCell[]): number {
  return Math.ceil(cells.length / 7);
}

/**
 * 每周一列的表头：哪一列的 7 天里出现了某月的 1 号，就把月份名写在那一列上。
 * 返回长度与列数相同的数组，其余为 ""。
 */
export function monthLabels(cells: HeatmapCell[], locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: "short" });
  const out: string[] = [];
  for (let w = 0; w < weekCount(cells); w++) {
    const first = cells.slice(w * 7, w * 7 + 7).find((c) => c.date.endsWith("-01"));
    out.push(first ? fmt.format(new Date(`${first.date}T00:00:00`)) : "");
  }
  return out;
}

/**
 * 左侧星期标签：7 个槽位、只填周一/周三/周五（和 GitHub 一致，行 0 是周日）。
 * 留空槽位而不是只返回 3 项，是为了让标签和格子的行高行距天然对齐。
 */
export function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2024-01-07 是周日
  return Array.from({ length: 7 }, (_, i) =>
    i === 1 || i === 3 || i === 5 ? fmt.format(new Date(2024, 0, 7 + i)) : ""
  );
}
