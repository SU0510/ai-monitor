<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import {
  listRecentUsage,
  monthlyUsageSummary,
  usageByModel,
  type RecentUsageRow,
  type MonthlyUsageRow,
  type ModelUsageRow,
} from "../core/db";
import { today, fmt, displayCost, showToast } from "../core/dashboardStore";
import { cacheHitRate, fmtRate } from "../core/usageStats";
import UsageHeatmap from "./UsageHeatmap.vue";

const { t } = useI18n();

/** 热力图覆盖的自然月数量（整年 ≈ 53 列，正好铺满加宽后的面板） */
const HEATMAP_MONTHS = 12;

const recentUsage = ref<RecentUsageRow[]>([]);
const monthly = ref<MonthlyUsageRow[]>([]);
const modelRank = ref<ModelUsageRow[]>([]);
const exporting = ref(false);

function fmtTok(n: number): string {
  return n.toLocaleString("zh-CN");
}

/**
 * 缓存命中率文案。没有输入 token 时显示「—」而不是 0.0%：
 * 那两种情况含义完全不同（一个是「全部未命中」，一个是「没有数据」）。
 * input_tokens 已包含缓存读取，所以分母直接用它。
 */
function rateText(inputTokens: number, cacheHitTokens: number): string {
  return inputTokens > 0 ? fmtRate(cacheHitRate(inputTokens, cacheHitTokens)) : "—";
}

/** 来源标签：manual=手动记账，proxy=本地代理，balance=余额差值，gateway=网关同步 */
function sourceLabel(source: string): string {
  const key =
    source === "manual"
      ? "manual"
      : source === "balance"
        ? "balance"
        : source === "gateway"
          ? "gateway"
          : "proxy";
  return t(`dashboard.${key}`);
}

function isCurrentMonth(month: string): boolean {
  const d = new Date();
  const cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return month === cur;
}

async function loadUsage(): Promise<void> {
  recentUsage.value = await listRecentUsage(7);
  monthly.value = await monthlyUsageSummary(6);
  modelRank.value = await usageByModel(30, 10);
}

function exportCsv(): void {
  void (async () => {
    if (exporting.value) return;
    exporting.value = true;
    try {
      const rows = await listRecentUsage(90);
      const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
      const lines = [
        [
          "date",
          "account",
          "input_tokens",
          "output_tokens",
          "cache_hit_tokens",
          "cache_hit_rate",
          "cost",
          "source",
        ].join(","),
        ...rows.map(
          (r) =>
            `${esc(r.date)},${esc(r.account_name)},${r.input_tokens},${r.output_tokens},${r.cache_hit_tokens},${cacheHitRate(r.input_tokens, r.cache_hit_tokens).toFixed(4)},${r.cost},${esc(r.source)}`
        ),
      ];
      const path = await invoke<string>("export_usage_csv", { csv: lines.join("\n") });
      showToast(t("dashboard.toast.exportOk", { path }));
    } catch (e) {
      showToast(t("dashboard.toast.exportFail", { err: (e as Error).message || String(e) }));
    } finally {
      exporting.value = false;
    }
  })();
}

onMounted(loadUsage);
</script>

<template>
  <div>
    <div class="panel">
      <div class="panel-head">
        <h3>{{ t("dashboard.todayUsage") }}</h3>
        <button class="btn" :disabled="exporting" @click="exportCsv">
          {{ t("dashboard.exportCsv") }}
        </button>
      </div>
      <div class="usage-grid">
        <div class="usage-item" :title="t('dashboard.inputTokensInclCache')">
          <div class="usage-label">{{ t("dashboard.inputTokens") }}</div>
          <div class="usage-value">{{ fmtTok(today.input_tokens) }}</div>
        </div>
        <div class="usage-item">
          <div class="usage-label">{{ t("dashboard.outputTokens") }}</div>
          <div class="usage-value">{{ fmtTok(today.output_tokens) }}</div>
        </div>
        <div class="usage-item" :title="t('dashboard.inputTokensInclCache')">
          <div class="usage-label">{{ t("dashboard.cacheHit") }}</div>
          <div class="usage-value">{{ fmtTok(today.cache_hit_tokens) }}</div>
        </div>
        <div class="usage-item">
          <div class="usage-label">{{ t("dashboard.cacheHitRate") }}</div>
          <div class="usage-value">
            {{ rateText(today.input_tokens, today.cache_hit_tokens) }}
          </div>
        </div>
        <div class="usage-item">
          <div class="usage-label">{{ t("dashboard.estimatedCost") }}</div>
          <div class="usage-value">¥{{ fmt(displayCost(today.cost, today.cost_estimated)) }}</div>
        </div>
      </div>
      <p class="hint">{{ t("dashboard.usageAuto") }}</p>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.heatmapTitle", { months: HEATMAP_MONTHS }) }}</h3>
      <UsageHeatmap :months="HEATMAP_MONTHS" />
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.monthlyTitle") }}</h3>
      <div v-if="monthly.length === 0" class="empty-tip">{{ t("dashboard.noUsage") }}</div>
      <div v-else class="monthly-grid">
        <div
          v-for="m in monthly"
          :key="m.month"
          class="month-card"
          :class="{ current: isCurrentMonth(m.month) }"
        >
          <div class="month-name">{{ m.month }}</div>
          <div class="month-cost">¥{{ fmt(displayCost(m.cost, m.cost_estimated)) }}</div>
          <div class="month-meta">
            {{ fmtTok(m.input_tokens + m.output_tokens) }} {{ t("dashboard.monthlyTokens") }} ·
            {{ m.days }}
            {{ t("dashboard.monthlyDays") }}
          </div>
          <div class="month-meta">
            {{ t("dashboard.cacheHit") }} {{ fmtTok(m.cache_hit_tokens) }} ·
            {{ rateText(m.input_tokens, m.cache_hit_tokens) }}
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.modelRankTitle") }}</h3>
      <div v-if="modelRank.length === 0" class="empty-tip">{{ t("dashboard.noUsage") }}</div>
      <table v-else class="usage-table">
        <thead>
          <tr>
            <th>{{ t("dashboard.model") }}</th>
            <th>{{ t("dashboard.estimatedCost") }}</th>
            <th>{{ t("dashboard.input") }}</th>
            <th>{{ t("dashboard.output") }}</th>
            <th>{{ t("dashboard.calls") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in modelRank" :key="m.model">
            <td>{{ m.model }}</td>
            <td>¥{{ fmt(m.cost_estimated) }}</td>
            <td>{{ fmtTok(m.input_tokens) }}</td>
            <td>{{ fmtTok(m.output_tokens) }}</td>
            <td>{{ fmtTok(m.calls) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h3>{{ t("dashboard.recent7") }}</h3>
      <div v-if="recentUsage.length === 0" class="empty-tip">{{ t("dashboard.noUsage") }}</div>
      <table v-else class="usage-table">
        <thead>
          <tr>
            <th>{{ t("dashboard.date") }}</th>
            <th>{{ t("dashboard.account") }}</th>
            <th>{{ t("dashboard.input") }}</th>
            <th>{{ t("dashboard.output") }}</th>
            <th>{{ t("dashboard.cacheHit") }}</th>
            <th>{{ t("dashboard.cacheHitRate") }}</th>
            <th>{{ t("dashboard.cost") }}</th>
            <th>{{ t("dashboard.source") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in recentUsage" :key="u.id">
            <td>{{ u.date }}</td>
            <td>{{ u.account_name }}</td>
            <td>{{ fmtTok(u.input_tokens) }}</td>
            <td>{{ fmtTok(u.output_tokens) }}</td>
            <td>{{ fmtTok(u.cache_hit_tokens) }}</td>
            <td>{{ rateText(u.input_tokens, u.cache_hit_tokens) }}</td>
            <td>¥{{ fmt(u.cost) }}</td>
            <td>{{ sourceLabel(u.source) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.panel {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius);
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
  margin-bottom: 12px;
}
.panel-head h3 {
  margin: 0;
}
.btn {
  background: var(--c-border-strong);
  border: 1px solid var(--c-border-strong);
  color: var(--c-text);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.monthly-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.month-card {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 12px;
}
.month-card.current {
  border-color: var(--c-accent-strong);
}
.month-name {
  color: var(--c-text-dim);
  font-size: 12px;
  margin-bottom: 6px;
}
.month-cost {
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--c-text);
}
.month-meta {
  color: var(--c-text-faint);
  font-size: 11px;
  margin-top: 4px;
}

.usage-grid {
  /* 卡片数量会变（输入/输出/缓存命中/命中率/费用），交给 auto-fit 自己铺 */
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.usage-item {
  background: var(--c-panel);
  border-radius: 10px;
  padding: 14px;
}
.usage-label {
  color: var(--c-text-dim);
  font-size: 12px;
  margin-bottom: 6px;
}
.usage-value {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--c-text);
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

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  color: var(--c-text);
}
.usage-table th,
.usage-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--c-border);
  font-variant-numeric: tabular-nums;
}
.usage-table th {
  color: var(--c-text-dim);
  font-weight: 500;
  font-size: 12px;
}
.usage-table tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}
</style>
