<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import {
  saveBalanceSnapshot,
  getSetting,
  addAccount as dbAddAccount,
  deleteAccount as dbDeleteAccount,
} from "../core/db";
import { collectAccount, deleteAccountAndSecret } from "../core/collector";
import { providers, getProvider, upsertCustomConfig } from "../providers";
import { CUSTOM_PREFIX } from "../providers/custom";
import {
  litellmPreset,
  requestCustomBalance,
  type CustomApiConfig,
  type FieldRule,
} from "../core/customApi";
import BalanceChart from "./BalanceChart.vue";
import { i18n } from "../i18n";
import {
  accounts,
  balances,
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
  } else {
    customDraft.value = null;
  }
}

function newEmptyConfig(): CustomApiConfig {
  // 默认即 LiteLLM `/key/info` 模板：用户一般只需填 baseUrl 与 key
  return { ...litellmPreset(), name: "" };
}

function loadPreset(): void {
  if (!customDraft.value) return;
  const preset = litellmPreset();
  customDraft.value = { ...preset, id: customDraft.value.id, name: customDraft.value.name };
  headersText.value = "";
  queryText.value = "";
  showToast(t("dashboard.customApi.presetLoaded"));
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

function updateBalanceOperand(e: Event): void {
  const v = parseFloat((e.target as HTMLInputElement).value);
  setDraftRule("balance", { operand: Number.isFinite(v) ? v : undefined });
}

function updateBalanceOperandSource(e: Event): void {
  setDraftRule("balance", { operandSource: (e.target as HTMLInputElement).value });
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
  await loadData();
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
    await loadData();
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
  await loadData();
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
            <button class="btn small" @click="loadPreset">{{ t("dashboard.customApi.preset") }}</button>
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
        <div class="acc-info">
          <div class="acc-name">{{ acc.name }}</div>
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
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  margin-bottom: 8px;
}
.acc-info {
  flex: 1;
  min-width: 0;
}
.acc-name {
  font-weight: 600;
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
