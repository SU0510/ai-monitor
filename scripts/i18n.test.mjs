/**
 * 文案自检：这层没法靠 AX 读界面来验（WKWebView 不暴露 DOM 节点），
 * 只能从源码侧把「模板传的参数」和「语言包里的占位符」对齐。
 *
 * 三类问题都在这里拦：
 *  1. 加了 zh 忘了 en（或反过来）——键集合必须完全一致；
 *  2. 翻译时写错/漏掉占位符（`{days}` 少一个 s）——同一个键两种语言的占位符必须一致；
 *  3. 调用方传的参数和占位符对不上——渲染出来会直接露出 "{days}" 这种字面量，
 *     界面不会报错，只有用户能看见。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createI18n } from "vue-i18n";
import zh from "../src/i18n/locales/zh.ts";
import en from "../src/i18n/locales/en.ts";

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

// ---------- 1. 键集合 ----------

const flatten = (o, prefix = "") =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? flatten(v, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );
const zhKeys = new Set(flatten(zh));
const enKeys = new Set(flatten(en));
eq(
  [...zhKeys].filter((k) => !enKeys.has(k)),
  [],
  "en 缺少 zh 里存在的键"
);
eq(
  [...enKeys].filter((k) => !zhKeys.has(k)),
  [],
  "zh 缺少 en 里存在的键"
);

// ---------- 2. 同一键的占位符必须一致 ----------

const at = (o, key) => key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const placeholders = (s) =>
  typeof s === "string" ? [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort() : null;

let phMismatch = 0;
for (const key of zhKeys) {
  const a = placeholders(at(zh, key));
  const b = placeholders(at(en, key));
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    phMismatch++;
    console.log(`FAIL 占位符不一致 ${key}\n  zh: ${JSON.stringify(a)}\n  en: ${JSON.stringify(b)}`);
  }
}
eq(phMismatch, 0, "两种语言的占位符差异数");
ok(phMismatch === 0, "所有键的中英占位符一致");

// ---------- 3. 调用方参数 vs 语言包占位符 ----------

/** 按顶层逗号切开对象字面量，跳过括号/引号里的逗号（`cost.toFixed(2)` 不能算两段） */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0,
    quote = null,
    cur = "";
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const files = ["src/views", "src/components"].flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".vue"))
    .map((f) => join(dir, f))
);

let sites = 0,
  siteMismatch = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  // 只看字面量键 + 内联对象：`t(\`a.${b}\`)` 这种动态键没法静态核对
  for (const m of src.matchAll(/\bt\(\s*"([\w.]+)"\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
    const parts = splitTopLevel(m[2]);
    // 展开运算符之类的写法静态判断不了，整个调用跳过，避免误报
    if (parts.some((p) => !/^\s*[A-Za-z_$][\w$]*\s*:?/.test(p))) continue;
    const used = parts.map((p) => p.match(/^\s*([A-Za-z_$][\w$]*)/)[1]).sort();
    const declared = placeholders(at(zh, m[1]));
    if (declared === null) continue; // 键不存在的情况上一步的键集合检查已经报了
    sites++;
    if (JSON.stringify(used) !== JSON.stringify(declared)) {
      siteMismatch++;
      console.log(
        `FAIL ${m[1]} @${file}\n  语言包: ${JSON.stringify(declared)}\n  调用处: ${JSON.stringify(used)}`
      );
    }
  }
}
ok(sites > 20, `扫到的带参数 t() 调用数应有意义（实际 ${sites}）`);
eq(siteMismatch, 0, "调用处参数与占位符不匹配的数量");

// ---------- 4. 真的渲染一遍缓存相关文案 ----------

for (const [locale, messages] of [
  ["zh", zh],
  ["en", en],
]) {
  const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } });
  const { t } = i18n.global;

  const overlayToday = t("overlay.todayCache", { hit: "44.8M", rate: "85.0%" });
  ok(!overlayToday.includes("{"), `[${locale}] overlay.todayCache 渲染后不该残留占位符`);
  ok(overlayToday.includes("44.8M"), `[${locale}] overlay.todayCache 应带上命中 token`);
  ok(overlayToday.includes("85.0%"), `[${locale}] overlay.todayCache 应带上命中率`);

  const overlayTip = t("overlay.cacheHitTokens", { hit: "46,666,944" });
  ok(overlayTip.includes("46,666,944"), `[${locale}] overlay.cacheHitTokens 应带上完整数字`);
  ok(!overlayTip.includes("{"), `[${locale}] overlay.cacheHitTokens 不该残留占位符`);
  ok(t("overlay.cacheLabel").length > 0, `[${locale}] overlay.cacheLabel 非空`);

  // 缓存的三个仪表盘标签：key 存在且渲染不含占位符
  for (const key of [
    "dashboard.cacheHit",
    "dashboard.cacheHitRate",
    "dashboard.inputTokensInclCache",
  ]) {
    const s = t(key);
    ok(typeof s === "string" && s.length > 0 && s !== key, `[${locale}] ${key} 有译文`);
    ok(!s.includes("{"), `[${locale}] ${key} 渲染后不该残留占位符`);
  }
}

console.log(`\ni18n: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
