/**
 * 网关逐日 token 同步的回归测试（`npm run test:tokensync`）。
 *
 * 夹具是 2026-09-27 从真实网关 /user/daily/activity 抓下来的响应片段
 * （数值照抄，字段名一字不改），保证解析路径不是照着文档猜的。
 */
import {
  parseDailyActivity,
  buildTokenRange,
  buildTokenUrl,
  hasMorePages,
  mergeDailyPages,
} from "../src/core/tokenSync.ts";
import { litellmTokenSyncDefaults, litellmPreset } from "../src/core/customApi.ts";

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${label}\n    实际: ${a}\n    期望: ${b}`);
  }
}

const ts = litellmTokenSyncDefaults();

// 真实响应片段（两个日期，含 breakdown 噪声）
const realResp = {
  results: [
    {
      date: "2026-09-27",
      metrics: {
        spend: 11.5906656,
        prompt_tokens: 28880400,
        completion_tokens: 352200,
        cache_read_input_tokens: 26041408,
        cache_creation_input_tokens: 0,
        compression_saved_tokens: 0,
        total_tokens: 29232600,
        successful_requests: 226,
        failed_requests: 0,
        api_requests: 226,
      },
      breakdown: {
        models: {
          "openai/deepseek-flash": { metrics: { prompt_tokens: 1, completion_tokens: 2 } },
        },
      },
    },
    {
      date: "2026-09-26",
      metrics: {
        prompt_tokens: 44593461,
        completion_tokens: 620284,
        cache_read_input_tokens: 43644864,
        api_requests: 335,
      },
    },
  ],
};

const rows = parseDailyActivity(ts, realResp);
eq(rows.length, 2, "解析出 2 天");
eq(
  rows[0],
  { date: "2026-09-26", input: 44593461, output: 620284, cacheHit: 43644864 },
  "按日期升序、输入/输出/缓存命中都对"
);
eq(rows[1].input, 28880400, "第二天的输入 token");
eq(rows[1].cacheHit, 26041408, "缓存命中取 cache_read_input_tokens");
// breakdown.models 里也有 prompt_tokens，但指标必须取自 metrics 而不是被嵌套的模型明细抢走
eq(rows[1].input !== 1, true, "指标取自 metrics，不会被 breakdown.models 里的同名嵌套字段带偏");

// ---------- 边界 ----------

eq(parseDailyActivity(ts, { results: [] }), [], "空列表 → 空结果");
eq(parseDailyActivity(ts, {}), [], "没有 results → 空结果而不是崩");
eq(parseDailyActivity(ts, { results: "oops" }), [], "results 不是数组 → 空结果");
eq(
  parseDailyActivity(ts, { results: [{ date: "not-a-date", metrics: { prompt_tokens: 5 } }] })
    .length,
  0,
  "日期不合法 → 跳过（不能当今天写进去）"
);
eq(
  parseDailyActivity(ts, {
    results: [{ date: "2026-09-27T00:00:00+08:00", metrics: { prompt_tokens: 5 } }],
  })[0].date,
  "2026-09-27",
  "带时间的日期截断成 YYYY-MM-DD"
);
eq(
  parseDailyActivity(ts, { results: [{ date: "2026-09-27" }] })[0],
  { date: "2026-09-27", input: 0, output: 0, cacheHit: 0 },
  "缺 metrics → 全 0 而不是 NaN"
);
eq(
  parseDailyActivity(ts, {
    results: [{ date: "2026-09-27", metrics: { prompt_tokens: "12345" } }],
  })[0].input,
  12345,
  "字符串数字也能转"
);
// 没有 results 包装时直接给数组也能用
eq(
  parseDailyActivity(ts, [{ date: "2026-09-27", metrics: { prompt_tokens: 7 } }]).length,
  1,
  "顶层直接是数组时可用"
);
// cacheReadField 未配置时不读缓存
eq(
  parseDailyActivity({ ...ts, cacheReadField: undefined }, realResp)[1].cacheHit,
  0,
  "未配置缓存字段时不取缓存"
);

// ---------- 同步窗口 ----------

const today = new Date(2026, 8, 27); // 2026-09-27
eq(
  buildTokenRange(true, today, 7),
  { start: "2000-01-01", end: "2026-09-27" },
  "全量历史：极早起点 → 今天"
);
eq(
  buildTokenRange(false, today, 7),
  { start: "2026-09-21", end: "2026-09-27" },
  "增量：最近 7 天含今天"
);
eq(
  buildTokenRange(false, today, 1),
  { start: "2026-09-27", end: "2026-09-27" },
  "增量 1 天就是今天"
);
eq(
  buildTokenRange(false, today, 0),
  { start: "2026-09-27", end: "2026-09-27" },
  "天数为 0 不出现反向区间"
);
// 跨月边界
eq(
  buildTokenRange(false, new Date(2026, 9, 3), 5),
  { start: "2026-09-29", end: "2026-10-03" },
  "增量窗口跨月正确"
);

// ---------- URL 拼接 ----------

const cfg = { ...litellmPreset(), baseUrl: "https://api.llm.ustc.edu.cn" };
eq(
  buildTokenUrl(cfg, ts, "2026-09-21", "2026-09-27"),
  "https://api.llm.ustc.edu.cn/user/daily/activity?start_date=2026-09-21&end_date=2026-09-27&page_size=1000",
  "URL = baseUrl + path + 起止日期 + page_size"
);
eq(
  buildTokenUrl(cfg, ts, "2026-09-21", "2026-09-27", 2),
  "https://api.llm.ustc.edu.cn/user/daily/activity?start_date=2026-09-21&end_date=2026-09-27&page_size=1000&page=2",
  "翻页时带上 page（第一页不带，免得无谓多一个参数）"
);
eq(
  buildTokenUrl(cfg, ts, "a", "b", 1),
  buildTokenUrl(cfg, ts, "a", "b"),
  "page=1 与不传 page 等价"
);
eq(
  buildTokenUrl(cfg, { ...ts, pageSize: undefined }, "2026-09-21", "2026-09-27"),
  "https://api.llm.ustc.edu.cn/user/daily/activity?start_date=2026-09-21&end_date=2026-09-27",
  "未配置 pageSize 时不加该参数（对不接受它的接口保持兼容）"
);
eq(
  buildTokenUrl({ ...cfg, baseUrl: "https://gw.example.com/" }, ts, "2026-09-21", "2026-09-27"),
  "https://gw.example.com/user/daily/activity?start_date=2026-09-21&end_date=2026-09-27&page_size=1000",
  "baseUrl 末尾斜杠不产生双斜杠"
);
eq(
  buildTokenUrl(cfg, { ...ts, path: "user/daily/activity" }, "a", "b"),
  "https://api.llm.ustc.edu.cn/user/daily/activity?start_date=a&end_date=b&page_size=1000",
  "路径缺前导斜杠时自动补"
);

// ---------- 分页 ----------

eq(hasMorePages({ metadata: { has_more: true } }), true, "has_more=true → 继续翻页");
eq(hasMorePages({ metadata: { has_more: false } }), false, "has_more=false → 停");
eq(
  hasMorePages({ metadata: { page: 1, total_pages: 3 } }),
  true,
  "没有 has_more 时用 page<total_pages 推断"
);
eq(hasMorePages({ metadata: { page: 3, total_pages: 3 } }), false, "最后一页");
eq(hasMorePages({ metadata: {} }), false, "metadata 里没有分页信息 → 当单页");
eq(hasMorePages({ results: [] }), false, "没有 metadata → 当单页（对不分页的接口安全）");
eq(hasMorePages(null), false, "响应为空不崩");

// 两页合并：并集、按日期升序、同一天以后一页为准
const page1 = {
  results: [
    { date: "2026-09-25", metrics: { prompt_tokens: 167199622, spend: 76.97 } },
    { date: "2026-09-26", metrics: { prompt_tokens: 44593461, spend: 11.86 } },
  ],
};
const page2 = {
  results: [
    { date: "2026-09-27", metrics: { prompt_tokens: 28880400, spend: 11.59 } },
    // 与第一页重复的日期：应该被这一页的值取代，而不是变成两行
    { date: "2026-09-26", metrics: { prompt_tokens: 999, spend: 1 } },
  ],
};
const merged = mergeDailyPages(ts, [page1, page2]);
eq(merged.length, 3, "两页合并后按日期去重 → 3 天");
eq(
  merged.map((r) => r.date),
  ["2026-09-25", "2026-09-26", "2026-09-27"],
  "合并结果按日期升序"
);
eq(merged[1].input, 999, "重复日期以后一页为准");
eq(mergeDailyPages(ts, []), [], "没有页 → 空结果");
eq(mergeDailyPages(ts, [{ results: "oops" }]).length, 0, "坏页被跳过而不是崩");

// ---------- 当日消耗 ----------

eq(rows[1].cost, 11.5906656, "spend 解析成当日消耗");
eq(rows[0].cost, undefined, "9/26 那条夹具没有 spend → 不带 cost（写库时保留原金额）");
eq(
  parseDailyActivity({ ...ts, costField: undefined }, realResp)[1].cost,
  undefined,
  "未配置 costField 时不解析金额"
);
eq(
  parseDailyActivity(
    { ...ts, costField: "spend" },
    {
      results: [{ date: "2026-09-27", metrics: { spend: "1.25" } }],
    }
  )[0].cost,
  1.25,
  "字符串金额也能转"
);
eq(
  parseDailyActivity(
    { ...ts, costField: "spend" },
    {
      results: [{ date: "2026-09-27", metrics: { spend: 0 } }],
    }
  )[0].cost,
  0,
  "金额为 0 是合法值，要保留（不能被当成「没取到」）"
);
eq(ts.costField, "spend", "默认金额字段");
eq(ts.pageSize, 1000, "默认每页 1000 条（实测一次即可取回全部历史）");

// ---------- 预设与老配置 ----------

eq(litellmPreset().tokenSync.path, "/user/daily/activity", "LiteLLM 预设带逐日用量路径");
eq(litellmPreset().syncTokens, false, "默认不自动同步 token（需用户显式打开）");
eq(litellmPreset().syncTokenHistory, false, "默认只同步最近若干天");
eq(ts.metricsPath, "metrics", "指标对象路径");
eq(ts.inputField, "prompt_tokens", "输入字段");
eq(ts.outputField, "completion_tokens", "输出字段");

// 老配置（没有 tokenSync 段）由 loadCustomConfigs 补默认值；那条路径要 Tauri 运行时
// （getSetting），node 里测不到，这里只锁住「默认值工厂」这个被回填的东西本身。
eq(litellmTokenSyncDefaults().path, "/user/daily/activity", "回填用的默认路径正确");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
