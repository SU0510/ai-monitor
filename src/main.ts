import { createApp } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { register } from "@tauri-apps/plugin-global-shortcut";
import OverlayApp from "./views/OverlayApp.vue";
import DashboardApp from "./views/DashboardApp.vue";
import { i18n } from "./i18n";
import "./styles.css";

// 根据窗口 label 渲染不同视图：
//   overlay  -> 悬浮卡片（常驻小角落）
//   dashboard -> 完整面板
const label = getCurrentWindow().label;
const rootComponent = label === "overlay" ? OverlayApp : DashboardApp;

// 全局快捷键（仅面板窗口注册一次，窗口在后台常驻不会销毁）
// ⌥Space 在 macOS 上会抢占输入法切换，故改用 ⌘⇧Space / ⌘⇧O
if (label === "dashboard") {
  const win = getCurrentWindow();
  void (async () => {
    // ⌘⇧Space：呼出面板（隐藏岛）/ 隐藏面板（回归岛），保持二者互斥
    // 走 Rust 的 show/hide_dashboard_command 而不是裸的 show_window/hide_window：
    // 岛该不该渲染由 Rust 侧的 sync_island 统一决定（还包含 ignore_cursor_events），
    // 直接显隐窗口会留下「窗口关了但偏好还开着」的错位状态。
    await register("Command+Shift+Space", (event) => {
      if (event.state === "Pressed") {
        void (async () => {
          const visible = await win.isVisible().catch(() => false);
          await invoke(visible ? "hide_dashboard_command" : "show_dashboard_command");
        })();
      }
    }).catch((e) => console.error("[shortcut] Command+Shift+Space 注册失败", e));
    // ⌘⇧O：显示灵动岛（隐藏面板）/ 隐藏灵动岛
    // 同样收敛到 Rust 侧：toggle_overlay_command 会翻转偏好、落盘并 sync_island
    await register("Command+Shift+O", (event) => {
      if (event.state === "Pressed") {
        void invoke("toggle_overlay_command").catch((e) =>
          console.error("[shortcut] 切换悬浮窗失败", e)
        );
      }
    }).catch((e) => console.error("[shortcut] Command+Shift+O 注册失败", e));
  })();
}

createApp(rootComponent).use(i18n).mount("#app");
