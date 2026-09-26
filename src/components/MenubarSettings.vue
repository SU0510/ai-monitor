<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { accounts } from "../core/dashboardStore";
import { menubarConfig, renderMenubarNow, saveMenubarConfigStore } from "../core/menubarStore";
import type { MenubarMetric, MenubarSlot } from "../core/menubar";

const { t } = useI18n();

const cfg = menubarConfig;

/** 与推给托盘的是同一个渲染函数，预览不会与真实菜单栏不一致 */
const preview = computed(() => renderMenubarNow());

/** 提示里去掉定宽补齐用的不换行空格，否则每帧后面拖一串空白 */
const frameList = computed(() => preview.value.titles.map((t) => t.replace(/\u00a0+$/, "")));

const METRICS: MenubarMetric[] = ["balance", "todayCost", "tokens", "quota"];
const SEPARATORS = ["·", "|", "/", "•"];

function metricLabel(m: MenubarMetric): string {
  return t(`dashboard.menubar.metric_${m}`);
}

function accountName(id: number | undefined): string {
  return accounts.value.find((a) => a.id === id)?.name ?? t("dashboard.menubar.accountGone");
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved = "";

/**
 * 防抖保存。归一化会把配置替换成新对象，从而再次触发 watch，
 * 所以用序列化结果做去重，避免「保存 -> 触发 -> 再保存」自我循环。
 */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const json = JSON.stringify(cfg.value);
    if (json === lastSaved) return;
    lastSaved = json;
    await saveMenubarConfigStore(cfg.value);
    lastSaved = JSON.stringify(cfg.value);
  }, 350);
}

watch(cfg, scheduleSave, { deep: true });

let slotSeq = 0;
function newSlot(kind: MenubarSlot["kind"]): MenubarSlot {
  slotSeq++;
  const id = `${kind}-${Date.now().toString(36)}-${slotSeq}`;
  if (kind === "aggregate") return { id, kind, metric: "balance" };
  return {
    id,
    kind,
    metric: "balance",
    accountId: accounts.value[0]?.id,
  };
}

function addSlot(kind: MenubarSlot["kind"]): void {
  if (cfg.value.slots.length >= 12) return;
  cfg.value.slots.push(newSlot(kind));
}

function removeSlot(index: number): void {
  cfg.value.slots.splice(index, 1);
}

function moveSlot(index: number, delta: number): void {
  const to = index + delta;
  const slots = cfg.value.slots;
  if (to < 0 || to >= slots.length) return;
  const [item] = slots.splice(index, 1);
  slots.splice(to, 0, item);
}

/** 指定 key 的槽位在账户被删除后无法渲染，这里提示并允许移除 */
function slotBroken(slot: MenubarSlot): boolean {
  return slot.kind === "account" && !accounts.value.some((a) => a.id === slot.accountId);
}

/** 极简模式是「图标 + 几个数字」，所以打开时把图标也一并打开 */
function onMinimalChange(on: boolean): void {
  if (on) cfg.value.showIcon = true;
}
</script>

<template>
  <div class="panel">
    <h3>{{ t("dashboard.menubar.title") }}</h3>

    <div class="form-row">
      <span class="form-label">{{ t("dashboard.menubar.showTitle") }}</span>
      <label class="switch">
        <input v-model="cfg.showTitle" type="checkbox" />
        <span class="slider"></span>
      </label>
      <span class="form-label">{{ t("dashboard.menubar.showIcon") }}</span>
      <label class="switch">
        <input v-model="cfg.showIcon" type="checkbox" />
        <span class="slider"></span>
      </label>
    </div>

    <div class="form-row">
      <span class="form-label">{{ t("dashboard.menubar.minimal") }}</span>
      <label class="switch">
        <input v-model="cfg.minimal" type="checkbox" @change="onMinimalChange(cfg.minimal)" />
        <span class="slider"></span>
      </label>
      <template v-if="cfg.minimal">
        <span class="form-label">{{ t("dashboard.menubar.minimalSymbol") }}</span>
        <label class="switch">
          <input v-model="cfg.minimalSymbol" type="checkbox" />
          <span class="slider"></span>
        </label>
      </template>
    </div>
    <p v-if="cfg.minimal" class="hint">{{ t("dashboard.menubar.minimalHint") }}</p>

    <div v-if="!cfg.minimal" class="form-row">
      <span class="form-label">{{ t("dashboard.menubar.titleMode") }}</span>
      <select v-model="cfg.titleMode" class="input select">
        <option value="segments">{{ t("dashboard.menubar.modeSegments") }}</option>
        <option value="rotate">{{ t("dashboard.menubar.modeRotate") }}</option>
      </select>
      <template v-if="cfg.titleMode === 'rotate'">
        <span class="form-label">{{ t("dashboard.menubar.rotateSecs") }}</span>
        <input v-model.number="cfg.rotateSecs" class="input num" type="number" min="2" max="600" />
      </template>
      <template v-else>
        <span class="form-label">{{ t("dashboard.menubar.maxSegments") }}</span>
        <input v-model.number="cfg.maxSegments" class="input num" type="number" min="1" max="12" />
      </template>
    </div>

    <div class="form-row">
      <span class="form-label">{{ t("dashboard.menubar.separator") }}</span>
      <select v-model="cfg.separator" class="input select">
        <option v-for="s in SEPARATORS" :key="s" :value="s">{{ s }}</option>
      </select>
      <span class="form-label">{{ t("dashboard.menubar.menuAccounts") }}</span>
      <label class="switch">
        <input v-model="cfg.menuAccounts" type="checkbox" />
        <span class="slider"></span>
      </label>
    </div>
    <p v-if="cfg.menuAccounts" class="hint">{{ t("dashboard.menubar.menuAccountsHint") }}</p>

    <div v-if="!cfg.minimal && cfg.titleMode === 'rotate'" class="form-row">
      <span class="form-label">{{ t("dashboard.menubar.rotateFixedWidth") }}</span>
      <label class="switch">
        <input v-model="cfg.rotateFixedWidth" type="checkbox" />
        <span class="slider"></span>
      </label>
    </div>
    <p v-if="!cfg.minimal && cfg.titleMode === 'rotate'" class="hint">
      {{ t("dashboard.menubar.rotateFixedWidthHint") }}
    </p>

    <!-- 实时预览：与真实菜单栏同一个渲染器 -->
    <div class="preview">
      <span class="pv-icon">◉</span>
      <span class="pv-text">{{ preview.titles.length > 0 ? preview.titles[0] : "—" }}</span>
    </div>
    <p v-if="cfg.titleMode === 'rotate' && preview.titles.length > 1" class="hint">
      {{
        t("dashboard.menubar.rotateFrames", {
          n: preview.titles.length,
          list: frameList.join("  →  "),
        })
      }}
    </p>

    <div v-if="preview.menu.length > 0" class="menu-preview">
      <div v-for="item in preview.menu" :key="item.id" class="mp-row">{{ item.label }}</div>
    </div>

    <p class="hint">{{ t("dashboard.menubar.previewHint") }}</p>

    <!-- 组件列表：勾选/排序决定显示哪几个组件 -->
    <div class="slot-head">{{ t("dashboard.menubar.slots") }}</div>
    <div v-for="(slot, i) in cfg.slots" :key="slot.id" class="slot-row">
      <span class="slot-idx">{{ i + 1 }}</span>
      <select v-model="slot.metric" class="input select narrow">
        <option v-for="m in METRICS" :key="m" :value="m">{{ metricLabel(m) }}</option>
      </select>
      <select
        v-if="slot.kind === 'account'"
        v-model.number="slot.accountId"
        class="input select"
        :class="{ broken: slotBroken(slot) }"
      >
        <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        <option v-if="slotBroken(slot)" :value="slot.accountId">
          {{ accountName(slot.accountId) }}
        </option>
      </select>
      <input
        v-model="slot.label"
        class="input"
        :placeholder="t('dashboard.menubar.labelPlaceholder')"
      />
      <label class="compact">
        <input v-model="slot.compact" type="checkbox" />
        {{ t("dashboard.menubar.compact") }}
      </label>
      <button class="btn tiny" :title="t('dashboard.menubar.moveUp')" @click="moveSlot(i, -1)">
        ↑
      </button>
      <button class="btn tiny" :title="t('dashboard.menubar.moveDown')" @click="moveSlot(i, 1)">
        ↓
      </button>
      <button class="btn tiny danger" :title="t('dashboard.menubar.remove')" @click="removeSlot(i)">
        ✕
      </button>
    </div>

    <div class="form-row">
      <button class="btn" @click="addSlot('aggregate')">
        {{ t("dashboard.menubar.addAggregate") }}
      </button>
      <button class="btn" :disabled="accounts.length === 0" @click="addSlot('account')">
        {{ t("dashboard.menubar.addAccount") }}
      </button>
      <span class="hint-inline">{{ t("dashboard.menubar.addAccountHint") }}</span>
    </div>
  </div>
</template>

<style scoped>
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

.form-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.form-label {
  min-width: 110px;
  color: var(--c-text-dim);
  font-size: 13px;
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
.input.num {
  width: 90px;
}
.select {
  width: 180px;
}
.select.narrow {
  width: 130px;
}
.select.broken {
  border-color: #f87171;
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
.btn.tiny {
  padding: 6px 9px;
  font-size: 12px;
}
.btn.danger {
  color: #f87171;
}

.hint {
  color: var(--c-text-faint);
  font-size: 12px;
  margin: 6px 0 0;
  line-height: 1.7;
}
.hint-inline {
  color: var(--c-text-faint);
  font-size: 12px;
  margin-left: 8px;
}

/* 预览条：尽量贴近 macOS 菜单栏观感 */
.preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 4px;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--c-border-strong);
  font-variant-numeric: tabular-nums;
  max-width: 100%;
  overflow: hidden;
}
.pv-icon {
  color: var(--c-text-dim);
  font-size: 12px;
}
.pv-text {
  color: var(--c-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-preview {
  margin: 8px 0 0;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  overflow: hidden;
  max-width: 320px;
}
.mp-row {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--c-text-dim);
  border-bottom: 1px solid var(--c-border);
  font-variant-numeric: tabular-nums;
}
.mp-row:last-child {
  border-bottom: none;
}

.slot-head {
  margin: 16px 0 8px;
  font-size: 13px;
  color: var(--c-text-dim);
}
.slot-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.slot-idx {
  width: 18px;
  color: var(--c-text-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.slot-row .input {
  flex: 1;
  min-width: 120px;
}
.slot-row .select {
  flex: 0 0 auto;
}
.compact {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--c-text-faint);
  font-size: 12px;
  white-space: nowrap;
}

.switch {
  position: relative;
  display: inline-block;
  width: 42px;
  height: 24px;
  cursor: pointer;
  flex: 0 0 auto;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 24px;
  transition: background 0.2s;
}
.slider::before {
  content: "";
  position: absolute;
  width: 18px;
  height: 18px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.switch input:checked + .slider {
  background: var(--c-accent);
}
.switch input:checked + .slider::before {
  transform: translateX(18px);
}
</style>
