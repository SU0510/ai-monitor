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
