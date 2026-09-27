<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, cursorPosition } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getSetting, setSetting } from "../core/db";
import {
  ensureData,
  loadData as storeLoadData,
  refreshAll as storeRefreshAll,
  accounts,
  balances,
  quotas,
  today,
  todayByAccount,
  collecting,
  totalBalance,
  lastErrors,
  fmt,
  displayCost,
  EVENT_REFRESH_ALL_REQUESTED,
} from "../core/dashboardStore";
import { primaryQuota, quotaView, type QuotaView } from "../core/quota";
import { cacheHitRate, fmtRate } from "../core/usageStats";
import {
  loadMenubarConfigStore,
  pushMenubar,
  EVENT_MENUBAR_PUSH_REQUESTED,
} from "../core/menubarStore";
import { startAutoCollect, EVENT_BALANCE_UPDATED } from "../core/collector";
import { i18n } from "../i18n";

const win = getCurrentWindow();
const { t } = useI18n();
const isZh = () => i18n.global.locale.value === "zh";

/** Rust 侧（tray.rs）同步「岛该不该渲染」的事件名 */
const EVENT_OVERLAY_ENABLED_CHANGED = "overlay-enabled-changed";

// 灵动岛三态尺寸（逻辑像素）
const CAPSULE_W = 320;
const CAPSULE_H = 64;
const EXPANDED_H = 262;
const EDGE_W = 32; // 边缘半圆窗口宽（完全在屏幕内，贴边凸出半圆）
const EDGE_H = 64;
const TOP_Y = 48; // 顶部居中的 Y

type Mode = "capsule" | "expanded" | "edge";

const lastUpdated = ref("");
/** 最近一次「整体采集失败」的时间（HH:MM），无失败为空串 */
const lastCollectFailedAt = ref("");
const lowThreshold = ref(20);

const lowBalance = computed(() => totalBalance.value <= lowThreshold.value);

/**
 * 岛是否渲染。关掉时窗口仍在（它承载采集与托盘推送的定时器），
 * 只是不画任何东西——窗口本来就是透明的，于是视觉上等同不存在。
 * 状态由 Rust 侧统一同步（EVENT_OVERLAY_ENABLED_CHANGED）。
 */
const islandOn = ref(true);

// 状态
const mode = ref<Mode>("capsule");
const edgeSide = ref<"left" | "right" | null>(null);
const animating = ref(false);
let suppressSnapUntil = 0;

let unlistenEvent: UnlistenFn | null = null;
let unlistenUsage: UnlistenFn | null = null;
let unlistenMenubar: UnlistenFn | null = null;
let unlistenRefresh: UnlistenFn | null = null;
let unlistenIsland: UnlistenFn | null = null;
let unlistenMove: UnlistenFn | null = null;
let unlistenFocus: UnlistenFn | null = null;
let moveTimer: number | null = null;
let uiTimer: ReturnType<typeof setInterval> | null = null;
let cursorTimer: ReturnType<typeof setInterval> | null = null;
let hoverTimer: number | null = null;
let dragging = false; // 正在拖动：抑制 hover 展开（让胶囊可拖）
// 本次按下列真有实际移动（onMoved 只在窗口真的移动时才触发）。用来区分「点一下」
// 和「拖了一段又松手」：只有后者才需要在松手时补一次贴边判断。
let draggedThisPress = false;

function compactTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

/**
 * 缓存命中率的紧凑文案。没有输入 token 时给「—」：那台机器可能只是没同步到 token
 * （余额差值记账的账户就是这样），显示 0% 会被误读成「全都没命中」。
 * input 已包含缓存读取，所以分母直接用 input。
 */
function rateText(inputTokens: number, cacheHitTokens: number): string {
  return inputTokens > 0 ? fmtRate(cacheHitRate(inputTokens, cacheHitTokens)) : "—";
}

/** 悬浮窗里 token 一律压缩显示，tooltip 里给完整数字用 */
function fmtTokFull(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 某账户的窗口额度展示数据（无额度返回 null） */
function accQuota(accId: number): QuotaView | null {
  return quotaView(primaryQuota(quotas.value[accId]), balances.value[accId]?.currency ?? "USD");
}

/** 灵动岛内的限额明细文案：剩余额度（或已超限）+ 重置倒计时 */
function quotaDetail(q: QuotaView): string {
  const parts = [q.over ? t("overlay.quotaOver") : t("overlay.quotaLeft", { amount: q.left })];
  if (q.reset) parts.push(t("overlay.quotaReset", { time: q.reset }));
  return parts.join(" · ");
}

/** 展开抽屉的账户行数据（含所属账户的 3 小时限额），一次算好供模板直接取用 */
const overlayAccounts = computed(() =>
  accounts.value.map((acc) => {
    const quota = accQuota(acc.id);
    const u = todayByAccount.value[acc.id];
    const inputTok = u?.input_tokens ?? 0;
    const cacheTok = u?.cache_hit_tokens ?? 0;
    return {
      id: acc.id,
      name: acc.name,
      balance: balances.value[acc.id]?.balance ?? null,
      todayCost: displayCost(u?.cost ?? 0, u?.cost_estimated ?? 0),
      tokens: inputTok + (u?.output_tokens ?? 0),
      cacheTok,
      cacheRate: rateText(inputTok, cacheTok),
      quota: quota ? { ...quota, detail: quotaDetail(quota) } : null,
    };
  })
);

function todayLabel(): string {
  const d = new Date();
  const loc = isZh() ? "zh-CN" : "en-US";
  return d.toLocaleDateString(loc, { month: "long", day: "numeric" });
}

function statusColor(balance: number): string {
  if (balance <= lowThreshold.value) return "#f87171";
  if (balance <= lowThreshold.value * 3) return "#fbbf24";
  return "#34d399";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 窗口几何 ----------

async function getLogicalMetrics(): Promise<{
  scale: number;
  screenW: number;
  screenH: number;
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  const monitor = await currentMonitor();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  const scale = monitor?.scaleFactor ?? 1;
  return {
    scale,
    screenW: (monitor?.size.width ?? 1440) / scale,
    screenH: (monitor?.size.height ?? 900) / scale,
    x: pos.x / scale,
    y: pos.y / scale,
    w: size.width / scale,
    h: size.height / scale,
  };
}

/** 当前显示器对应的位置存储键（多显示器分别记忆，名字缺失时退回默认） */
async function posSettingKey(): Promise<string> {
  const mon = await currentMonitor();
  return `overlay_pos_${mon?.name ?? "default"}`;
}

/**
 * 光标位置轮询：鼠标进窗口就展开、移走就收回（比 CSS hover 可靠）。
 * 只在岛渲染时开启——岛关着的时候没有任何东西需要响应鼠标，而窗口本身仍在跑，
 * 200ms 一次的轮询会白白把主进程的空闲占用顶上去，所以关岛即停。
 */
function startCursorWatch(): void {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    void (async () => {
      if (animating.value || !islandOn.value) return;
      const visible = await win.isVisible().catch(() => false);
      if (!visible) return;
      let inside = false;
      try {
        const cur = await cursorPosition();
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        inside =
          cur.x >= pos.x &&
          cur.x <= pos.x + size.width &&
          cur.y >= pos.y &&
          cur.y <= pos.y + size.height;
      } catch {
        return;
      }
      if (inside && !dragging) {
        if (mode.value === "capsule") void expand();
        else if (mode.value === "edge") void expandFromEdge();
      } else if (!inside) {
        if (mode.value === "expanded") void collapseToCapsule();
      }
    })();
  }, 200);
}

function stopCursorWatch(): void {
  if (!cursorTimer) return;
  window.clearInterval(cursorTimer);
  cursorTimer = null;
}

async function savePos(): Promise<void> {
  const m = await getLogicalMetrics();
  const x = Math.max(0, Math.min(m.x, Math.max(0, m.screenW - m.w)));
  const y = Math.max(0, Math.min(m.y, Math.max(0, m.screenH - m.h)));
  await setSetting(await posSettingKey(), JSON.stringify({ x, y }));
  await setSetting("overlay_mode", mode.value);
}

/** 窗口尺寸/位置分步动画（easeOutCubic） */
async function animateSize(
  fromW: number,
  toW: number,
  fromH: number,
  toH: number,
  fromX: number,
  toX: number,
  fromY: number,
  toY: number,
  duration = 300
): Promise<void> {
  const steps = Math.max(6, Math.floor(duration / 30));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    const w = Math.round(fromW + (toW - fromW) * ease);
    const h = Math.round(fromH + (toH - fromH) * ease);
    const x = Math.round(fromX + (toX - fromX) * ease);
    const y = Math.round(fromY + (toY - fromY) * ease);
    await win.setSize(new LogicalSize(w, h));
    await win.setPosition(new LogicalPosition(x, y));
    await sleep(30);
  }
}

/** 移动到顶部居中 */
async function centerTop(): Promise<void> {
  const m = await getLogicalMetrics();
  const x = Math.max(0, Math.round((m.screenW - CAPSULE_W) / 2));
  await win.setPosition(new LogicalPosition(x, TOP_Y));
  await savePos();
}

// ---------- 状态切换（抽屉式） ----------

/**
 * 动画的统一入口：进入时置 animating，结束时无论成败都复位。
 *
 * 这几处原本各自写 `animating = true` … `animating = false`，中间任何一次
 * setSize/setPosition 抛错（窗口被系统抢走焦点、显示器热插拔等）就会把 animating
 * 永久留在 true —— 此后 hover、光标轮询、贴边判断全部直接 return，岛彻底卡死，
 * 只能重启应用。所以必须 try/finally。
 *
 * suppressSnapUntil 也移到动画结束之后再设：窗口移动动画自己会触发 onMoved，
 * 若在动画开始前就设，动画期间的事件会把抑制窗口不断往后推（甚至在动画结束后
 * 才到期），反而让「动画刚结束就误判贴边」更容易发生。
 */
async function runAnimation(fn: () => Promise<void>): Promise<void> {
  if (animating.value) return;
  animating.value = true;
  try {
    await fn();
    suppressSnapUntil = Date.now() + 800;
    await savePos();
  } catch (e) {
    console.error("悬浮窗动画失败", e);
  } finally {
    animating.value = false;
  }
}

/** 胶囊 -> 展开卡片（窗口向下延伸，抽屉下拉） */
async function expand(): Promise<void> {
  if (animating.value || mode.value === "expanded") return;
  await runAnimation(async () => {
    const m = await getLogicalMetrics();
    await animateSize(m.w, CAPSULE_W, m.h, EXPANDED_H, m.x, m.x, m.y, m.y);
    mode.value = "expanded";
  });
}

/** 卡片 -> 收回胶囊（抽屉收起） */
async function collapseToCapsule(): Promise<void> {
  if (animating.value || mode.value !== "expanded") return;
  await runAnimation(async () => {
    const m = await getLogicalMetrics();
    await animateSize(m.w, CAPSULE_W, m.h, CAPSULE_H, m.x, m.x, m.y, m.y);
    mode.value = "capsule";
  });
}

/** 贴边 -> 小半圆 */
async function collapseToEdge(target: "left" | "right"): Promise<void> {
  if (animating.value || mode.value === "edge") return;
  edgeSide.value = target;
  await runAnimation(async () => {
    const m = await getLogicalMetrics();
    const toX = target === "right" ? Math.max(0, m.screenW - EDGE_W) : 0;
    await animateSize(m.w, EDGE_W, m.h, EDGE_H, m.x, toX, m.y, m.y);
    mode.value = "edge";
  });
}

/** 半圆 -> 向屏幕内推出胶囊 */
async function expandFromEdge(): Promise<void> {
  if (animating.value || mode.value !== "edge") return;
  await runAnimation(async () => {
    const m = await getLogicalMetrics();
    const toX = edgeSide.value === "right" ? Math.max(0, m.screenW - CAPSULE_W) : 0;
    await animateSize(m.w, CAPSULE_W, m.h, CAPSULE_H, m.x, toX, m.y, m.y);
    mode.value = "capsule";
  });
}

/** 拖动结束：只要一侧边界触碰到屏幕边缘就收成小半圆 */
async function maybeSnapToEdge(): Promise<void> {
  // 还按着鼠标（用户把岛拖到边缘后没松手）时不能动窗口：否则窗口会在指针底下
  // 自己缩小 / 挪走，拖拽随即失效。松手那一刻 onUp 会再补一次判断。
  if (dragging) return;
  if (animating.value) return;
  if (Date.now() < suppressSnapUntil) return;
  if (mode.value !== "capsule" && mode.value !== "expanded") return;
  const m = await getLogicalMetrics();
  const EDGE_ZONE = 30; // 触边容差（逻辑像素）
  const leftDist = m.x;
  const rightDist = m.screenW - (m.x + m.w);
  let target: "left" | "right" | null = null;
  if (leftDist <= EDGE_ZONE && leftDist < rightDist) target = "left";
  else if (rightDist <= EDGE_ZONE && rightDist < leftDist) target = "right";
  if (target) {
    await collapseToEdge(target);
  } else {
    await savePos();
  }
}

/** hover：鼠标进入 -> 丝滑展开 */
function onHoverEnter(): void {
  if (hoverTimer) window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    if (animating.value || dragging) return;
    if (mode.value === "capsule") void expand();
    else if (mode.value === "edge") void expandFromEdge();
  }, 80);
}

/** hover：鼠标移走 -> 自动收起 */
function onHoverLeave(): void {
  if (hoverTimer) window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    if (animating.value || dragging) return;
    if (mode.value === "expanded") void collapseToCapsule();
  }, 150);
}

/** 胶囊点击（兜底） */
function onCapsuleClick(): void {
  if (mode.value === "capsule") void expand();
}

/** 边条点击（兜底） */
function onEdgeClick(): void {
  if (mode.value === "edge") void expandFromEdge();
}

// ---------- 数据 ----------

async function refresh(): Promise<void> {
  await storeRefreshAll();
  await loadData();
}

/** 代理记账后：距上次余额采集超过 5 分钟则顺带刷新余额 */
async function maybeRefreshOnUsage(): Promise<void> {
  try {
    const t = await getSetting("last_collect_at");
    const lastTs = t ? new Date(t).getTime() : 0;
    if (Date.now() - lastTs > 5 * 60 * 1000) {
      await refresh();
    } else {
      await storeLoadData();
    }
  } catch {
    await storeLoadData();
  }
}

async function loadData(): Promise<void> {
  await storeLoadData();
  // 数据变了就同步菜单栏（渲染口径与设置页预览一致）
  void pushMenubar();
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(isZh() ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  const t = await getSetting("last_collect_at");
  lastUpdated.value = t ? fmtTime(t) : "";
  // 最近一次采集整体失败时，last_collect_at 不会推进；只显示这个旧时间会让人
  // 以为「定时器停了」。所以额外把失败的尝试时间标出来。
  const outcome = await getSetting("last_collect_outcome").catch(() => null);
  const attemptAt = await getSetting("last_collect_attempt_at").catch(() => null);
  const failedAt =
    outcome === "fail" && attemptAt && (!t || new Date(attemptAt) > new Date(t)) ? attemptAt : null;
  lastCollectFailedAt.value = failedAt ? fmtTime(failedAt) : "";
}

function openDashboard(): void {
  // 走 Rust 侧统一入口：面板与岛的显隐一次同步好（岛窗口不隐藏，它要继续跑定时器）
  void invoke("show_dashboard_command");
}
/** 「—」按钮 = 关掉岛：和设置里的开关是同一个偏好，会被记住 */
function hideOverlay(): void {
  void invoke("set_overlay_enabled", { enabled: false });
  void setSetting("overlay_enabled", "0");
}

// 拖动抑制：按下时不让 hover 误展开（胶囊可直接拖动）。
// 定义在模块作用域而不是 onMounted 里面，这样 onUnmounted 能按引用摘掉它们——
// 之前挂在 window 上却从不移除，组件销毁后这些闭包还在改已经失效的状态。
function onDown(): void {
  dragging = true;
  draggedThisPress = false;
  if (hoverTimer) window.clearTimeout(hoverTimer);
}

function onUp(): void {
  // 光标在窗口外松开、或窗口失焦时，mouseup 可能收不到；所以 pointerup / blur
  // 也接同一个处理，靠 dragging 判断重入，避免 dragging 永久为 true 把所有
  // hover 展开都挡掉（那之后胶囊就再也点不开了）。
  if (!dragging) return;
  dragging = false;
  if (moveTimer) window.clearTimeout(moveTimer);
  // 拖动过程中 maybeSnapToEdge 会因 dragging 直接返回，松手这一刻必须补一次判断，
  // 否则「拖到屏幕边缘松手」不会收成小半圆。只点一下没移动的用 draggedThisPress 排除。
  if (draggedThisPress && islandOn.value) void maybeSnapToEdge();
  draggedThisPress = false;
}

// Esc 收起展开态（回胶囊）；边缘态弹回胶囊
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (mode.value === "expanded") void collapseToCapsule();
  else if (mode.value === "edge") void expandFromEdge();
}

/**
 * 初始化里每一步都单独兜错。任何一个 await 失败（某个 setting 读不出来、
 * 窗口 API 偶发失败）都不该让后面的监听器与定时器注册不上——那会让整个程序
 * 「窗口在、但数据不刷新、托盘不更新」，从外面看就是装死。
 */
async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`悬浮窗初始化步骤失败：${name}`, e);
  }
}

onMounted(async () => {
  await step("初始化数据库与数据", async () => {
    await ensureData();
    // 先读菜单栏配置，避免首次推送用的是默认值
    await loadMenubarConfigStore();
    await loadData();
  });

  // 岛是否渲染由 Rust 侧同步；这里先按库里的偏好落一个初始值，再听 Rust 的变更通知
  await step("读取悬浮窗偏好", async () => {
    islandOn.value = (await getSetting("overlay_enabled").catch(() => null)) !== "0";
    unlistenIsland = await listen<boolean>(EVENT_OVERLAY_ENABLED_CHANGED, ({ payload }) => {
      islandOn.value = payload;
      // 岛开/关跟着起停光标轮询（面板打开时 Rust 也会发 false，一并停掉）
      if (payload) startCursorWatch();
      else stopCursorWatch();
      // 被收起时顺手把展开态收回胶囊，下次打开就是干净状态
      if (!payload && mode.value === "expanded") void collapseToCapsule();
    });
  });

  // 恢复位置与模式
  await step("恢复位置与模式", async () => {
    const posRaw = (await getSetting(await posSettingKey())) ?? (await getSetting("overlay_pos"));
    if (posRaw) {
      const m = await getLogicalMetrics();
      const { x, y } = JSON.parse(posRaw) as { x: number; y: number };
      const sx = Math.max(0, Math.min(x, Math.max(0, m.screenW - CAPSULE_W)));
      const sy = Math.max(0, Math.min(y, Math.max(0, m.screenH - EXPANDED_H)));
      await win.setPosition(new LogicalPosition(sx, sy));
    } else {
      await centerTop();
    }
    const savedMode = await getSetting("overlay_mode");
    if (savedMode === "expanded") {
      await win.setSize(new LogicalSize(CAPSULE_W, EXPANDED_H));
      mode.value = "expanded";
    } else if (savedMode === "edge") {
      const m = await getLogicalMetrics();
      edgeSide.value = m.x <= m.screenW / 2 ? "left" : "right";
      const ex = edgeSide.value === "right" ? Math.max(0, m.screenW - EDGE_W) : 0;
      await win.setPosition(new LogicalPosition(ex, m.y));
      await win.setSize(new LogicalSize(EDGE_W, EDGE_H));
      mode.value = "edge";
    }
  });

  // 拖动结束贴边判断
  await step("注册窗口移动监听", async () => {
    unlistenMove = await win.onMoved(() => {
      if (!islandOn.value) return;
      // 动画自己就是在反复移动窗口，这里收到的事件不是用户在拖，必须忽略：
      // 否则动画过程中不断重置 350ms 定时器，动画结束后会立刻触发一次贴边判断。
      if (animating.value) return;
      if (dragging) draggedThisPress = true;
      if (moveTimer) window.clearTimeout(moveTimer);
      moveTimer = window.setTimeout(() => void maybeSnapToEdge(), 350);
    });
  });

  // 点击屏幕其他地方 -> 收回胶囊（兜底）
  await step("注册焦点监听", async () => {
    unlistenFocus = await win.onFocusChanged(({ payload }) => {
      if (!islandOn.value) return;
      if (!payload && mode.value === "expanded" && !animating.value) void collapseToCapsule();
    });
  });

  await step("读取低余额阈值", async () => {
    const rawThreshold = await getSetting("low_balance_threshold");
    if (rawThreshold) lowThreshold.value = parseInt(rawThreshold, 10) || 20;
  });

  await step("启动自动采集", () => {
    startAutoCollect();
  });

  await step("注册数据事件监听", async () => {
    unlistenEvent = await listen(EVENT_BALANCE_UPDATED, () => void loadData());

    // 代理记账后即时刷新；若距上次余额采集 >5 分钟则顺带刷新余额（余额跟上平台）
    unlistenUsage = await listen("usage-updated", () => {
      void maybeRefreshOnUsage();
    });

    // 设置窗口 / 账户页改完配置或账户数据后广播过来：立刻重读并重推（不等 30 秒兜底刷新）
    unlistenMenubar = await listen(EVENT_MENUBAR_PUSH_REQUESTED, () => {
      void (async () => {
        await storeLoadData();
        await loadMenubarConfigStore();
        await pushMenubar();
      })();
    });

    // 托盘下拉菜单点「全部刷新」：灵动岛窗口常驻，由它执行一次全量采集
    unlistenRefresh = await listen(EVENT_REFRESH_ALL_REQUESTED, () => void refresh());
  });

  // 兜底：每 30 秒刷新本地数据
  if (!uiTimer) uiTimer = setInterval(() => void loadData(), 30_000);

  // 光标轮询只在岛真的渲染时才开（见 startCursorWatch 注释）
  if (islandOn.value) startCursorWatch();

  window.addEventListener("mousedown", onDown);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("blur", onUp);
  window.addEventListener("keydown", onKeydown);

  await step("首次刷新", () => refresh());
});

onUnmounted(() => {
  unlistenEvent?.();
  unlistenUsage?.();
  unlistenMenubar?.();
  unlistenRefresh?.();
  unlistenIsland?.();
  unlistenMove?.();
  unlistenFocus?.();
  window.removeEventListener("mousedown", onDown);
  window.removeEventListener("mouseup", onUp);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("blur", onUp);
  window.removeEventListener("keydown", onKeydown);
  if (moveTimer) window.clearTimeout(moveTimer);
  if (uiTimer) window.clearInterval(uiTimer);
  stopCursorWatch();
  if (hoverTimer) window.clearTimeout(hoverTimer);
  uiTimer = null;
  moveTimer = null;
  hoverTimer = null;
  dragging = false;
});
</script>

<template>
  <!-- 岛关掉时什么都不画：窗口透明，于是视觉上等于不存在（但窗口仍活着跑定时器） -->
  <!-- 边缘小半圆 -->
  <div
    v-if="islandOn"
    v-show="mode === 'edge'"
    class="island edge"
    :class="[edgeSide === 'right' ? 'edge-right' : 'edge-left', { low: lowBalance }]"
    :title="t('overlay.expandHint')"
    @mouseenter="onHoverEnter"
    @mouseleave="onHoverLeave"
    @click="onEdgeClick"
  >
    <span class="dot" :class="{ online: !collecting, error: lastErrors.length > 0 }"></span>
    <span class="c-title">AI</span>
  </div>

  <!-- 灵动岛主体：胶囊/展开（抽屉式） -->
  <div
    v-if="islandOn"
    v-show="mode !== 'edge'"
    class="island main"
    :class="{ low: lowBalance }"
    @mouseenter="onHoverEnter"
    @mouseleave="onHoverLeave"
  >
    <!-- 顶部行（胶囊内容 / 展开 header） -->
    <div class="cap-row" data-tauri-drag-region @click="onCapsuleClick">
      <span class="dot" :class="{ online: !collecting, error: lastErrors.length > 0 }"></span>
      <span class="brand">{{ t("overlay.brand") }}</span>
      <span class="divider"></span>
      <span class="bal" :style="{ color: statusColor(totalBalance) }"
        >¥{{ fmt(totalBalance) }}</span
      >
      <span class="spend">-¥{{ fmt(displayCost(today.cost, today.cost_estimated)) }}</span>
      <span class="tok">{{ compactTok(today.input_tokens + today.output_tokens) }} tok</span>
      <span v-if="mode === 'capsule'" class="chevron">›</span>
      <div v-else class="head-actions">
        <button
          class="icon-btn"
          :title="t('overlay.refresh')"
          :disabled="collecting"
          @click.stop="refresh"
        >
          ⟳
        </button>
        <button class="icon-btn" :title="t('overlay.panel')" @click.stop="openDashboard">⤢</button>
        <button class="icon-btn" :title="t('overlay.hide')" @click.stop="hideOverlay">—</button>
      </div>
    </div>

    <!-- 抽屉内容（展开时下拉露出） -->
    <div class="drawer">
      <div class="drawer-body">
        <div v-if="accounts.length === 0" class="empty" @click="openDashboard">
          {{ t("overlay.empty") }}<br />
          <span>{{ t("overlay.emptyHint") }}</span>
        </div>
        <div v-for="a in overlayAccounts" v-else :key="a.id" class="acc-row">
          <div class="acc-line">
            <div class="acc-name">{{ a.name }}</div>
            <div class="acc-metrics">
              <span class="m-bal" :style="{ color: statusColor(a.balance ?? 0) }">
                {{ a.balance !== null ? fmt(a.balance) : "--" }}
              </span>
              <span class="m-cost">-¥{{ fmt(a.todayCost) }}</span>
              <span class="m-tok">
                <b>{{ compactTok(a.tokens) }} tok</b>
                <i :title="t('overlay.cacheHitTokens', { hit: fmtTokFull(a.cacheTok) })">
                  {{ t("overlay.cacheLabel") }} {{ compactTok(a.cacheTok) }} · {{ a.cacheRate }}
                </i>
              </span>
            </div>
          </div>
          <!-- 时间窗口额度（LiteLLM 的 3 小时限额） -->
          <div v-if="a.quota" class="acc-quota">
            <div class="quota-bar">
              <i :class="a.quota.level" :style="{ width: a.quota.barPct + '%' }"></i>
            </div>
            <span class="quota-text">
              <b :class="a.quota.level">{{ a.quota.window }}</b>
              {{ a.quota.pct }}% · {{ a.quota.detail }}
            </span>
          </div>
        </div>
      </div>
      <div class="drawer-footer">
        <span class="date">{{ todayLabel() }}</span>
        <span class="tokens">{{
          t("overlay.today", {
            in: compactTok(today.input_tokens),
            out: compactTok(today.output_tokens),
          })
        }}</span>
        <span class="tokens cache">{{
          t("overlay.todayCache", {
            hit: compactTok(today.cache_hit_tokens),
            rate: rateText(today.input_tokens, today.cache_hit_tokens),
          })
        }}</span>
        <span class="cost">¥{{ fmt(displayCost(today.cost, today.cost_estimated)) }}</span>
        <span class="time" :class="{ failed: lastCollectFailedAt }">{{
          lastCollectFailedAt
            ? t("overlay.collectFailed", { time: lastCollectFailedAt })
            : lastUpdated
              ? t("overlay.update", { time: lastUpdated })
              : ""
        }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.island {
  background: var(--island-bg);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e5e7eb;
  user-select: none;
  overflow: hidden;
}

/* 低余额：整卡红光呼吸提醒 */
.island.low {
  animation: low-pulse 2.2s ease-in-out infinite;
}
.island.low .dot {
  background: #f87171;
}
@keyframes low-pulse {
  0%,
  100% {
    border-color: rgba(248, 113, 113, 0.35);
    box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.35);
  }
  50% {
    border-color: rgba(248, 113, 113, 0.85);
    box-shadow: 0 0 18px 4px rgba(248, 113, 113, 0.45);
  }
}

/* ---- 主体（胶囊/展开共用容器） ---- */
.main {
  width: 100%;
  height: 100vh;
  border-radius: 20px;
  display: flex;
  flex-direction: column;
}

/* 顶部行：胶囊态 64px，展开态作为 header */
.cap-row {
  height: 64px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  font-size: 12px;
  cursor: pointer;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fbbf24;
  flex-shrink: 0;
}
.dot.online {
  background: #34d399;
}
.dot.error {
  background: #f87171;
}

.brand {
  font-weight: 700;
  font-size: 12px;
  white-space: nowrap;
}
.divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.15);
  flex-shrink: 0;
}
.bal {
  font-weight: 700;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.spend {
  color: #f87171;
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tok {
  color: #9ca3af;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  margin-left: auto;
}
.chevron {
  color: #6b7280;
  font-size: 16px;
  flex-shrink: 0;
}

.head-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.icon-btn {
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 5px;
  line-height: 1;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* 抽屉内容（展开时随窗口高度露出） */
.drawer {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 2px 14px;
}
.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #9ca3af;
  cursor: pointer;
  gap: 4px;
  font-size: 12px;
}
.empty span {
  font-size: 11px;
  color: #6b7280;
}

.acc-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.acc-row:last-child {
  border-bottom: none;
}
.acc-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.acc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 90px;
  color: #d1d5db;
  font-size: 12px;
  flex-shrink: 0;
}
.acc-metrics {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
}

/* 时间窗口额度（3 小时限额） */
.acc-quota {
  display: flex;
  align-items: center;
  gap: 6px;
}
.quota-bar {
  flex: 1;
  min-width: 40px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.quota-bar > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: #34d399;
  transition: width 0.3s ease;
}
.quota-bar > i.warn {
  background: #fbbf24;
}
.quota-bar > i.danger {
  background: #f87171;
}
.quota-text {
  font-size: 10px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}
.quota-text b {
  font-weight: 700;
}
.quota-text b.ok {
  color: #34d399;
}
.quota-text b.warn {
  color: #fbbf24;
}
.quota-text b.danger {
  color: #f87171;
}
.m-bal {
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  min-width: 48px;
  text-align: right;
}
.m-cost {
  color: #f87171;
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  min-width: 44px;
  text-align: right;
}
.m-tok {
  color: #9ca3af;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
  /* 两行：上面是今日 token 合计，下面是缓存命中 token 与命中率。
     悬浮窗宽度固定 320，横向加列会挤掉账户名，所以往纵向放。 */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}
.m-tok > b {
  font-weight: 600;
}
.m-tok > i {
  font-style: normal;
  font-size: 9px;
  color: #6b7280;
}

.drawer-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 宽度只有 320，加了缓存一列后一行放不下就换行，而不是被裁掉 */
  flex-wrap: wrap;
  row-gap: 2px;
  padding: 6px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 11px;
  color: #9ca3af;
  flex-shrink: 0;
}
.date {
  color: #e5e7eb;
  font-weight: 600;
}
.tokens {
  font-variant-numeric: tabular-nums;
}
.tokens.cache {
  color: #6b7280;
}
.cost {
  color: #fbbf24;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.time {
  margin-left: auto;
  font-size: 10px;
  color: #6b7280;
}
.time.failed {
  color: #f87171;
}

/* ---- 边缘小半圆 ---- */
.edge {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
}
.edge-left {
  border-radius: 0 32px 32px 0;
}
.edge-right {
  border-radius: 32px 0 0 32px;
}
.edge:hover {
  background: rgba(26, 29, 40, 0.98);
}
.c-title {
  font-weight: 700;
  font-size: 11px;
}
</style>
