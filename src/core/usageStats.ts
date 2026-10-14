/**
 * 用量派生指标（纯函数，便于单测）。
 *
 * 口径：网关给的 prompt_tokens 就是本地的 input_tokens，而它**已经包含**缓存读取
 * （cache_read_input_tokens）—— 拿 spend 反推逐日费用时，用
 * cache_hit × 缓存价 + (input − cache_hit) × 输入价 才能对上账单，可见两者同口径。
 *
 * 于是缓存命中率 = cache_hit_tokens / input_tokens。要注意「未命中输入」是
 * input_tokens − cache_hit_tokens，而不是 input_tokens；把两者相加会把缓存读重复计一次。
 */

/** 缓存命中率，0~1。没有输入或数据异常时返回 0（界面显示 0.0% 而不是 NaN%） */
export function cacheHitRate(inputTokens: number, cacheHitTokens: number): number {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cacheHitTokens)) return 0;
  if (inputTokens <= 0) return 0;
  const r = cacheHitTokens / inputTokens;
  if (!Number.isFinite(r) || r <= 0) return 0;
  return r > 1 ? 1 : r; // 上游口径异常时按 100% 封顶，避免出现 "180.0%"
}

/** 命中率渲染成百分比字符串，默认一位小数 */
export function fmtRate(rate: number, digits = 1): string {
  const r = Number.isFinite(rate) ? rate : 0;
  return `${(r * 100).toFixed(Math.max(0, digits))}%`;
}

/** 预算窗口累计消耗的一次采样 */
export interface WindowSpendSample {
  /** 本地自然日（YYYY-MM-DD） */
  day: string;
  /** 窗口内累计消耗；窗口重置时回到 0 附近 */
  spend: number;
}

/** 累计值掉到上一读数的这个比例以下，才算「窗口重置」 */
const RESET_RATIO = 0.1;

/**
 * 窗口重置判定。真实重置会把累计值归零附近（掉到几个百分点以内），
 * 而网关的小额冲正（失败的请求退款、计价纠正）只改千分之几 —— 实测 29.3609 → 29.2983、
 * 8.1517 → 8.1270。把冲正当成重置会让当天金额被重复累加，所以用比例而不是「有下降」判定。
 */
function isWindowReset(value: number, prev: number): boolean {
  return prev > 0 && value < prev * RESET_RATIO;
}

/**
 * 把「预算窗口累计消耗」的采样还原成每个本地自然日的金额。
 *
 * 网关的逐日接口按 UTC 日分桶时（LiteLLM /user/daily/activity 就是这样）东八区会
 * 错开 8 小时，而预算窗口按本地零点重置 —— 用窗口内的累计值归属反而天然对齐。
 * 累计值是窗口内的绝对读数，所以：
 *   - 当天开始前发生过重置（当天首个采样掉到上一段末值的 10% 以下）：当天末值就是
 *     当天金额，只有一条采样也够，应用停机那几小时的用量同样算得进来；
 *   - 窗口跨天连续（lifetime / 月度预算）：退化成当天观察到的增量（末值 − 初值）；
 *   - 当天内再次重置（如 3h 窗口一天重置多次）：按重置切段，每段取末值相加。
 *
 * 采样需按时间升序传入（同一天内也按时间升序）。金额不为负，非法采样被忽略；
 * 「既没看到重置、又只有一条采样」的日期算不出任何东西，直接不产出结果
 * （调用方保留该日已有的值，不要用一个凭空的 0 覆盖掉）。
 */
export function dailyCostFromWindowSpend(
  samples: readonly WindowSpendSample[]
): Map<string, number> {
  const byDay = new Map<string, number[]>();
  for (const s of samples) {
    if (!s.day || !Number.isFinite(s.spend)) continue;
    const arr = byDay.get(s.day);
    if (arr) arr.push(s.spend);
    else byDay.set(s.day, [s.spend]);
  }

  const out = new Map<string, number>();
  let prevSpend: number | null = null; // 上一条采样值
  for (const [day, values] of byDay) {
    const fresh = prevSpend !== null && isWindowReset(values[0], prevSpend);
    if (!fresh && values.length < 2) {
      prevSpend = values[values.length - 1];
      continue;
    }
    let total = 0;
    let startedFresh = fresh; // 当前段是否正好从窗口起点开始（整段都是当天的量）
    let start = values[0];
    let last = values[0];
    for (let i = 1; i < values.length; i++) {
      const v = values[i];
      if (isWindowReset(v, last)) {
        // 窗口在当天内重置：结算上一段（首段若跨天连续则只算增量），开新段
        total += startedFresh ? last : last - start;
        start = v;
        startedFresh = true;
      }
      last = v;
    }
    total += startedFresh ? last : last - start;
    out.set(day, Math.max(0, total));
    prevSpend = last;
  }
  return out;
}
