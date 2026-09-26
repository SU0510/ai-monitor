import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getSetting, setSetting } from "./db";
import {
  accounts,
  balances,
  quotas,
  today,
  todayByAccount,
  collecting,
  lastErrors,
  totalBalance,
  displayCost,
} from "./dashboardStore";
import { primaryQuota, quotaView } from "./quota";
import {
  MENUBAR_CONFIG_KEY,
  defaultMenubarConfig,
  normalizeMenubarConfig,
  renderMenubar,
  type MenubarConfig,
  type MenubarData,
  type MenubarRender,
} from "./menubar";

/**
 * 菜单栏（托盘）与配置之间的胶水层。
 *
 * 渲染本身在 menubar.ts（纯函数）；这里只做三件事：
 * 读写配置、把 store 里的数据整理成渲染输入、推给 Rust 托盘。
 */

/** 配置变更事件：设置窗口改完后广播，让其它窗口（灵动岛）立刻重新读取 */
export const EVENT_MENUBAR_CONFIG_CHANGED = "menubar-config-changed";

/** 当前配置（设置页与托盘共用同一份，改完立即生效） */
export const menubarConfig = ref<MenubarConfig>(defaultMenubarConfig());

let rotationTimer: ReturnType<typeof setInterval> | null = null;
/** 最近一次渲染结果，供轮播只换标题时复用 */
let lastRender: MenubarRender | null = null;
let rotationIndex = 0;

export async function loadMenubarConfigStore(): Promise<MenubarConfig> {
  const raw = await getSetting(MENUBAR_CONFIG_KEY);
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 配置损坏时退回默认值，不能让菜单栏整体失效
      parsed = null;
    }
  }
  menubarConfig.value = normalizeMenubarConfig(parsed);
  return menubarConfig.value;
}

export async function saveMenubarConfigStore(cfg: MenubarConfig): Promise<void> {
  const normalized = normalizeMenubarConfig(cfg);
  menubarConfig.value = normalized;
  await setSetting(MENUBAR_CONFIG_KEY, JSON.stringify(normalized));
  // 设置窗口与灵动岛是两个独立的 JS 上下文，各自持有一份 menubarConfig；
  // 广播出去让灵动岛（负责定时推送的那个窗口）马上同步，否则它会在下次刷新时用旧值覆盖
  await emit(EVENT_MENUBAR_CONFIG_CHANGED).catch(() => null);
  await pushMenubar();
  restartRotation();
}

/** 把 store 数据整理成渲染输入（同一 baseUrl 的第 N 把 key 就是第 N 个账户，天然分开） */
export function buildMenubarData(): MenubarData {
  const accountData = accounts.value.map((acc) => {
    const bal = balances.value[acc.id];
    const currency = bal?.currency ?? "CNY";
    const usage = todayByAccount.value[acc.id];
    return {
      id: acc.id,
      label: acc.name,
      currency,
      balance: bal ? bal.balance : null,
      todayCost: displayCost(usage?.cost ?? 0, usage?.cost_estimated ?? 0),
      tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      quota: quotaView(primaryQuota(quotas.value[acc.id]), currency),
    };
  });

  return {
    accounts: accountData,
    totals: {
      // 按你的要求先统一用人民币符号展示
      currency: "CNY",
      balance: totalBalance.value,
      todayCost: displayCost(today.value.cost, today.value.cost_estimated),
      tokens: today.value.input_tokens + today.value.output_tokens,
      // 跨账户的窗口额度没有统一口径（币种/窗口都可能不同），故不提供聚合额度
      quota: null,
    },
    collecting: collecting.value,
    hasError: lastErrors.value.length > 0,
  };
}

/** 供设置页实时预览：与推给托盘的是同一个渲染结果 */
export function renderMenubarNow(): MenubarRender {
  return renderMenubar(menubarConfig.value, buildMenubarData());
}

/** 把当前配置与数据推给托盘（Rust 侧只负责套用，不做任何格式化） */
export async function pushMenubar(): Promise<void> {
  // 每个窗口各自持有一份内存配置，而定时推送只发生在灵动岛窗口里；
  // 若这里直接用内存值，设置窗口改完 30 秒后就会被灵动岛的旧值覆盖回默认，
  // 所以每次推送都从 settings 重新读一遍，让库里的值成为唯一事实来源。
  await loadMenubarConfigStore();
  const cfg = menubarConfig.value;
  const render = renderMenubar(cfg, buildMenubarData());
  lastRender = render;
  rotationIndex = 0;
  const title = cfg.showTitle ? (render.titles[0] ?? null) : null;
  try {
    await invoke("set_tray_display", {
      title,
      tooltip: render.tooltip,
      // 标题与图标都关掉会让菜单栏项彻底消失、应用再也点不到，所以保底留图标
      showIcon: cfg.showIcon || !title,
      showTitle: cfg.showTitle,
      items: render.menu,
    });
  } catch {
    // 托盘不可用（如 Linux 无托盘）不应影响主流程
  }
}

/**
 * 轮播标题：只换文字，不重建菜单（重建菜单会在菜单被打开时闪一下）。
 * 标题为拆分模式时无需轮播。
 */
function restartRotation(): void {
  stopRotation();
  const cfg = menubarConfig.value;
  const render = lastRender;
  if (cfg.titleMode !== "rotate" || !cfg.showTitle) return;
  if (!render || render.titles.length <= 1) return;
  rotationTimer = setInterval(() => {
    const r = lastRender;
    if (!r || r.titles.length <= 1) return;
    rotationIndex = (rotationIndex + 1) % r.titles.length;
    void invoke("set_tray_title", { title: r.titles[rotationIndex] }).catch(() => null);
  }, cfg.rotateSecs * 1000);
}

export function stopRotation(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}

/** 灵动岛窗口常驻，由它负责启动轮播，避免两个窗口各转各的 */
export function startMenubarRotation(): void {
  restartRotation();
}
