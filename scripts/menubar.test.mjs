import {
  normalizeMenubarConfig,
  slotText,
  renderMenubar,
  formatMoney1,
  displayWidth,
} from "../src/core/menubar.ts";
import { primaryQuota, quotaView } from "../src/core/quota.ts";

let pass = 0,
  fail = 0;
const eq = (a, b, l) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log(`FAIL ${l}\n  expected: ${JSON.stringify(b)}\n  actual:   ${JSON.stringify(a)}`);
  }
};

const mk = (id, label, balance, spent) => ({
  id,
  label,
  currency: "USD",
  balance,
  todayCost: 1.234,
  tokens: 1330,
  quota: quotaView(
    primaryQuota([{ window: "3h", limit: 30, spent, remaining: 30 - spent, ratio: spent / 30 }]),
    "USD"
  ),
});
const data = {
  accounts: [mk(1, "ustc", 91.0790588, 3.0599), mk(2, "ustc-lhy", 82.595778, 11.25)],
  totals: { currency: "CNY", balance: 173.67, todayCost: 13.95, tokens: 2660, quota: null },
  collecting: false,
  hasError: false,
};
const base = {
  showTitle: true,
  showIcon: true,
  rotateSecs: 3,
  separator: "·",
  maxSegments: 3,
  menuAccounts: true,
  // 定宽补齐单独测；这里关掉，断言里就不用写一串不换行空格
  rotateFixedWidth: false,
  minimal: false,
  minimalSymbol: true,
};
const N = (o) => normalizeMenubarConfig(o);

// ---------- 极简模式 ----------
const mm = N({
  ...base,
  minimal: true,
  slots: [
    { id: "b1", kind: "account", metric: "balance", accountId: 1, compact: true },
    { id: "b2", kind: "account", metric: "balance", accountId: 2, compact: true },
    { id: "q1", kind: "account", metric: "quota", accountId: 1, compact: true },
    { id: "q2", kind: "account", metric: "quota", accountId: 2, compact: true },
  ],
});
eq(
  N({ ...base, minimal: true, minimalSymbol: true, slots: mm.slots }).minimal,
  true,
  "keeps minimal"
);
eq(
  renderMenubar(mm, data).titles,
  ["$91.1 · $82.6 · 10% · 38%"],
  "minimal, symbol, 1 decimal, all slots"
);
eq(
  renderMenubar({ ...mm, minimalSymbol: false }, data).titles,
  ["91.1 · 82.6 · 10% · 38%"],
  "minimal, no symbol"
);
eq(renderMenubar(mm, data).overflow, 0, "minimal never folds");
eq(
  renderMenubar(
    N({
      ...base,
      minimal: true,
      slots: [
        { id: "b1", kind: "account", metric: "balance", accountId: 1 },
        { id: "c1", kind: "account", metric: "todayCost", accountId: 1 },
        { id: "t1", kind: "account", metric: "tokens", accountId: 1 },
      ],
    }),
    data
  ).titles,
  ["$91.1 · -$1.2 · 1.3K"],
  "minimal cost '-', tokens bare"
);
eq(formatMoney1(-5.16, "USD", true), "-$5.2", "formatMoney1 neg w/ symbol");
eq(formatMoney1(-5.16, "CNY", false), "-5.2", "formatMoney1 neg no symbol");
eq(formatMoney1(1000, "CNY", true), "¥1000.0", "formatMoney1 no thousands sep");
eq(formatMoney1(5.05, "CNY", false), "5.0", "formatMoney1 toFixed semantics");

// ---------- 老配置回退 ----------
const legacy = N({ showTitle: true, slots: [], maxSegments: 3 });
eq([legacy.minimal, legacy.minimalSymbol], [false, true], "legacy defaults");
eq(legacy.rotateFixedWidth, true, "legacy rotateFixedWidth default");

// ---------- 缺数据不显示假 0 ----------
eq(
  slotText({ id: "x", kind: "account", metric: "balance", accountId: 99 }, data, { minimal: true }),
  null,
  "deleted acct -> null"
);
eq(
  slotText({ id: "y", kind: "aggregate", metric: "quota" }, data, { minimal: true }),
  null,
  "no agg quota -> null"
);

// ---------- 轮播：同一 key 的信息归到同一帧 ----------
eq(
  renderMenubar(N({ ...base, titleMode: "rotate", slots: mm.slots }), data).titles,
  ["ustc $91.1 · 3h 10%", "ustc-lhy $82.6 · 3h 38%"],
  "rotate groups per key"
);
eq(
  renderMenubar(
    N({
      ...base,
      titleMode: "rotate",
      slots: [
        { id: "s1", kind: "account", metric: "balance", accountId: 2 },
        { id: "s2", kind: "account", metric: "quota", accountId: 1 },
        { id: "s3", kind: "account", metric: "balance", accountId: 1 },
      ],
    }),
    data
  ).titles,
  ["ustc-lhy $82.60", "ustc 3h 10% · $91.08"],
  "scattered slots group per key"
);
eq(
  renderMenubar(
    N({
      ...base,
      titleMode: "rotate",
      slots: [
        { id: "a1", kind: "aggregate", metric: "balance" },
        { id: "s1", kind: "account", metric: "balance", accountId: 1 },
        { id: "s2", kind: "account", metric: "quota", accountId: 1 },
      ],
    }),
    data
  ).titles,
  ["¥173.67", "ustc $91.08 · 3h 10%"],
  "aggregate frame first"
);
eq(
  renderMenubar(
    N({
      ...base,
      titleMode: "rotate",
      slots: [
        { id: "s1", kind: "account", metric: "balance", accountId: 99 },
        { id: "s2", kind: "account", metric: "balance", accountId: 1 },
      ],
    }),
    data
  ).titles,
  ["ustc $91.08"],
  "deleted key frame dropped"
);
eq(
  renderMenubar(
    N({
      ...base,
      titleMode: "rotate",
      slots: [
        { id: "s1", kind: "account", metric: "balance", accountId: 1, label: "主号" },
        { id: "s2", kind: "account", metric: "quota", accountId: 1 },
      ],
    }),
    data
  ).titles,
  ["主号 $91.08 · 3h 10%"],
  "explicit label once per frame"
);

// ---------- 并排模式保持原样 ----------
eq(
  renderMenubar(N({ ...base, titleMode: "segments", slots: mm.slots }), data).titles,
  ["ustc $91.1 · ustc-lhy $82.6 · ustc 3h 10% +1"],
  "segments unchanged"
);
eq(
  renderMenubar(N({ ...base, titleMode: "segments", slots: mm.slots }), data).overflow,
  1,
  "segments folds"
);

// ---------- 下拉菜单：列出当前勾选的全部组件 ----------
const menuSlots = [
  { id: "ab", kind: "aggregate", metric: "balance" },
  { id: "s1", kind: "account", metric: "balance", accountId: 1 },
  { id: "s2", kind: "account", metric: "quota", accountId: 1 },
  { id: "s3", kind: "account", metric: "balance", accountId: 2 },
];
const menuCfg = (extra) => N({ ...base, slots: menuSlots, ...extra });
eq(
  renderMenubar(menuCfg({}), data).menu,
  [
    { id: "agg", label: "¥173.67", enabled: true },
    { id: "acc-1", label: "ustc $91.08 · 3h 10%", enabled: true },
    { id: "acc-2", label: "ustc-lhy $82.60", enabled: true },
  ],
  "menu lists every enabled slot, one row per key"
);
// 每把 key 的多个指标并进同一行，而不是只显示某一个指标
eq(
  renderMenubar(menuCfg({}), data).menu[1].label.split(" · ").length,
  2,
  "key row holds all its metrics"
);
eq(renderMenubar(menuCfg({ menuAccounts: false }), data).menu, [], "menu off -> empty");
eq(
  renderMenubar(
    N({ ...base, slots: [{ id: "x", kind: "account", metric: "balance", accountId: 99 }] }),
    data
  ).menu,
  [],
  "menu drops deleted key"
);

// ---------- 轮播定宽：补齐到最宽一帧 ----------
const unevenSlots = [
  { id: "s1", kind: "account", metric: "balance", accountId: 1 },
  { id: "s2", kind: "account", metric: "quota", accountId: 2 },
];
const rawFrames = renderMenubar(
  N({ ...base, rotateFixedWidth: false, titleMode: "rotate", slots: unevenSlots }),
  data
).titles;
const paddedFrames = renderMenubar(
  N({ ...base, rotateFixedWidth: true, titleMode: "rotate", slots: unevenSlots }),
  data
).titles;
const widest = Math.max(...rawFrames.map(displayWidth));
eq([rawFrames.length, paddedFrames.length], [2, 2], "two rotation frames");
eq(paddedFrames.map(displayWidth), [widest, widest], "every frame padded to the widest");
eq(paddedFrames[1], rawFrames[1], "widest frame untouched");
eq(paddedFrames[1].includes("\u00a0"), false, "widest frame has no padding char");
eq(
  paddedFrames.map((t) => t.replace(/\u00a0+$/, "")),
  rawFrames,
  "padding only appends, content unchanged"
);
eq(
  renderMenubar(
    N({
      ...base,
      rotateFixedWidth: true,
      titleMode: "rotate",
      slots: [{ id: "s1", kind: "account", metric: "balance", accountId: 1 }],
    }),
    data
  ).titles,
  ["ustc $91.08"],
  "single frame not padded"
);
eq(
  [displayWidth("日本"), displayWidth("ab"), displayWidth("¥")],
  [4, 2, 1],
  "displayWidth counts CJK as 2"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
