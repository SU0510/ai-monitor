<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { dailyTotals, initDb } from "../core/db";
import { displayCost, fmt } from "../core/dashboardStore";
import { buildHeatmapCells, monthLabels, weekdayLabels } from "../core/heatmap";

const props = withDefaults(defineProps<{ months?: number }>(), { months: 6 });

const { t, locale } = useI18n();

const wrapEl = ref<HTMLDivElement | null>(null);
/** date -> 当天合计。深浅用「当天消耗」而不是 token：
 *  余额差值记账（source=balance）只写金额、token 恒为 0，按 token 上色会整张图全空。 */
const totals = ref<Map<string, { tokens: number; cost: number; costEstimated: number }>>(new Map());

/** 当天的度量值：费用优先用权威值 cost，没有则回退估算值 */
function spendOf(v?: { cost: number; costEstimated: number }): number {
  return v ? displayCost(v.cost, v.costEstimated) : 0;
}

const cells = computed(() =>
  buildHeatmapCells(
    new Map([...totals.value].map(([date, v]) => [date, spendOf(v)])),
    props.months,
    new Date()
  )
);

const labels = computed(() => monthLabels(cells.value, locale.value));
const weekdays = computed(() => weekdayLabels(locale.value));

const dateFmt = computed(
  () => new Intl.DateTimeFormat(locale.value, { year: "numeric", month: "long", day: "numeric" })
);

const tip = ref<{
  x: number;
  y: number;
  below: boolean;
  cell: (typeof cells.value)[number];
} | null>(null);

function tipCost(date: string): string {
  return fmt(spendOf(totals.value.get(date)));
}

function tipTokens(date: string): string {
  return (totals.value.get(date)?.tokens ?? 0).toLocaleString("zh-CN");
}

function onEnter(e: MouseEvent, cell: (typeof cells.value)[number], index: number): void {
  const host = wrapEl.value;
  const target = e.currentTarget as HTMLElement | null;
  if (!host || !target) return;
  const hr = host.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  // 贴边时把气泡拉回来，否则最左/最右两列的气泡会溢出面板
  const x = Math.min(Math.max(tr.left - hr.left + tr.width / 2, 56), hr.width - 56);
  // 顶上两行的气泡若往上放会盖住面板标题（表格上方就是标题），所以这两行改成往下方
  const below = index % 7 < 3;
  tip.value = { x, y: below ? tr.bottom - hr.top : tr.top - hr.top, below, cell };
}

function tipDate(date: string): string {
  return dateFmt.value.format(new Date(`${date}T00:00:00`));
}

async function load(): Promise<void> {
  const rows = await dailyTotals(props.months);
  const m = new Map<string, { tokens: number; cost: number; costEstimated: number }>();
  for (const r of rows) {
    m.set(r.date, { tokens: r.tokens, cost: r.cost, costEstimated: r.cost_estimated });
  }
  totals.value = m;
}

onMounted(async () => {
  try {
    await initDb();
    await load();
  } catch (e) {
    console.error("热力图数据加载失败", e);
  }
});
</script>

<template>
  <div ref="wrapEl" class="heatmap">
    <div class="hm-scroll">
      <div class="hm-grid">
        <!-- 月份行：右侧与格子区共用同一套列宽/列距，所以两个 grid 的列天然对齐 -->
        <div class="hm-corner"></div>
        <div class="hm-months">
          <div v-for="(m, i) in labels" :key="i" class="hm-month">{{ m }}</div>
        </div>

        <!-- 星期标签：7 个槽位（只填周一/三/五），行高与格子一致 -->
        <div class="hm-days">
          <div v-for="(w, i) in weekdays" :key="i" class="hm-day-label">{{ w }}</div>
        </div>
        <div class="hm-cells">
          <div
            v-for="(c, i) in cells"
            :key="c.date"
            class="hm-cell"
            :class="`lv${c.level}`"
            @mouseenter="onEnter($event, c, i)"
            @mouseleave="tip = null"
          />
        </div>
      </div>
    </div>

    <div class="hm-foot">
      <span class="hm-hint">{{ t("dashboard.heatmapHint", { months }) }}</span>
      <div class="hm-legend">
        <span>{{ t("dashboard.heatmapLess") }}</span>
        <span class="hm-cell lv0" />
        <span class="hm-cell lv1" />
        <span class="hm-cell lv2" />
        <span class="hm-cell lv3" />
        <span class="hm-cell lv4" />
        <span>{{ t("dashboard.heatmapMore") }}</span>
      </div>
    </div>

    <div
      v-if="tip"
      class="hm-tip"
      :class="{ below: tip.below }"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
      role="tooltip"
    >
      <div class="hm-tip-date">{{ tipDate(tip.cell.date) }}</div>
      <div class="hm-tip-row">
        <span>{{ t("dashboard.cost") }}</span>
        <b>¥{{ tipCost(tip.cell.date) }}</b>
      </div>
      <!-- token 只在真的有记录时才显示：余额差值记账的日期 token 恒为 0，显示出来只会让人误以为漏记 -->
      <div v-if="totals.get(tip.cell.date)?.tokens" class="hm-tip-row">
        <span>{{ t("dashboard.heatmapTokens") }}</span>
        <b>{{ tipTokens(tip.cell.date) }}</b>
      </div>
    </div>
  </div>
</template>

<style scoped>
.heatmap {
  position: relative;
  --hm-cell: 15px;
  --hm-gap: 4px;
  /* 空格子：GitHub 亮色主题下是白色，这里是深色主题，用一层很淡的中性底代替，
     纯白在 #0f1117 上会亮得压过绿色本身 */
  --hm-c0: rgba(255, 255, 255, 0.055);
  --hm-c1: #0d4032;
  --hm-c2: #14684c;
  --hm-c3: #1d9a6c;
  --hm-c4: #34d399;
}
.hm-scroll {
  overflow-x: auto;
  padding-bottom: 2px;
}
.hm-grid {
  display: grid;
  grid-template-columns: auto auto;
  gap: var(--hm-gap) 5px; /* 行距与格子一致；列距是左侧标签到格子的留白 */
  width: max-content;
}
.hm-corner {
  height: 16px;
}
.hm-months {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: 16px;
  grid-auto-columns: var(--hm-cell);
  gap: var(--hm-gap);
}
.hm-month {
  font-size: 10px;
  line-height: 16px;
  color: var(--c-text-faint);
  white-space: nowrap;
}
.hm-days {
  display: flex;
  flex-direction: column;
  gap: var(--hm-gap);
}
.hm-day-label {
  height: var(--hm-cell);
  font-size: 10px;
  line-height: var(--hm-cell);
  color: var(--c-text-faint);
  text-align: right;
  white-space: nowrap;
}
.hm-cells {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(7, var(--hm-cell));
  grid-auto-columns: var(--hm-cell);
  gap: var(--hm-gap);
}
.hm-cell {
  width: var(--hm-cell);
  height: var(--hm-cell);
  border-radius: 3px;
  background: var(--hm-c0);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  transition: box-shadow 0.12s ease;
}
.hm-cell.lv0 {
  background: var(--hm-c0);
}
.hm-cell.lv1 {
  background: var(--hm-c1);
}
.hm-cell.lv2 {
  background: var(--hm-c2);
}
.hm-cell.lv3 {
  background: var(--hm-c3);
}
.hm-cell.lv4 {
  background: var(--hm-c4);
}
.hm-cells .hm-cell:hover {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.55);
}

.hm-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.hm-hint {
  font-size: 11px;
  color: var(--c-text-faint);
}
.hm-legend {
  display: flex;
  align-items: center;
  gap: var(--hm-gap);
  font-size: 10px;
  color: var(--c-text-faint);
  flex-shrink: 0;
}
.hm-legend .hm-cell {
  cursor: default;
}

.hm-tip {
  position: absolute;
  transform: translate(-50%, calc(-100% - 6px));
  background: rgba(23, 26, 36, 0.97);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  padding: 7px 10px;
  font-size: 11px;
  color: var(--c-text);
  pointer-events: none;
  white-space: nowrap;
  z-index: 5;
}
/* 顶部几行改成往下展开，否则会盖住面板标题 */
.hm-tip.below {
  transform: translate(-50%, 6px);
}
.hm-tip-date {
  color: var(--c-text-dim);
  margin-bottom: 3px;
}
.hm-tip-row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  font-variant-numeric: tabular-nums;
}
.hm-tip-row span {
  color: var(--c-text-dim);
}
</style>
