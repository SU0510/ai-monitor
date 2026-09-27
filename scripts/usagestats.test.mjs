import { cacheHitRate, fmtRate } from "../src/core/usageStats.ts";

let pass = 0,
  fail = 0;
const eq = (a, b, l) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log(`FAIL ${l}\n  expected: ${JSON.stringify(b)}\n  actual:   ${JSON.stringify(a)}`);
  }
};
const ok = (cond, l) => eq(!!cond, true, l);

// ---------- cacheHitRate ----------

eq(cacheHitRate(100, 50), 0.5, "一半命中");
eq(cacheHitRate(100, 0), 0, "无缓存命中");
eq(cacheHitRate(100, 100), 1, "全部命中");
eq(cacheHitRate(0, 0), 0, "没有用量：0 而不是 NaN");
eq(cacheHitRate(0, 123), 0, "有命中但输入为 0：按 0 处理，不能除以 0");
eq(cacheHitRate(-1, 10), 0, "负数输入：不做除法");
eq(cacheHitRate(100, 250), 1, "命中数超过输入（上游口径异常）：封顶 100%");

// 真实网关一天的占比：input 108901696 里 cache 108,282,880
ok(Math.abs(cacheHitRate(108901696, 108282880) - 0.994318) < 1e-5, "真实样本：≈99.43% 命中");

// 小数与边界：命中率极低时不塌成 0
ok(cacheHitRate(1_000_000, 1) > 0, "百万分之一的命中也要能看出来");
eq(cacheHitRate(NaN, 10), 0, "NaN 输入");
eq(cacheHitRate(100, NaN), 0, "NaN 命中");
eq(cacheHitRate(50, Infinity), 0, "Infinity 命中：先判非法再封顶");

// 不变量：0 ≤ rate ≤ 1，且 rate 随命中数单调不减
{
  let mono = true;
  let prev = -1;
  for (let c = 0; c <= 1000; c += 25) {
    const r = cacheHitRate(1000, c);
    if (r < 0 || r > 1 || r < prev) mono = false;
    prev = r;
  }
  ok(mono, "命中率恒在 0~1 之间且随命中数单调不减");
}

// ---------- 口径自洽：命中率 = 1 − 未命中占比 ----------
// 「未命中输入」是 输入 − 命中，而不是等于输入 —— 输入本身已经含缓存读取。
{
  let selfConsistent = true;
  for (const input of [1, 999, 108901696]) {
    for (const cache of [0, 1, 500, input - 1]) {
      if (cache < 0 || cache > input) continue;
      const uncached = input - cache;
      if (Math.abs(cacheHitRate(input, cache) - (1 - uncached / input)) > 1e-12) {
        selfConsistent = false;
      }
    }
  }
  ok(selfConsistent, "命中率 = 1 − 未命中占比（输入已含缓存读）");
}

// ---------- fmtRate ----------

eq(fmtRate(0.994318), "99.4%", "默认一位小数");
eq(fmtRate(0), "0.0%", "零也带一位小数（看起来才是比例）");
eq(fmtRate(1), "100.0%", "100%");
eq(fmtRate(0.12345, 2), "12.35%", "两位小数");
eq(fmtRate(0.12345, 0), "12%", "零位小数");
eq(fmtRate(NaN), "0.0%", "NaN 显示成 0.0% 而不是 NaN%");
eq(fmtRate(Infinity), "0.0%", "Infinity 也兜住");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
