<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  listCustomConfigs,
  upsertCustomConfig,
  deleteCustomConfig,
} from "../providers";
import {
  newConfigId,
  litellmPreset,
  requestCustomBalance,
  type CustomApiConfig,
  type FieldRule,
} from "../core/customApi";
import { accounts, showToast } from "../core/dashboardStore";

const { t } = useI18n();

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const configs = ref<CustomApiConfig[]>([]);
const editingId = ref<string | null>(null);
const draft = ref<CustomApiConfig | null>(null);

const methods: Array<CustomApiConfig["method"]> = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// 测试请求状态
const testKey = ref("");
const testing = ref(false);
const testRaw = ref("");
const testResult = ref("");

async function reload(): Promise<void> {
  configs.value = await listCustomConfigs();
}

function newDraft(): CustomApiConfig {
  return {
    id: newConfigId(),
    name: "",
    baseUrl: "",
    path: "",
    method: "GET",
    headers: {},
    query: {},
    body: "",
    fields: {
      balance: { source: "", transform: "none" },
    },
    bearerAuth: true,
  };
}

function openNew(): void {
  editingId.value = null;
  draft.value = newDraft();
}

function openEdit(cfg: CustomApiConfig): void {
  editingId.value = cfg.id;
  draft.value = JSON.parse(JSON.stringify(cfg)) as CustomApiConfig;
}

function loadPreset(): void {
  const preset = litellmPreset();
  if (draft.value) {
    draft.value = { ...preset, id: draft.value.id, name: draft.value.name };
  }
  showToast(t("dashboard.customApi.presetLoaded"));
}

function backToList(): void {
  editingId.value = null;
  draft.value = null;
}

// Headers / Query 以文本行编辑，保存时解析
const headersText = computed({
  get: () =>
    draft.value
      ? Object.entries(draft.value.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
  set: (v: string) => {
    if (!draft.value) return;
    draft.value.headers = parsePairs(v, ":");
  },
});

const queryText = computed({
  get: () =>
    draft.value
      ? Object.entries(draft.value.query)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  set: (v: string) => {
    if (!draft.value) return;
    draft.value.query = parsePairs(v, "=");
  },
});

function parsePairs(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(sep);
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

async function save(): Promise<void> {
  if (!draft.value) return;
  if (!draft.value.name.trim()) {
    showToast(t("dashboard.customApi.name") + " " + t("dashboard.toast.apiKeyRequired"));
    return;
  }
  if (!draft.value.baseUrl.trim()) {
    showToast(t("dashboard.customApi.baseUrl") + " required");
    return;
  }
  if (!draft.value.fields.balance?.source.trim()) {
    showToast(t("dashboard.customApi.fieldBalance") + " required");
    return;
  }
  await upsertCustomConfig(draft.value);
  showToast(t("dashboard.customApi.saved", { name: draft.value.name }));
  backToList();
  await reload();
}

async function remove(cfg: CustomApiConfig): Promise<void> {
  const providerId = `custom:${cfg.id}`;
  const hasAccounts = accounts.value.some((a) => a.provider_id === providerId);
  if (hasAccounts) {
    showToast(t("dashboard.toast.customApiHasAccounts"));
    return;
  }
  if (!window.confirm(t("dashboard.customApi.deleteConfirm", { name: cfg.name }))) return;
  await deleteCustomConfig(cfg.id);
  showToast(t("dashboard.customApi.deleted", { name: cfg.name }));
  await reload();
}

async function runTest(): Promise<void> {
  if (!draft.value || !testKey.value.trim()) {
    showToast(t("dashboard.toast.apiKeyRequired"));
    return;
  }
  testing.value = true;
  testRaw.value = "";
  testResult.value = "";
  try {
    const { info, raw } = await requestCustomBalance(draft.value, testKey.value.trim());
    testRaw.value = JSON.stringify(raw, null, 2);
    testResult.value = JSON.stringify(info, null, 2);
  } catch (e) {
    testRaw.value = (e as Error).message || String(e);
    testResult.value = "";
  } finally {
    testing.value = false;
  }
}

function setBalanceRule(patch: Partial<FieldRule>): void {
  if (!draft.value) return;
  draft.value.fields.balance = { ...draft.value.fields.balance, ...patch };
}

function setRule(field: "available" | "granted" | "currency", patch: Partial<FieldRule>): void {
  if (!draft.value) return;
  const cur = draft.value.fields[field] ?? { source: "", transform: "none" };
  draft.value.fields[field] = { ...cur, ...patch };
}

onMounted(async () => {
  await reload();
});
</script>

<template>
  <div v-if="props.open" class="modal-mask" @click.self="emit('close')">
    <div class="modal manager">
      <h3>{{ t("dashboard.customApi.title") }}</h3>

      <!-- 列表视图 -->
      <div v-if="!draft" class="list-view">
        <p v-if="configs.length === 0" class="empty-tip">{{ t("dashboard.customApi.empty") }}</p>
        <div v-for="cfg in configs" :key="cfg.id" class="cfg-card">
          <div class="cfg-info">
            <div class="cfg-name">{{ cfg.name }}</div>
            <div class="cfg-sub">{{ cfg.method }} {{ cfg.baseUrl }}{{ cfg.path }}</div>
          </div>
          <div class="cfg-actions">
            <button class="btn small" @click="openEdit(cfg)">{{ t("dashboard.customApi.edit") }}</button>
            <button class="btn small danger" @click="remove(cfg)">{{ t("dashboard.customApi.delete") }}</button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" @click="emit('close')">{{ t("dashboard.cancel") }}</button>
          <button class="btn primary" @click="openNew">{{ t("dashboard.customApi.new") }}</button>
        </div>
      </div>

      <!-- 编辑视图 -->
      <div v-else class="editor">
        <div class="field-grid">
          <label class="field">
            <span>{{ t("dashboard.customApi.name") }}</span>
            <input v-model="draft.name" class="input" :placeholder="t('dashboard.customApi.namePlaceholder')" />
          </label>
          <label class="field">
            <span>{{ t("dashboard.customApi.method") }}</span>
            <select v-model="draft.method" class="input select">
              <option v-for="m in methods" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <label class="field grow">
            <span>{{ t("dashboard.customApi.baseUrl") }}</span>
            <input v-model="draft.baseUrl" class="input" :placeholder="t('dashboard.customApi.baseUrlPlaceholder')" />
          </label>
          <label class="field">
            <span>{{ t("dashboard.customApi.path") }}</span>
            <input v-model="draft.path" class="input" :placeholder="t('dashboard.customApi.pathPlaceholder')" />
          </label>
        </div>

        <label class="check-row">
          <input v-model="draft.bearerAuth" type="checkbox" />
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
          <textarea v-model="draft.body" class="input mono" rows="3" :placeholder="t('dashboard.customApi.bodyHint')"></textarea>
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
            :value="draft.fields.balance?.source ?? ''"
            :placeholder="t('dashboard.customApi.source')"
            @input="setBalanceRule({ source: ($event.target as HTMLInputElement).value })"
          />
          <select
            class="input select"
            :value="draft.fields.balance?.transform ?? 'none'"
            @change="setBalanceRule({ transform: ($event.target as HTMLSelectElement).value as FieldRule['transform'] })"
          >
            <option value="none">{{ t("dashboard.customApi.transformNone") }}</option>
            <option value="subtract">{{ t("dashboard.customApi.transformSubtract") }}</option>
            <option value="divide">{{ t("dashboard.customApi.transformDivide") }}</option>
            <option value="multiply">{{ t("dashboard.customApi.transformMultiply") }}</option>
          </select>
          <input
            v-if="draft.fields.balance?.transform === 'divide' || draft.fields.balance?.transform === 'multiply'"
            class="input num"
            type="number"
            step="any"
            :placeholder="t('dashboard.customApi.operand')"
            :value="draft.fields.balance?.operand ?? ''"
            @input="setBalanceRule({ operand: parseFloat(($event.target as HTMLInputElement).value) || undefined })"
          />
          <input
            v-if="draft.fields.balance?.transform === 'subtract'"
            class="input mono"
            :placeholder="t('dashboard.customApi.operandSource')"
            :value="draft.fields.balance?.operandSource ?? ''"
            @input="setBalanceRule({ operandSource: ($event.target as HTMLInputElement).value })"
          />
        </div>

        <div v-for="f in (['available', 'granted', 'currency'] as const)" :key="f" class="rule-row">
          <span class="rule-label">{{ t(`dashboard.customApi.${f === 'available' ? 'fieldAvailable' : f === 'granted' ? 'fieldGranted' : 'fieldCurrency'}`) }}</span>
          <input
            class="input mono grow"
            :value="draft.fields[f]?.source ?? ''"
            :placeholder="t('dashboard.customApi.source')"
            @input="setRule(f, { source: ($event.target as HTMLInputElement).value })"
          />
          <select
            class="input select"
            :value="draft.fields[f]?.transform ?? 'none'"
            @change="setRule(f, { transform: ($event.target as HTMLSelectElement).value as FieldRule['transform'] })"
          >
            <option value="none">{{ t("dashboard.customApi.transformNone") }}</option>
            <option value="subtract">{{ t("dashboard.customApi.transformSubtract") }}</option>
            <option value="divide">{{ t("dashboard.customApi.transformDivide") }}</option>
            <option value="multiply">{{ t("dashboard.customApi.transformMultiply") }}</option>
          </select>
        </div>

        <div class="test-block">
          <div class="field-sep"><span class="sec-title">{{ t("dashboard.customApi.test") }}</span></div>
          <div class="form-row">
            <input v-model="testKey" class="input key" type="password" :placeholder="t('dashboard.customApi.testKey')" />
            <button class="btn primary" :disabled="testing" @click="runTest">{{ testing ? t("dashboard.adding") : t("dashboard.customApi.testRun") }}</button>
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

        <div class="modal-actions">
          <button class="btn ghost" @click="backToList">{{ t("dashboard.cancel") }}</button>
          <button class="btn primary" @click="save">{{ t("dashboard.customApi.save") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}
.modal {
  background: #161a23;
  border: 1px solid var(--c-border-strong);
  border-radius: 14px;
  padding: 20px;
  width: 720px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 40px);
  overflow-y: auto;
}
.modal h3 {
  margin: 0 0 14px;
}

.empty-tip {
  color: var(--c-text-faint);
  padding: 16px 0;
  text-align: center;
}
.cfg-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
  margin-bottom: 8px;
}
.cfg-info {
  flex: 1;
  min-width: 0;
}
.cfg-name {
  font-weight: 600;
}
.cfg-sub {
  color: var(--c-text-faint);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cfg-actions {
  display: flex;
  gap: 6px;
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
.select {
  width: auto;
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
.hint {
  color: var(--c-text-faint);
  font-size: 12px;
  margin: 0 0 10px;
  line-height: 1.6;
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

.test-block {
  margin-top: 12px;
  border-top: 1px solid var(--c-border);
  padding-top: 12px;
}
.form-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.key {
  flex: 1;
  min-width: 220px;
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
.btn.ghost {
  background: transparent;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>
