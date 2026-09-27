import {
  buildHeatmapCells,
  levelOf,
  levelThresholds,
  monthLabels,
  weekCount,
  weekdayLabels,
  ymd,
} from "../src/core/heatmap.ts";

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

const day = (s) => new Date(`${s}T00:00:00`);
const addDays = (d, n) => {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
};

// ---------- 分档 ----------

eq(levelThresholds([]), null, "全零：没有阈值");
eq(levelThresholds([0, 0, 0]), null, "全零：全 0 输入也返回 null");
eq(levelOf(0, null), 0, "零用量恒为 0 档");
eq(levelOf(123, null), 1, "无阈值但有用量：给 1 档而不是 0");

{
  // 4 个非零值 → 每档正好一个，深浅必须真的分开
  const vals = [10, 20, 30, 40];
  const th = levelThresholds(vals);
  eq(
    vals.map((v) => levelOf(v, th)),
    [1, 2, 3, 4],
    "4 个非零值铺满 4 档"
  );
  eq(levelOf(0, th), 0, "混入零用量仍是 0 档");
}

{
  // 一个超大值不应把其他天全压进最浅一档（分位 vs 最大值的区别）
  const th = levelThresholds([1, 2, 3, 100000]);
  eq(levelOf(3, th), 3, "极端值不吞掉其余分档");
}

{
  // 稀疏数据：非零天数很少时最深一档也必须能出现，否则整张图永远只有浅绿
  eq(levelOf(58.77, levelThresholds([18.04, 58.77])), 4, "2 个非零值：最大值到最深档");
  eq(levelOf(18.04, levelThresholds([18.04, 58.77])), 1, "2 个非零值：小值到最浅档");
  eq(levelOf(9, levelThresholds([1, 5, 9])), 4, "3 个非零值：最大值到最深档");
  eq(levelOf(9, levelThresholds([9])), 1, "只有 1 天数据：不给最深档（没有可比对象）");
}

// ---------- 网格几何 ----------

const cases = [
  ["2026-09-27", 6],
  ["2026-09-26", 6], // 周六：最后一列刚好满 7 格
  ["2027-01-03", 6], // 跨年（12 月 → 1 月）
  ["2024-03-01", 6], // 闰年 2 月
  ["2026-06-15", 3],
  ["2026-06-15", 1],
];

for (const [todayStr, months] of cases) {
  const today = day(todayStr);
  const cells = buildHeatmapCells(new Map(), months, today);
  const tag = `${todayStr}/${months}个月`;

  eq(cells[0].date, ymd(day(cells[0].date)), `${tag}：日期格式为 YYYY-MM-DD`);
  eq(day(cells[0].date).getDay(), 0, `${tag}：起点是周日（行即星期几）`);
  eq(cells[cells.length - 1].date, ymd(today), `${tag}：终点是今天`);

  const consecutive = cells.every(
    (c, i) => i === 0 || ymd(addDays(day(cells[i - 1].date), 1)) === c.date
  );
  ok(consecutive, `${tag}：日期逐日连续、无重复`);

  const dup = new Set(cells.map((c) => c.date)).size === cells.length;
  ok(dup, `${tag}：无重复日期`);

  // 起点按自然月对齐：第一个格子落在 months-1 个月前那月的 1 号当天或之前，且相差不到一周
  const rangeStart = new Date(today.getFullYear(), today.getMonth() - (months - 1), 1);
  const lead = Math.round((rangeStart - day(cells[0].date)) / 86400000);
  ok(lead >= 0 && lead <= 6, `${tag}：月份边界对齐（前导 ${lead} 天 ≤ 6）`);

  // 最后一列是残列：长度对 7 取余应等于今天在周内的偏移 +1
  eq(cells.length % 7, (today.getDay() + 1) % 7, `${tag}：最后一列为残列`);
  eq(weekCount(cells), Math.ceil(cells.length / 7), `${tag}：列数与格子数自洽`);

  // 每个月一个标签，且落在递增的列上
  const labels = monthLabels(cells, "zh");
  eq(labels.length, weekCount(cells), `${tag}：标签数与列数相同`);
  const filled = labels.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  eq(filled.length, months, `${tag}：正好 ${months} 个月份标签`);
  ok(
    filled.every((v, i) => i === 0 || v > filled[i - 1]),
    `${tag}：月份标签列号递增`
  );
  ok(
    labels.every((s) => s === "" || /\d|月|[A-Za-z]/.test(s)),
    `${tag}：月份标签非空白字符`
  );
}

// ---------- 取值 ----------

{
  const today = day("2026-09-27");
  const daily = new Map([
    ["2026-09-27", 500], // 今天
    ["2026-04-01", 300], // 区间第一个月的 1 号
    ["2026-01-01", 9999], // 区间之前：必须被丢掉
  ]);
  const cells = buildHeatmapCells(daily, 6, today);
  const byDate = new Map(cells.map((c) => [c.date, c.value]));

  eq(byDate.get("2026-09-27"), 500, "今天取到用量");
  eq(byDate.get("2026-04-01"), 300, "区间首日取到用量");
  eq(byDate.get("2026-01-01"), undefined, "区间之前的数据不进网格");
  eq(byDate.get("2026-05-01"), 0, "无记录的日期补 0");
}

{
  // 金额这种小数度量也要能正常分档（余额差值记账写出来的就是 7.7932964 这类值）
  const today = day("2026-09-27");
  const daily = new Map([
    ["2026-09-26", 9.7611084],
    ["2026-09-27", 7.7932964],
  ]);
  const cells = buildHeatmapCells(daily, 6, today);
  const byDate = new Map(cells.map((c) => [c.date, c.value]));
  eq(byDate.get("2026-09-26"), 9.7611084, "浮点金额原样保留");
  ok(
    cells.every((c) => c.value > 0 === c.level > 0),
    "浮点金额：有值即非 0 档"
  );
  eq(cells.filter((c) => c.level > 0).length, 2, "浮点金额：只有两天非 0 档");
}

// ---------- 星期标签 ----------

for (const loc of ["zh", "en"]) {
  const labels = weekdayLabels(loc);
  eq(labels.length, 7, `${loc}：7 个槽位（与格子行数对齐）`);
  eq(
    labels.map((s) => (s ? 1 : 0)),
    [0, 1, 0, 1, 0, 1, 0],
    `${loc}：只填周一/周三/周五`
  );
  ok(new Set(labels.filter(Boolean)).size === 3, `${loc}：三个标签互不相同`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
