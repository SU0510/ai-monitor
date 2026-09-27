<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import AccountsTab from "../components/AccountsTab.vue";
import UsageTab from "../components/UsageTab.vue";
import SettingsTab from "../components/SettingsTab.vue";
import {
  ensureData,
  collecting,
  refreshAll,
  showToast,
  toast,
  lastErrors,
} from "../core/dashboardStore";
import { EVENT_BALANCE_UPDATED, startAutoCollect } from "../core/collector";
import { getSetting, setSetting } from "../core/db";

const { t } = useI18n();

type Tab = "accounts" | "usage" | "settings";
const TABS: Tab[] = ["accounts", "usage", "settings"];
const DASHBOARD_TAB_KEY = "dashboard_tab";
const tab = ref<Tab>("accounts");

/** 记住上次看的标签页，重启后回到原处而不是每次都跳回「账户」 */
async function selectTab(next: Tab): Promise<void> {
  tab.value = next;
  await setSetting(DASHBOARD_TAB_KEY, next).catch(() => null);
}

async function refreshAllWrap(): Promise<void> {
  try {
    const result = await refreshAll();
    if (result.failed > 0) {
      showToast(
        t("dashboard.toast.refreshFail", {
          failed: result.failed,
          errors: result.errors.slice(0, 3).join("\n"),
        })
      );
    } else {
      showToast(t("dashboard.toast.refreshDone", { ok: result.ok }));
    }
  } catch (e) {
    showToast(t("dashboard.toast.refreshErr", { err: (e as Error).message || String(e) }));
  }
}

function hidePanel(): void {
  // 面板显隐与岛的状态由 Rust 一次性同步（岛窗口不隐藏，它要留着跑定时器）
  void invoke("hide_dashboard_command");
}

/**
 * Cmd+W 收起面板。
 * 本应用是纯菜单栏应用（LSUIElement），没有菜单栏，macOS 因此不会替我们处理这个快捷键，
 * 得自己在页面里接住。这里不区分 Shift：Cmd+W 与 Cmd+Shift+W 都只是收起面板。
 */
function onKeydown(e: KeyboardEvent): void {
  if (!e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() !== "w") return;
  e.preventDefault();
  hidePanel();
}

let unlisten: UnlistenFn | null = null;
onMounted(async () => {
  // 捕获阶段监听：焦点在输入框里时也要能收起面板（Cmd+W 是窗口级快捷键）
  window.addEventListener("keydown", onKeydown, true);
  // 每一步都单独兜错：读标签页偏好失败、或数据库初始化失败，都不该连带把
  // 事件监听和自动采集一起跳过——那样面板会一直显示不刷新。
  try {
    await ensureData();
  } catch (e) {
    console.error("面板初始化数据失败", e);
  }
  try {
    const saved = await getSetting(DASHBOARD_TAB_KEY).catch(() => null);
    if (saved && TABS.includes(saved as Tab)) tab.value = saved as Tab;
  } catch (e) {
    console.error("恢复标签页失败", e);
  }
  try {
    unlisten = await listen(EVENT_BALANCE_UPDATED, () => void ensureData());
  } catch (e) {
    console.error("注册余额更新监听失败", e);
  }
  startAutoCollect();
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown, true);
  unlisten?.();
});
</script>

<template>
  <div class="dashboard-root">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>{{ t("dashboard.title") }}</span>
      </div>
      <div class="topbar-right">
        <button class="btn" :disabled="collecting" @click="refreshAllWrap">
          {{ collecting ? t("dashboard.adding") : t("dashboard.refreshAll") }}
        </button>
        <button class="btn ghost" @click="hidePanel">{{ t("dashboard.hideToTray") }}</button>
      </div>
    </header>

    <nav class="tabs">
      <button
        v-for="tt in TABS"
        :key="tt"
        class="tab"
        :class="{ active: tab === tt }"
        @click="selectTab(tt)"
      >
        {{ t(`dashboard.tabs.${tt}`) }}
      </button>
    </nav>

    <div v-if="lastErrors.length > 0" class="err-banner" :title="lastErrors.join('\n')">
      <span>{{ t("dashboard.errBanner", { failed: lastErrors.length }) }}</span>
      <button class="err-close" @click="lastErrors = []">✕</button>
    </div>

    <main class="content">
      <AccountsTab v-if="tab === 'accounts'" />
      <UsageTab v-else-if="tab === 'usage'" />
      <SettingsTab v-else />
    </main>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.dashboard-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
  color: var(--c-text);
  font-size: 14px;
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
}
.brand-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--c-accent-strong);
}
.topbar-right {
  display: flex;
  gap: 8px;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 10px 20px 0;
  border-bottom: 1px solid var(--c-border);
}
.tab {
  background: transparent;
  border: none;
  color: var(--c-text-dim);
  padding: 8px 16px;
  cursor: pointer;
  border-radius: 8px 8px 0 0;
  font-size: 14px;
}
.tab.active {
  color: #fff;
  background: var(--c-border);
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px 40px;
}

.err-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 10px 20px 0;
  padding: 8px 12px;
  background: rgba(248, 113, 113, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: var(--radius-sm);
  color: var(--c-danger);
  font-size: 12px;
}
.err-close {
  background: transparent;
  border: none;
  color: var(--c-danger);
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
}
.err-close:hover {
  color: #fff;
}

.btn {
  background: var(--c-border-strong);
  border: 1px solid var(--c-border-strong);
  color: var(--c-text);
  border-radius: var(--radius-sm);
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
.btn.ghost {
  background: transparent;
}

.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(17, 24, 39, 0.95);
  border: 1px solid var(--c-border-strong);
  border-radius: 10px;
  padding: 10px 20px;
  color: var(--c-text);
  font-size: 13px;
  box-shadow: var(--shadow-lg);
  z-index: 100;
  max-width: 80vw;
  white-space: pre-line;
}
</style>
