<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import {
  saveBalanceSnapshot,
  getSetting,
  addAccount as dbAddAccount,
  deleteAccount as dbDeleteAccount,
  renameAccount as dbRenameAccount,
  listAccounts,
  type AccountRow,
} from "../core/db";
import { collectAccount, deleteAccountAndSecret } from "../core/collector";
import {
  providers,
  getProvider,
  upsertCustomConfig,
  listCustomConfigs,
  deleteCustomConfig,
} from "../providers";
import { CUSTOM_PREFIX } from "../providers/custom";
import { syncTokensForAccount } from "../core/tokenSync";
import { requestMenubarPush } from "../core/menubarStore";
import {
  litellmPreset,
  genericUsagePreset,
  litellmQuotaDefaults,
  litellmPriceDefaults,
  requestCustomBalance,
  type CustomApiConfig,
  type FieldRule,
  type PriceSyncConfig,
  type QuotaConfig,
} from "../core/customApi";
import { quotaView, windowMinutes, type QuotaView } from "../core/quota";
import BalanceChart from "./BalanceChart.vue";
import { i18n } from "../i18n";
import {
  accounts,
  balances,
  quotas,
  today,
  totalBalance,
  fmt,
  displayCost,
  ensureData,
  loadData,
  showToast,
} from "../core/dashboardStore";

const { t } = useI18n();
const isZh = () => i18n.global.locale.value === "zh";

/**
 * 账户名/数量变了要立刻反映到菜单栏（标题与下拉菜单都用账户名做标签）。
 * 托盘由灵动岛窗口统一推送，这里只发请求，避免多出第二个轮播定时器。
 */
async function reloadAndSyncMenubar(): Promise<void> {
  await loadData();
  await requestMenubarPush();
}

const lowThreshold = ref(20);

// 添加表单
const formProvider = ref("deepseek");
const formName = ref("");
const formKey = ref("");
const adding = ref(false);

// 自定义 API 多 key 输入：一把 key 对应一个账户
const customKeys = ref<{ name: string; key: string }[]>([{ name: "", key: "" }]);

// 下拉框里「自定义 API」固定项（选中后内联展开配置）
const CUSTOM_API_OPTION = "__custom_api__";

// 内联配置表单
const customDraft = ref<CustomApiConfig | null>(null);
const headersText = ref("");
const queryText = ref("");
const advancedOpen = ref(false);
const testKey = ref("");
const testing = ref(false);
const testRaw = ref("");
const testResult = ref("");

function onProviderChange(): void {
  if (formProvider.value === CUSTOM_API_OPTION) {
    customDraft.value = newEmptyConfig();
    headersText.value = "";
    queryText.value = "";
    advancedOpen.value = false;
    syncQuotaTextFromDraft();
  } else {
    customDraft.value = null;
  }
}

function newEmptyConfig(): CustomApiConfig {
  // 默认即 LiteLLM `/key/info` 模板：用户一般只需填 baseUrl 与 key
  return { ...litellmPreset(), name: "" };
}

// 已保存的自定义 API 配置列表。
// 之前只保存没有回显入口：重新选中「自定义 API」时表单总是从空模板开始，
// 于是填过的 Base URL 看起来像「丢了」（其实一直在库里）。
const savedConfigs = ref<CustomApiConfig[]>([]);

async function reloadSavedConfigs(): Promise<void> {
  savedConfigs.value = await listCustomConfigs();
}

/** 该配置下已建的账户数（删除前要拦一下，避免留下孤儿账户） */
function configKeyCount(cfgId: number | string): number {
  return accounts.value.filter((a) => a.provider_id === `${CUSTOM_PREFIX}${cfgId}`).length;
}

function pairsToText(map: Record<string, string>, sep: string): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}${sep} ${v}`)
    .join("\n");
}

/** 把已保存的配置回填到表单（这就是之前缺失的「看回来」入口） */
function editConfig(cfg: CustomApiConfig): void {
  customDraft.value = {
    ...cfg,
    fields: { ...cfg.fields },
    headers: { ...cfg.headers },
    query: { ...cfg.query },
    quota: { ...(cfg.quota ?? litellmQuotaDefaults()) },
    priceSync: { ...(cfg.priceSync ?? litellmPriceDefaults()) },
  };
  headersText.value = pairsToText(cfg.headers ?? {}, ":");
  queryText.value = pairsToText(cfg.query ?? {}, "=");
  advancedOpen.value = true;
  syncQuotaTextFromDraft();
  formProvider.value = CUSTOM_API_OPTION;
}

async function removeConfig(cfg: CustomApiConfig): Promise<void> {
  const n = configKeyCount(cfg.id);
  if (n > 0) {
    showToast(t("dashboard.toast.customApiHasAccounts"));
    return;
  }
  await deleteCustomConfig(cfg.id);
  await reloadSavedConfigs();
  showToast(t("dashboard.toast.customApiDeleted"));
}

/** 可选预设：键用于 i18n 文案，值是要载入的模板 */
const presetKey = ref<"litellm" | "generic">("litellm");

function loadPreset(): void {
  if (!customDraft.value) return;
  const preset = presetKey.value === "generic" ? genericUsagePreset() : litellmPreset();
  customDraft.value = { ...preset, id: customDraft.value.id, name: customDraft.value.name };
  headersText.value = "";
  queryText.value = "";
  syncQuotaTextFromDraft();
  showToast(t("dashboard.customApi.presetLoaded"));
}

/** 把配置里的限额窗口数组回填到输入框 */
function syncQuotaTextFromDraft(): void {
  const windows = draftQuota().windows ?? [];
  quotaWindowsText.value = windows.join(", ");
}

function parsePairs(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const idx = s.indexOf(sep);
    if (idx <= 0) continue;
    const k = s.slice(0, idx).trim();
    const v = s.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function setDraftRule(field: keyof CustomApiConfig["fields"], patch: Partial<FieldRule>): void {
  if (!customDraft.value) return;
  const cur = customDraft.value.fields[field] ?? { source: "", transform: "none" };
  customDraft.value.fields[field] = { ...cur, ...patch };
}

// 模板内不能使用 TS 类型断言，故事件处理放脚本里、模板只传引用
const fieldKeys: Array<keyof CustomApiConfig["fields"]> = ["available", "granted", "currency"];

function fieldUpdate<K extends keyof CustomApiConfig["fields"]>(
  field: K,
  kind: "source" | "transform",
  e: Event
): void {
  const el = e.target as HTMLInputElement;
  if (kind === "source") setDraftRule(field, { source: el.value });
  else setDraftRule(field, { transform: el.value as FieldRule["transform"] });
}

// ---------- 限额（时间窗口额度）----------

/** 草稿里的限额配置；老配置/测试草稿缺省时回退到 LiteLLM 默认值 */
function draftQuota(): QuotaConfig {
  return customDraft.value?.quota ?? litellmQuotaDefaults();
}

function setDraftQuota(patch: Partial<QuotaConfig>): void {
  if (!customDraft.value) return;
  customDraft.value.quota = { ...draftQuota(), ...patch };
}

/** 展示窗口输入框：逗号分隔文本 ↔ 配置数组 */
const quotaWindowsText = ref("3h");

function onQuotaWindowsInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  quotaWindowsText.value = raw;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  setDraftQuota({ windows: list.length > 0 ? list : [] });
}

const quotaLimitsPath = computed(() => draftQuota().limitsPath);
const quotaUsagePath = computed(() => draftQuota().usagePath);

/** 路径输入：留空回退到该字段的 LiteLLM 默认值 */
function onQuotaPathInput(key: "limitsPath" | "usagePath", e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim();
  const fallback = litellmQuotaDefaults();
  if (key === "limitsPath") setDraftQuota({ limitsPath: value || fallback.limitsPath });
  else setDraftQuota({ usagePath: value || fallback.usagePath });
}

// ---------- 网关单价同步 ----------
// 网关的 JSON 结构各家不同，所以字段路径全部可改；默认值是 LiteLLM /model/info。

function draftPriceSync(): PriceSyncConfig {
  return customDraft.value?.priceSync ?? litellmPriceDefaults();
}

function setDraftPriceSync(patch: Partial<PriceSyncConfig>): void {
  if (!customDraft.value) return;
  customDraft.value.priceSync = { ...draftPriceSync(), ...patch };
}

/** 文本字段：留空回退默认；数字字段：非法回退默认 */
function onPriceSyncTextInput(
  key: keyof PriceSyncConfig,
  fallbackKey: keyof PriceSyncConfig,
  e: Event
): void {
  const value = (e.target as HTMLInputElement).value.trim();
  const fallback = litellmPriceDefaults();
  const def = String(fallback[fallbackKey] ?? "");
  setDraftPriceSync({ [key]: value || def } as Partial<PriceSyncConfig>);
}

function onPriceSyncNumberInput(key: "currency" | "exchangeRate", e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim();
  const fallback = litellmPriceDefaults();
  if (key === "currency") {
    setDraftPriceSync({ currency: value || fallback.currency });
    return;
  }
  const n = parseFloat(value);
  setDraftPriceSync({ exchangeRate: Number.isFinite(n) && n > 0 ? n : fallback.exchangeRate });
}

const priceSyncPath = computed(() => draftPriceSync().modelInfoPath);
const priceSyncGroupField = computed(() => draftPriceSync().groupField);
const priceSyncInputField = computed(() => draftPriceSync().inputCostField);
const priceSyncOutputField = computed(() => draftPriceSync().outputCostField);
const priceSyncCurrency = computed(() => draftPriceSync().currency);
const priceSyncRate = computed(() => draftPriceSync().exchangeRate);

/** 账户的限额行（按窗口从短到长，最多展示 2 条，避免卡片过高） */
function accQuotas(accId: number): QuotaView[] {
  const list = quotas.value[accId] ?? [];
  const currency = balances.value[accId]?.currency ?? "USD";
  return list
    .slice()
    .sort((a, b) => windowMinutes(a.window) - windowMinutes(b.window))
    .slice(0, 2)
    .map((q) => quotaView(q, currency))
    .filter((v): v is QuotaView => v !== null);
}

/** 限额明细文案：已用/上限 · 剩余额度（或已超限） · 重置倒计时 */
function quotaDetail(q: QuotaView): string {
  const parts = [
    t("dashboard.quotaUsed", { used: q.usedText, limit: q.limitText }),
    q.over
      ? t("dashboard.quotaOver", { amount: q.overText })
      : t("dashboard.quotaLeft", { amount: q.left }),
  ];
  if (q.reset) parts.push(t("dashboard.quotaReset", { time: q.reset }));
  return parts.join(" · ");
}

function updateBalanceOperand(e: Event): void {
  const v = parseFloat((e.target as HTMLInputElement).value);
  setDraftRule("balance", { operand: Number.isFinite(v) ? v : undefined });
}

function updateBalanceOperandSource(e: Event): void {
  setDraftRule("balance", { operandSource: (e.target as HTMLInputElement).value });
}

const syncingTokens = ref(false);

/** 立即把该配置下所有账户的逐日用量同步进来（来源与窗口由两个开关决定） */
async function syncTokensNow(): Promise<void> {
  const cfg = customDraft.value;
  if (!cfg) return;
  if (!cfg.tokenSync) {
    showToast(t("dashboard.customApi.tokenSyncMissing"));
    return;
  }
  syncingTokens.value = true;
  try {
    const mine = (await listAccounts()).filter(
      (a: AccountRow) => a.provider_id === `${CUSTOM_PREFIX}${cfg.id}`
    );
    if (mine.length === 0) {
      showToast(t("dashboard.customApi.tokenSyncNoAccount"));
      return;
    }
    const history = cfg.syncTokenHistory ?? false;
    let days = 0;
    let cost = 0;
    let failed = 0;
    for (const a of mine) {
      try {
        const key = await invoke<string>("get_secret", { account: String(a.id) });
        const r = await syncTokensForAccount(a.id, cfg, key, { history });
        days += r.days;
        cost += r.cost;
      } catch (e) {
        failed++;
        console.error(`逐日用量同步失败（${a.name}）`, e);
      }
    }
    showToast(
      failed > 0 && days === 0
        ? t("dashboard.customApi.tokenSyncFail")
        : t("dashboard.customApi.tokenSyncOk", {
            days,
            accounts: mine.length,
            cost: cost.toFixed(2),
          })
    );
  } finally {
    syncingTokens.value = false;
  }
}

async function runTest(): Promise<void> {
  if (!customDraft.value) return;
  const key = testKey.value.trim() || customKeys.value.map((r) => r.key.trim()).find(Boolean) || "";
  if (!key) {
    showToast(t("dashboard.toast.apiKeyRequired"));
    return;
  }
  testing.value = true;
  testRaw.value = "";
  testResult.value = "";
  try {
    // 用当前草稿（含 headers/query 行文本）做一次真实请求
    const cfg: CustomApiConfig = {
      ...customDraft.value,
      headers: parsePairs(headersText.value, ":"),
      query: parsePairs(queryText.value, "="),
    };
    const { info, raw } = await requestCustomBalance(cfg, key);
    testRaw.value = JSON.stringify(raw, null, 2);
    testResult.value = JSON.stringify(info, null, 2);
  } catch (e) {
    testRaw.value = (e as Error).message || String(e);
    testResult.value = "";
  } finally {
    testing.value = false;
  }
}

async function saveCustomConfig(): Promise<void> {
  if (!customDraft.value) return;
  const cfg = customDraft.value;
  if (!cfg.name.trim()) {
    cfg.name = "LiteLLM";
  }
  if (!cfg.baseUrl.trim()) {
    showToast(t("dashboard.customApi.baseUrl") + " required");
    return;
  }
  if (!cfg.fields.balance?.source.trim()) {
    showToast(t("dashboard.customApi.fieldBalance") + " required");
    return;
  }
  cfg.headers = parsePairs(headersText.value, ":");
  cfg.query = parsePairs(queryText.value, "=");
  await upsertCustomConfig(cfg);
  const newProviderId = `${CUSTOM_PREFIX}${cfg.id}`;
  await reloadSavedConfigs();

  // 用填写的多把 key 建账户
  const rows = customKeys.value.filter((r) => r.key.trim());
  const baseName = formName.value.trim() || cfg.name;
  for (const row of rows) {
    const accName = row.name.trim() || `${baseName} ${customKeys.value.indexOf(row) + 1}`;
    await addSingleAccount(newProviderId, accName, row.key.trim());
  }

  formProvider.value = newProviderId;
  customDraft.value = null;
  customKeys.value = [{ name: "", key: "" }];
  formName.value = "";
  await reloadAndSyncMenubar();
  showToast(rows.length > 0 ? t("dashboard.toast.addOk", { name: baseName }) : t("dashboard.toast.customApiSaved"));
}

async function addSingleAccount(providerId: string, name: string, key: string): Promise<void> {
  const provider = getProvider(providerId);
  const id = await dbAddAccount(providerId, name);
  try {
    await invoke("save_secret", { account: String(id), secret: key });
  } catch (e) {
    await dbDeleteAccount(id);
    throw e;
  }
  if (provider?.balanceSupported) {
    // 必须先把数据读回来再找：刚插入的账户还不在 accounts.value 里，
    // 直接 find 永远找不到，结果是「新加的账户余额一直是空的，要等下轮自动采集」。
    await loadData();
    const acc = accounts.value.find((a) => a.id === id);
    if (acc) await collectAccount(acc);
  }
}

async function addAccount(): Promise<void> {
  const providerId = formProvider.value;
  const provider = getProvider(providerId);
  const name = formName.value.trim() || provider?.name || providerId;
  const key = formKey.value.trim();

  if (!key) {
    showToast(t("dashboard.toast.apiKeyRequired"));
    return;
  }

  adding.value = true;
  try {
    await addSingleAccount(providerId, name, key);
    formKey.value = "";
    formName.value = "";
    showToast(t("dashboard.toast.addOk", { name }));
    await reloadAndSyncMenubar();
  } catch (e) {
    showToast(t("dashboard.toast.addFail", { err: (e as Error).message || String(e) }));
  } finally {
    adding.value = false;
  }
}

function addCustomKeyRow(): void {
  customKeys.value.push({ name: "", key: "" });
}

function cancelCustomForm(): void {
  formProvider.value = "deepseek";
  customDraft.value = null;
  customKeys.value = [{ name: "", key: "" }];
}

async function removeAccount(accId: number, accName: string): Promise<void> {
  await deleteAccountAndSecret(accId);
  showToast(t("dashboard.toast.delOk", { name: accName }));
  await reloadAndSyncMenubar();
}

// 重命名：同一 baseUrl 的多把 key 默认叫「XXX 1 / XXX 2」，靠重命名区分，
// 菜单栏也用这个名字做标签，所以放在账户卡片上随手可改。
const renamingId = ref<number | null>(null);
const renameDraft = ref("");

function startRename(accId: number, name: string): void {
  renamingId.value = accId;
  renameDraft.value = name;
}

async function commitRename(): Promise<void> {
  const id = renamingId.value;
  if (id === null) return;
  const name = renameDraft.value.trim();
  if (!name) {
    renamingId.value = null;
    return;
  }
  await dbRenameAccount(id, name);
  renamingId.value = null;
  showToast(t("dashboard.toast.renameOk", { name }));
  await reloadAndSyncMenubar();
}

async function refreshOne(accId: number, accName: string): Promise<void> {
  const acc = accounts.value.find((a) => a.id === accId);
  if (!acc) return;
  try {
    await collectAccount(acc);
    showToast(t("dashboard.toast.refreshOneOk", { name: accName }));
  } catch (e) {
    showToast(t("dashboard.toast.refreshOneFail", { err: (e as Error).message }));
  }
  await loadData();
}

const showBalanceModal = ref(false);
const modalAccount = ref<number | null>(null);
const modalBalance = ref("");
const modalCurrency = ref("CNY");

function openBalanceModal(accId: number): void {
  modalAccount.value = accId;
  const cur = balances.value[accId];
  modalBalance.value = cur ? String(cur.balance) : "";
  modalCurrency.value = cur?.currency ?? "CNY";
  showBalanceModal.value = true;
}

function closeBalanceModal(): void {
  showBalanceModal.value = false;
}

async function saveManualBalance(): Promise<void> {
  if (modalAccount.value === null) return;
  const v = parseFloat(modalBalance.value);
  if (Number.isNaN(v) || v < 0) {
    showToast(t("dashboard.toast.balanceInvalid"));
    return;
  }
  await saveBalanceSnapshot(modalAccount.value, { balance: v, currency: modalCurrency.value });
  showToast(t("dashboard.toast.balanceRegistered"));
  closeBalanceModal();
  await loadData();
}

// 余额趋势
const trendAccountId = ref<number | null>(null);
const trendRange = ref<"1" | "7" | "30" | "custom">("1");
const trendStartDate = ref("");
const trendEndDate = ref("");
const trendMinDate = "2010-01-01";

function trendMaxDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function trendDays(): number | undefined {
  if (trendRange.value === "custom") return undefined;
  return Number(trendRange.value);
}

function trendStart(): string | undefined {
  return trendRange.value === "custom" ? trendStartDate.value : undefined;
}

function trendEnd(): string | undefined {
  return trendRange.value === "custom" ? trendEndDate.value : undefined;
}

onMounted(async () => {
  await ensureData();
  await reloadSavedConfigs();
  const rawThreshold = await getSetting("low_balance_threshold");
  if (rawThreshold) lowThreshold.value = parseInt(rawThreshold, 10) || 20;
  // 默认账户与自定义日期范围
  if (trendAccountId.value === null && accounts.value.length > 0) {
    trendAccountId.value = accounts.value[0].id;
  }
  if (!trendStartDate.value) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const pad = (n: number) => String(n).padStart(2, "0");
    trendStartDate.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (!trendEndDate.value) {
    trendEndDate.value = trendMaxDate();
  }
});
</script>

<template>
  <div>
    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-label">{{ t("dashboard.statTotal") }}</div>
        <div class="stat-value">{{ accounts.length }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">{{ t("dashboard.statBalance") }}</div>
        <div class="stat-value">{{ fmt(totalBalance) }} <span class="unit">¥</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">{{ t("dashboard.statToday") }}</div>
        <div class="stat-value">
          {{ fmt(displayCost(today.cost, today.cost_estimated)) }} <span class="unit">¥</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.trend") }}</h3>
      <div class="form-row">
        <select v-model="trendAccountId" class="input select">
          <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }}</option>
        </select>
        <select v-model="trendRange" class="input select">
          <option value="1">{{ t("dashboard.trendRange.1") }}</option>
          <option value="7">{{ t("dashboard.trendRange.7") }}</option>
          <option value="30">{{ t("dashboard.trendRange.30") }}</option>
          <option value="custom">{{ t("dashboard.trendRange.custom") }}</option>
        </select>
        <input
          v-if="trendRange === 'custom'"
          v-model="trendStartDate"
          class="input"
          type="date"
          :min="trendMinDate"
          :max="trendMaxDate()"
        />
        <span v-if="trendRange === 'custom'">→</span>
        <input
          v-if="trendRange === 'custom'"
          v-model="trendEndDate"
          class="input"
          type="date"
          :min="trendMinDate"
          :max="trendMaxDate()"
        />
      </div>
      <BalanceChart
        :account-id="trendAccountId"
        :days="trendDays()"
        :start-date="trendStart()"
        :end-date="trendEnd()"
      />
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.addAccount") }}</h3>
      <div class="form-row">
        <select v-model="formProvider" class="input select" @change="onProviderChange">
          <option :value="CUSTOM_API_OPTION">{{ t("dashboard.customApi.title") }}</option>
          <option v-for="p in providers" :key="p.id" :value="p.id">
            {{ p.name }}{{ p.balanceSupported ? "" : "（" + t("dashboard.registerBalance") + "）" }}
          </option>
        </select>
        <template v-if="formProvider !== CUSTOM_API_OPTION">
          <input v-model="formName" class="input" :placeholder="t('dashboard.accountName')" />
          <input
            v-model="formKey"
            class="input key"
            type="password"
            :placeholder="t('dashboard.apiKey')"
          />
          <button class="btn primary" :disabled="adding" @click="addAccount">
            {{ adding ? t("dashboard.adding") : t("dashboard.add") }}
          </button>
        </template>
      </div>
      <p v-if="formProvider !== CUSTOM_API_OPTION && !getProvider(formProvider)?.balanceSupported" class="hint">
        {{ t("dashboard.manualHint") }}
      </p>

      <!-- 已保存的网关配置：之前只写不读，填过的 Base URL 看不到，像是「丢了」 -->
      <div v-if="savedConfigs.length > 0" class="saved-configs">
        <div class="field-sep">
          <span class="sec-title">{{ t("dashboard.customApi.savedList") }}</span>
        </div>
        <div v-for="cfg in savedConfigs" :key="cfg.id" class="saved-row">
          <div class="saved-info">
            <div class="saved-name">{{ cfg.name }}</div>
            <div class="saved-url mono">{{ cfg.baseUrl }}</div>
          </div>
          <span class="saved-count">
            {{ t("dashboard.customApi.keyCount", { count: configKeyCount(cfg.id) }) }}
          </span>
          <button class="btn small" @click="editConfig(cfg)">
            {{ t("dashboard.customApi.edit") }}
          </button>
          <button class="btn small danger" @click="removeConfig(cfg)">
            {{ t("dashboard.customApi.delete") }}
          </button>
        </div>
      </div>

      <!-- 自定义 API：内联配置 -->
      <div v-if="formProvider === CUSTOM_API_OPTION && customDraft" class="custom-form">
        <div class="field-grid">
          <label class="field grow">
            <span>{{ t("dashboard.customApi.baseUrl") }}</span>
            <input v-model="customDraft.baseUrl" class="input" :placeholder="t('dashboard.customApi.baseUrlPlaceholder')" />
          </label>
          <label class="field">
            <span>{{ t("dashboard.customApi.name") }}</span>
            <input v-model="customDraft.name" class="input" :placeholder="t('dashboard.customApi.namePlaceholder')" />
          </label>
        </div>
        <p class="hint">{{ t("dashboard.customApi.defaultTemplateHint") }}</p>

        <div class="field-sep">
          <span class="sec-title">{{ t("dashboard.apiKey") }}</span>
          <button class="btn small" @click="addCustomKeyRow">+ {{ t("dashboard.customApi.addKey") }}</button>
        </div>
        <div class="key-rows">
          <div v-for="(row, i) in customKeys" :key="i" class="key-row">
            <input v-model="row.name" class="input key-name" :placeholder="t('dashboard.customApi.keyNamePlaceholder')" />
            <input v-model="row.key" class="input key" type="password" :placeholder="t('dashboard.customApi.keyPlaceholder')" />
            <button v-if="customKeys.length > 1" class="btn small danger" @click="customKeys.splice(i, 1)">×</button>
          </div>
        </div>
        <p class="hint">{{ t("dashboard.customApi.multiKeyHint") }}</p>

        <div class="test-block">
          <div class="form-row">
            <input v-model="testKey" class="input key" type="password" :placeholder="t('dashboard.customApi.testKey')" />
            <button class="btn small" :disabled="testing" @click="runTest">
              {{ testing ? t("dashboard.adding") : t("dashboard.customApi.testRun") }}
            </button>
          </div>
          <div v-if="testRaw" class="test-out">
            <div class="test-label">{{ t("dashboard.customApi.testRaw") }}</div>
            <pre class="mono">{{ testRaw }}</pre>
          </div>
          <div v-if="testResult" class="test-out">
            <div class="test-label">{{ t("dashboard.customApi.testResult") }}</div>
            <pre class="mono">{{ testResult }}</pre>
          </div>
        </div>

        <button class="btn small ghost toggle" @click="advancedOpen = !advancedOpen">
          {{ advancedOpen ? "▾" : "▸" }} {{ t("dashboard.customApi.advanced") }}
        </button>

        <div v-if="advancedOpen" class="advanced">
          <div class="field-grid">
            <label class="field">
              <span>{{ t("dashboard.customApi.method") }}</span>
              <select v-model="customDraft.method" class="input select">
                <option v-for="m in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label class="field">
              <span>{{ t("dashboard.customApi.path") }}</span>
              <input v-model="customDraft.path" class="input" :placeholder="t('dashboard.customApi.pathPlaceholder')" />
            </label>
          </div>

          <label class="check-row">
            <input v-model="customDraft.bearerAuth" type="checkbox" />
            <span>{{ t("dashboard.customApi.bearerAuth") }}</span>
          </label>

          <div class="field">
            <span>{{ t("dashboard.customApi.headers") }}</span>
            <textarea v-model="headersText" class="input mono" rows="2" :placeholder="t('dashboard.customApi.headersHint')"></textarea>
          </div>
          <div class="field">
            <span>{{ t("dashboard.customApi.query") }}</span>
            <textarea v-model="queryText" class="input mono" rows="2" :placeholder="t('dashboard.customApi.queryHint')"></textarea>
          </div>
          <div class="field">
            <span>{{ t("dashboard.customApi.body") }}</span>
            <textarea v-model="customDraft.body" class="input mono" rows="3" :placeholder="t('dashboard.customApi.bodyHint')"></textarea>
          </div>

          <div class="field-sep">
            <span class="sec-title">{{ t("dashboard.customApi.fields") }}</span>
            <span class="preset-row">
              <select v-model="presetKey" class="input select">
                <option value="litellm">{{ t("dashboard.customApi.presetLitellm") }}</option>
                <option value="generic">{{ t("dashboard.customApi.presetGeneric") }}</option>
              </select>
              <button class="btn small" @click="loadPreset">{{ t("dashboard.customApi.preset") }}</button>
            </span>
          </div>
          <p class="hint">{{ t("dashboard.customApi.fieldsHint") }}</p>

          <div class="rule-row">
            <span class="rule-label">{{ t("dashboard.customApi.fieldBalance") }}</span>
            <input
              class="input mono grow"
              :value="customDraft.fields.balance?.source ?? ''"
              :placeholder="t('dashboard.customApi.source')"
              @input="fieldUpdate('balance', 'source', $event)"
            />
            <select
              class="input select"
              :value="customDraft.fields.balance?.transform ?? 'none'"
              @change="fieldUpdate('balance', 'transform', $event)"
            >
              <option value="none">{{ t("dashboard.customApi.transformNone") }}</option>
              <option value="subtract">{{ t("dashboard.customApi.transformSubtract") }}</option>
              <option value="divide">{{ t("dashboard.customApi.transformDivide") }}</option>
              <option value="multiply">{{ t("dashboard.customApi.transformMultiply") }}</option>
            </select>
            <input
              v-if="customDraft.fields.balance?.transform === 'divide' || customDraft.fields.balance?.transform === 'multiply'"
              class="input num"
              type="number"
              step="any"
              :placeholder="t('dashboard.customApi.operand')"
              :value="customDraft.fields.balance?.operand ?? ''"
              @input="updateBalanceOperand"
            />
            <input
              v-if="customDraft.fields.balance?.transform === 'subtract'"
              class="input mono"
              :placeholder="t('dashboard.customApi.operandSource')"
              :value="customDraft.fields.balance?.operandSource ?? ''"
              @input="updateBalanceOperandSource"
            />
          </div>

          <div v-for="f in fieldKeys" :key="f" class="rule-row">
            <span class="rule-label">{{ t(`dashboard.customApi.${f === 'available' ? 'fieldAvailable' : f === 'granted' ? 'fieldGranted' : 'fieldCurrency'}`) }}</span>
            <input
              class="input mono grow"
              :value="customDraft.fields[f]?.source ?? ''"
              :placeholder="t('dashboard.customApi.source')"
              @input="fieldUpdate(f, 'source', $event)"
            />
            <select
              class="input select"
              :value="customDraft.fields[f]?.transform ?? 'none'"
              @change="fieldUpdate(f, 'transform', $event)"
            >
              <option value="none">{{ t("dashboard.customApi.transformNone") }}</option>
              <option value="subtract">{{ t("dashboard.customApi.transformSubtract") }}</option>
              <option value="divide">{{ t("dashboard.customApi.transformDivide") }}</option>
              <option value="multiply">{{ t("dashboard.customApi.transformMultiply") }}</option>
            </select>
          </div>

          <div class="field-sep">
            <span class="sec-title">{{ t("dashboard.customApi.quotaTitle") }}</span>
          </div>
          <p class="hint">{{ t("dashboard.customApi.quotaHint") }}</p>
          <div class="field-grid">
            <label class="field">
              <span>{{ t("dashboard.customApi.quotaWindows") }}</span>
              <input
                class="input"
                :value="quotaWindowsText"
                placeholder="3h"
                @input="onQuotaWindowsInput"
              />
            </label>
            <label class="field">
              <span>{{ t("dashboard.customApi.quotaLimitsPath") }}</span>
              <input
                class="input mono"
                :value="quotaLimitsPath"
                :placeholder="t('dashboard.customApi.source')"
                @input="onQuotaPathInput('limitsPath', $event)"
              />
            </label>
          </div>
          <label class="field">
            <span>{{ t("dashboard.customApi.quotaUsagePath") }}</span>
            <input
              class="input mono"
              :value="quotaUsagePath"
              :placeholder="t('dashboard.customApi.source')"
              @input="onQuotaPathInput('usagePath', $event)"
            />
          </label>

          <div class="field-sep">
            <span class="sec-title">{{ t("dashboard.customApi.priceSyncTitle") }}</span>
          </div>
          <p class="hint">{{ t("dashboard.customApi.priceSyncHint") }}</p>
          <div class="field-grid">
            <label class="field grow">
              <span>{{ t("dashboard.customApi.priceSyncPath") }}</span>
              <input
                class="input mono"
                :value="priceSyncPath"
                placeholder="/model/info"
                @input="onPriceSyncTextInput('modelInfoPath', 'modelInfoPath', $event)"
              />
            </label>
            <label class="field">
              <span>{{ t("dashboard.customApi.priceSyncGroupField") }}</span>
              <input
                class="input mono"
                :value="priceSyncGroupField"
                placeholder="model_name"
                @input="onPriceSyncTextInput('groupField', 'groupField', $event)"
              />
            </label>
          </div>
          <div class="field-grid">
            <label class="field">
              <span>{{ t("dashboard.customApi.priceSyncInputField") }}</span>
              <input
                class="input mono"
                :value="priceSyncInputField"
                placeholder="model_info.input_cost_per_token"
                @input="onPriceSyncTextInput('inputCostField', 'inputCostField', $event)"
              />
            </label>
            <label class="field">
              <span>{{ t("dashboard.customApi.priceSyncOutputField") }}</span>
              <input
                class="input mono"
                :value="priceSyncOutputField"
                placeholder="model_info.output_cost_per_token"
                @input="onPriceSyncTextInput('outputCostField', 'outputCostField', $event)"
              />
            </label>
          </div>
          <div class="field-grid">
            <label class="field">
              <span>{{ t("dashboard.customApi.priceSyncCurrency") }}</span>
              <input
                class="input mono"
                :value="priceSyncCurrency"
                placeholder="USD"
                @input="onPriceSyncNumberInput('currency', $event)"
              />
            </label>
            <label class="field">
              <span>{{ t("dashboard.customApi.priceSyncRate") }}</span>
              <input
                class="input mono"
                :value="priceSyncRate"
                placeholder="7.2"
                @input="onPriceSyncNumberInput('exchangeRate', $event)"
              />
            </label>
          </div>

          <div class="field-sep">
            <span class="sec-title">{{ t("dashboard.customApi.tokenSyncTitle") }}</span>
            <button class="btn small" :disabled="syncingTokens" @click="syncTokensNow">
              {{ syncingTokens ? t("dashboard.customApi.syncing") : t("dashboard.customApi.tokenSyncNow") }}
            </button>
          </div>
          <p class="hint">{{ t("dashboard.customApi.tokenSyncHint") }}</p>
          <label class="check-row">
            <input v-model="customDraft.syncTokens" type="checkbox" />
            <span>{{ t("dashboard.customApi.syncTokens") }}</span>
          </label>
          <label class="check-row">
            <input v-model="customDraft.syncTokenHistory" type="checkbox" />
            <span>{{ t("dashboard.customApi.syncTokenHistory") }}</span>
          </label>
        </div>

        <div class="modal-actions">
          <button class="btn ghost" @click="cancelCustomForm">{{ t("dashboard.cancel") }}</button>
          <button class="btn primary" :disabled="adding" @click="saveCustomConfig">{{ t("dashboard.customApi.save") }}</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.accountList") }}</h3>
      <div v-if="accounts.length === 0" class="empty-tip">{{ t("dashboard.noAccounts") }}</div>
      <div v-for="acc in accounts" :key="acc.id" class="acc-card">
        <div class="acc-top">
          <div class="acc-info">
            <div v-if="renamingId === acc.id" class="acc-rename">
              <input
                v-model="renameDraft"
                class="input"
                @keydown.enter="commitRename"
                @keydown.esc="renamingId = null"
              />
              <button class="btn small primary" @click="commitRename">
                {{ t("dashboard.confirm") }}
              </button>
              <button class="btn small" @click="renamingId = null">
                {{ t("dashboard.cancel") }}
              </button>
            </div>
            <div v-else class="acc-name">
              {{ acc.name }}
              <button class="btn-link" @click="startRename(acc.id, acc.name)">
                {{ t("dashboard.rename") }}
              </button>
            </div>
            <div class="acc-sub">
              {{ getProvider(acc.provider_id)?.name ?? acc.provider_id }}
              <template v-if="balances[acc.id]">
                · {{ t("dashboard.updateAt") }}
                {{
                  new Date(balances[acc.id].fetched_at.replace(" ", "T")).toLocaleString(
                    isZh() ? "zh-CN" : "en-US"
                  )
                }}
              </template>
            </div>
          </div>
          <div class="acc-balance">
            <div class="bal-num">{{ balances[acc.id] ? fmt(balances[acc.id].balance) : "--" }}</div>
            <div class="bal-cur">{{ balances[acc.id]?.currency ?? "" }}</div>
          </div>
          <div class="acc-actions">
            <button class="btn small" @click="refreshOne(acc.id, acc.name)">
              {{ t("dashboard.refresh") }}
            </button>
            <button
              v-if="!getProvider(acc.provider_id)?.balanceSupported"
              class="btn small"
              @click="openBalanceModal(acc.id)"
            >
              {{ t("dashboard.registerBalance") }}
            </button>
            <button class="btn small danger" @click="removeAccount(acc.id, acc.name)">
              {{ t("dashboard.delete") }}
            </button>
          </div>
        </div>
        <!-- 时间窗口额度（如 3 小时限额） -->
        <div v-for="q in accQuotas(acc.id)" :key="q.window" class="acc-quota-row">
          <span class="q-window" :class="q.level">{{ q.window }}</span>
          <div class="q-bar"><i :class="q.level" :style="{ width: q.barPct + '%' }"></i></div>
          <span class="q-text">{{ q.pct }}% · {{ quotaDetail(q) }}</span>
        </div>
      </div>
    </div>

    <div v-if="showBalanceModal" class="modal-mask" @click.self="closeBalanceModal">
      <div class="modal">
        <h3>{{ t("dashboard.registerBalance") }}</h3>
        <p class="hint">
          {{
            balances[modalAccount ?? -1]
              ? getProvider(accounts.find((a) => a.id === modalAccount)?.provider_id ?? "")?.name
              : ""
          }}
        </p>
        <div class="form-row">
          <input
            v-model="modalBalance"
            class="input num"
            type="number"
            step="0.01"
            min="0"
            :placeholder="t('dashboard.registerBalance')"
          />
          <select v-model="modalCurrency" class="input select">
            <option value="CNY">CNY</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="closeBalanceModal">{{ t("dashboard.cancel") }}</button>
          <button class="btn primary" @click="saveManualBalance">
            {{ t("dashboard.settings.save") }}
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.stat-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 14px 16px;
}
.stat-label {
  color: var(--c-text-dim);
  font-size: 12px;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.unit {
  font-size: 13px;
  color: var(--c-text-dim);
  font-weight: 400;
}

.panel {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}
.panel h3 {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--c-text-secondary);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.panel-head h3 {
  margin-bottom: 12px;
}

.key-rows {
  flex: 1;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.key-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.key-name {
  width: 150px;
  flex-shrink: 0;
}

.custom-form {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--c-border);
}
.saved-configs {
  margin-top: 12px;
}
.saved-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  margin-bottom: 6px;
}
.saved-info {
  flex: 1;
  min-width: 0;
}
.saved-name {
  font-size: 13px;
  font-weight: 600;
}
.saved-url {
  font-size: 12px;
  color: var(--c-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.saved-count {
  font-size: 12px;
  color: var(--c-text-dim);
  flex-shrink: 0;
}
.toggle {
  margin-bottom: 10px;
}
.test-block {
  margin: 4px 0 12px;
}
.test-out {
  margin-bottom: 10px;
}
.test-label {
  color: var(--c-text-dim);
  font-size: 12px;
  margin-bottom: 4px;
}
.test-out pre {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 10px;
  font-size: 12px;
  color: #d1d5db;
  overflow-x: auto;
  max-height: 220px;
  white-space: pre;
  margin: 0;
}
.advanced {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px dashed var(--c-border);
}
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.field > span {
  color: var(--c-text-dim);
  font-size: 12px;
}
.field.grow {
  grid-column: 1 / -1;
}
.input.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.input.grow {
  flex: 1;
  min-width: 0;
}
.input.num {
  width: 110px;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--c-text);
  cursor: pointer;
}
.field-sep {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 0 8px;
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.preset-row .select {
  width: auto;
  max-width: 220px;
}
.sec-title {
  font-weight: 600;
  color: var(--c-text-secondary);
  font-size: 13px;
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.rule-label {
  width: 150px;
  flex-shrink: 0;
  color: var(--c-text-dim);
  font-size: 12px;
  text-align: right;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.btn.ghost {
  background: transparent;
}

.form-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.input {
  background: var(--c-border);
  border: 1px solid var(--c-border-strong);
  border-radius: 8px;
  color: var(--c-text);
  padding: 8px 12px;
  font-size: 13px;
  outline: none;
}
.input:focus {
  border-color: var(--c-accent-strong);
}
.input.key {
  flex: 1;
  min-width: 220px;
}
.input.num {
  width: 120px;
}
.select {
  width: 180px;
}

.btn {
  background: var(--c-border-strong);
  border: 1px solid var(--c-border-strong);
  color: var(--c-text);
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn.primary {
  background: var(--c-accent);
  border-color: var(--c-accent);
  color: #fff;
}
.btn.primary:hover {
  background: var(--c-accent-strong);
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
.btn.danger {
  color: var(--c-danger);
  border-color: rgba(248, 113, 113, 0.3);
}
.btn.danger:hover {
  background: rgba(248, 113, 113, 0.12);
}

.hint {
  color: var(--c-text-faint);
  font-size: 12px;
  margin: 6px 0 0;
  line-height: 1.7;
}
.empty-tip {
  color: var(--c-text-faint);
  padding: 20px;
  text-align: center;
}

.acc-card {
  padding: 12px;
  border-radius: 10px;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  margin-bottom: 8px;
}
.acc-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.acc-info {
  flex: 1;
  min-width: 0;
}
.acc-name {
  font-weight: 600;
}
.acc-rename {
  display: flex;
  gap: 6px;
  align-items: center;
}
.acc-rename .input {
  padding: 4px 8px;
  font-size: 13px;
  min-width: 140px;
}
/* 重命名入口做成弱按钮，不抢账户卡片上「刷新/删除」的视觉权重 */
.btn-link {
  background: none;
  border: none;
  color: var(--c-text-faint);
  font-size: 11px;
  cursor: pointer;
  padding: 0 4px;
}
.btn-link:hover {
  color: var(--c-accent-strong);
}
.acc-sub {
  color: var(--c-text-faint);
  font-size: 12px;
  margin-top: 2px;
}
.acc-balance {
  text-align: right;
  min-width: 100px;
}
.bal-num {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.bal-cur {
  font-size: 11px;
  color: var(--c-text-faint);
}
.acc-actions {
  display: flex;
  gap: 6px;
}

/* ---- 时间窗口额度行（3 小时限额） ---- */
.acc-quota-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--c-border);
}
.q-window {
  font-size: 12px;
  font-weight: 700;
  min-width: 30px;
  flex-shrink: 0;
  color: var(--c-accent-strong);
}
.q-window.warn {
  color: var(--c-warn);
}
.q-window.danger {
  color: var(--c-danger);
}
.q-bar {
  width: 120px;
  flex-shrink: 0;
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.q-bar > i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--c-accent-strong);
  transition: width 0.3s ease;
}
.q-bar > i.warn {
  background: var(--c-warn);
}
.q-bar > i.danger {
  background: var(--c-danger);
}
.q-text {
  font-size: 12px;
  color: var(--c-text-dim);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: #161a23;
  border: 1px solid var(--c-border-strong);
  border-radius: 14px;
  padding: 20px;
  width: 320px;
}
.modal h3 {
  margin: 0 0 6px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
