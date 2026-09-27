/**
 * 自定义 API 提取逻辑的回归测试（`npm run test:customapi`）。
 *
 * 覆盖两件新增能力，它们是「通用 /v1/usage 模板」能不能成立的关键：
 *   1. altSources 路径候选 —— 对应 extractor 里的 `a ?? b ?? c`
 *   2. validPath 判定方向   —— 对应 `isValid: resp.is_active ?? true`
 * 以及边界：取到 0 必须算取到值，不能被候选路径顶掉。
 */
import {
  genericUsagePreset,
  litellmPreset,
  getByPaths,
  getByPath,
  parseCustomResponse,
  extractQuotas,
  buildUrl,
  buildHeaders,
} from "../src/core/customApi.ts";

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
function throws(fn, label) {
  try {
    fn();
    fail++;
    console.error(`✗ ${label}（本该抛错却通过了）`);
  } catch {
    pass++;
  }
}

// ---------- getByPaths：候选路径 ----------

const resp = { remaining: 7, quota: { remaining: 99 }, balance: 42 };
eq(getByPaths(resp, ["remaining", "quota.remaining", "balance"]), 7, "主路径命中就不看候选");
eq(
  getByPaths({ quota: { remaining: 99 } }, ["remaining", "quota.remaining"]),
  99,
  "主路径缺失时用第一个候选"
);
eq(
  getByPaths({ balance: 42 }, ["remaining", "quota.remaining", "balance"]),
  42,
  "前两个都缺失时用最后一个候选"
);
eq(getByPaths({}, ["remaining", "balance"]), undefined, "全都缺失返回 undefined");
eq(getByPaths(resp, [undefined, "balance"]), 42, "跳过空路径");
eq(getByPaths(null, ["balance"]), undefined, "响应为 null 时不崩");

// 回归点：余额 0 是合法值，不能被后面的候选顶掉
eq(
  getByPaths({ remaining: 0, balance: 10 }, ["remaining", "balance"]),
  0,
  "取到 0 算取到值（不被候选顶掉）"
);
eq(getByPaths({ remaining: null, balance: 10 }, ["remaining", "balance"]), 10, "null 才算取不到");
eq(
  getByPaths({ remaining: "12.5", balance: 10 }, ["remaining", "balance"]),
  "12.5",
  "字符串数字也算取到"
);
eq(getByPath({ a: [{ b: 5 }] }, "a[0].b"), 5, "数组下标路径仍可用");

// ---------- 通用模板：字段提取 ----------

const generic = genericUsagePreset();

/** 造一份只改 fields 的最小配置，隔离测试解析逻辑 */
function cfgWith(fields, extra = {}) {
  return { ...generic, fields, ...extra };
}

const caseA = parseCustomResponse(generic, { remaining: 12.5, unit: "USD", is_active: true });
eq(caseA.info.balance, 12.5, "通用模板：remaining 取到余额");
eq(caseA.info.currency, "USD", "通用模板：unit 作为币种");

const caseB = parseCustomResponse(generic, { quota: { remaining: 3.25, unit: "CNY" } });
eq(caseB.info.balance, 3.25, "通用模板：退回 quota.remaining");
eq(caseB.info.currency, "CNY", "通用模板：退回 quota.unit");

const caseC = parseCustomResponse(generic, { balance: 8 });
eq(caseC.info.balance, 8, "通用模板：再退回 balance");
eq(caseC.info.currency, "USD", "通用模板：没有 unit 时默认 USD");

// remaining 优先于 balance（顺序语义）
eq(
  parseCustomResponse(generic, { remaining: 1, balance: 2 }).info.balance,
  1,
  "remaining 优先于 balance"
);

// ---------- validPath：有效性方向 ----------

eq(
  parseCustomResponse(generic, { remaining: 1, is_active: true }).info.balance,
  1,
  "is_active=true → 有效"
);
eq(
  parseCustomResponse(generic, { remaining: 1 }).info.balance,
  1,
  "is_active 缺失 → 视为有效（?? true）"
);
throws(
  () => parseCustomResponse(generic, { remaining: 1, is_active: false }),
  "is_active=false → 无效并抛错"
);
throws(
  () => parseCustomResponse(generic, { remaining: 1, isValid: false }),
  "is_active 缺失时看 validAltPaths(isValid)"
);
eq(
  parseCustomResponse(generic, { remaining: 1, isValid: false, is_active: true }).info.balance,
  1,
  "is_active 优先于 isValid"
);

// 0 视为假值：配额已用尽
throws(
  () => parseCustomResponse(generic, { remaining: 1, is_active: 0 }),
  "is_active=0 → 视为无效"
);

// invalidPath 方向相反，且优先
const blocked = cfgWith(generic.fields, { invalidPath: "blocked", invalidMessage: "封禁了" });
throws(
  () => parseCustomResponse(blocked, { remaining: 1, blocked: true }),
  "invalidPath 为真 → 无效"
);
eq(
  parseCustomResponse(blocked, { remaining: 1, blocked: false }).info.balance,
  1,
  "invalidPath 为假 → 有效"
);
try {
  parseCustomResponse(blocked, { remaining: 1, blocked: true });
} catch (e) {
  eq(e.message, "封禁了", "invalidPath 用配置的提示文案");
}
try {
  parseCustomResponse(generic, { remaining: 1, is_active: false });
} catch (e) {
  eq(e.message, "账户无效或已被封禁", "validPath 的默认提示文案");
}

// ---------- 提取失败与下限 ----------

throws(() => parseCustomResponse(generic, { nothing: 1 }), "三个候选路径都没有 → 抛错而不是当作 0");
eq(parseCustomResponse(generic, { remaining: -5 }).info.balance, 0, "clampMin 把负余额压到 0");
eq(parseCustomResponse(generic, { remaining: 0 }).info.balance, 0, "余额 0 正常返回");

// transform 仍生效（subtract）
const sub = {
  source: "total",
  altSources: ["quota.total"],
  transform: "subtract",
  operandSource: "used",
  clampMin: 0,
};
eq(
  parseCustomResponse(cfgWith({ balance: sub }), { quota: { total: 100 }, used: 30 }).info.balance,
  70,
  "候选路径 + subtract 组合"
);
eq(
  parseCustomResponse(cfgWith({ balance: sub }), { total: 100, used: 130 }).info.balance,
  0,
  "减法为负时被 clampMin 兜住"
);

// ---------- 模板本身 ----------

eq(generic.path, "/v1/usage", "通用模板路径");
eq(generic.method, "GET", "通用模板方法");
eq(generic.bearerAuth, true, "通用模板注入 Bearer");
eq(
  buildUrl({ ...generic, baseUrl: "https://gw.example.com/" }),
  "https://gw.example.com/v1/usage",
  "通用模板 URL 拼接"
);
eq(buildHeaders(generic, "sk-x"), [["Authorization", "Bearer sk-x"]], "通用模板请求头");
eq(
  generic.fields.balance.altSources,
  ["quota.remaining", "balance"],
  "通用模板余额候选路径顺序（对应 remaining ?? quota.remaining ?? balance）"
);
eq(generic.validPath, "is_active", "通用模板有效判定路径");
eq(generic.validAltPaths, ["isValid"], "通用模板有效判定候选（对应 is_active ?? isValid）");

// LiteLLM 预设不受影响：没有 altSources / validPath
const ll = litellmPreset();
eq(ll.fields.balance.altSources, undefined, "LiteLLM 预设不带候选路径");
eq(ll.validPath, undefined, "LiteLLM 预设仍用 invalidPath");
const llCase = parseCustomResponse(ll, {
  info: { max_budget: 100, spend: 30, currency: "USD", blocked: false },
});
eq(llCase.info.balance, 70, "LiteLLM 预设行为不变（max_budget - spend）");

// ---------- 限额提取 ----------

eq(
  extractQuotas(
    {
      info: {
        budget_limits: [{ budget_duration: "3h", max_budget: 10 }],
        budget_limits_usage: { "3h": { current_spend: 4 } },
      },
    },
    generic.quota
  ).length,
  1,
  "LiteLLM 形态的限额仍能解析"
);
eq(extractQuotas({ remaining: 5 }, generic.quota), [], "普通接口没有限额路径 → 静默为空，不报错");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
