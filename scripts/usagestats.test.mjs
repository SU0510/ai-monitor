import { cacheHitRate, fmtRate, dailyCostFromWindowSpend } from "../src/core/usageStats.ts";

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

// ---------- dailyCostFromWindowSpend（预算窗口累计消耗 → 本地自然日金额） ----------
// 背景：网关的逐日接口按 UTC 日分桶（东八区差 8 小时），而预算窗口按本地零点重置；
// 窗口内的累计值是绝对读数，按本地日取末值才能对上「限额 − 余额」。

// 真实数据（ustc1）：10-13 末值 17.9992；10-14 零点归零 0.0367，涨到 3.7105
const resetDay = dailyCostFromWindowSpend([
  { day: "2026-10-13", spend: 0.6116 },
  { day: "2026-10-13", spend: 17.9992 },
  { day: "2026-10-14", spend: 0.0367392 },
  { day: "2026-10-14", spend: 3.6380628 },
  { day: "2026-10-14", spend: 3.7104572 },
]);
eq(resetDay.get("2026-10-14"), 3.7104572, "重置天：取当天末值，不含零点前的部分");
eq(resetDay.get("2026-10-13"), 17.3876, "序列首日没有前一段：只算观察到的增量");

// 用户看到的账：100 − 87.8031 = 12.1969（ustc2 的当天末值，前一天末值 10.1746）
{
  const costs = dailyCostFromWindowSpend([
    { day: "2026-10-13", spend: 10.1746146 },
    { day: "2026-10-14", spend: 0.175877 },
    { day: "2026-10-14", spend: 12.1969096 },
  ]);
  ok(Math.abs(costs.get("2026-10-14") - 12.1969096) < 1e-9, "真实样本：等于 100 − 余额");
}

// 跨天连续（lifetime / 月度预算，从不归零）：当天金额 = 当天增量
{
  const costs = dailyCostFromWindowSpend([
    { day: "2026-10-13", spend: 500 },
    { day: "2026-10-13", spend: 505 },
    { day: "2026-10-14", spend: 506 },
    { day: "2026-10-14", spend: 509.5 },
  ]);
  eq(costs.get("2026-10-14"), 3.5, "无重置（跨天连续）：当天增量");
  eq(costs.get("2026-10-13"), 5, "无重置：前一天增量");
}

// 应用停机几天后才开：首条采样远小于上一段末值，仍然整段算当天
{
  const costs = dailyCostFromWindowSpend([
    { day: "2026-10-10", spend: 40 },
    { day: "2026-10-14", spend: 1.2 },
    { day: "2026-10-14", spend: 6.5 },
  ]);
  eq(costs.get("2026-10-14"), 6.5, "停机几天再开：重置天取末值，不漏账");
}

// 一天内多次重置（如 3h 窗口）：按段累加，每段取末值
{
  const costs = dailyCostFromWindowSpend([
    { day: "2026-10-13", spend: 5 },
    { day: "2026-10-14", spend: 0.02 },
    { day: "2026-10-14", spend: 2.9 },
    { day: "2026-10-14", spend: 3.0 },
    { day: "2026-10-14", spend: 0.05 }, // 窗口重置
    { day: "2026-10-14", spend: 2.4 },
    { day: "2026-10-14", spend: 0.1 }, // 再次重置
  ]);
  eq(costs.get("2026-10-14"), 5.5, "当天多次重置：3.0 + 2.4 + 0.1");
}

// 小额冲正不是重置（真实数据：10-12 22:22 累计值 29.3609 → 29.2983，余额同步回升）
// 把它当成重置会让当天金额多算一整个前面那段（64.80 而不是 35.44）
{
  const costs = dailyCostFromWindowSpend([
    { day: "2026-10-11", spend: 86.0565 },
    { day: "2026-10-12", spend: 0.0035 },
    { day: "2026-10-12", spend: 29.3609 },
    { day: "2026-10-12", spend: 29.2983 }, // 冲正，不是重置
    { day: "2026-10-12", spend: 35.4375 },
  ]);
  eq(costs.get("2026-10-12"), 35.4375, "冲正不切段：当天仍是末值");
}

// 边界：非法采样忽略、空输入、没消耗时为 0、单点且看不到重置时不产出
eq(dailyCostFromWindowSpend([]).size, 0, "空输入");
eq(
  [
    ...dailyCostFromWindowSpend([
      { day: "2026-10-13", spend: 3 },
      { day: "2026-10-14", spend: NaN },
      { day: "2026-10-14", spend: Infinity },
      { day: "2026-10-14", spend: 0.2 },
      { day: "2026-10-14", spend: 1.5 },
    ]),
  ],
  [["2026-10-14", 1.5]],
  "NaN / Infinity 采样被忽略，不影响当天金额"
);
eq(
  dailyCostFromWindowSpend([
    { day: "2026-10-14", spend: 4.2 },
    { day: "2026-10-14", spend: 4.2 },
  ]).get("2026-10-14"),
  0,
  "窗口没动：金额 0（首日无前一段，算增量）"
);
eq(
  dailyCostFromWindowSpend([
    { day: "2026-10-13", spend: 40 },
    { day: "2026-10-14", spend: 6.5 },
  ]).size,
  0,
  "单点 + 看不到重置（无前一段可比）：不产出，保留库里已有的值"
);
eq(
  dailyCostFromWindowSpend([
    { day: "2026-11-15", spend: 25.6831 },
    { day: "2026-11-16", spend: -97.0921 },
    { day: "2026-11-16", spend: -88.56 },
  ]).size,
  0,
  "负累计值（budget reset 结转）：不产出，保留网关逐日 spend"
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
