use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

const TRAY_ID: &str = "main-tray";

/// 下拉菜单「全部刷新」广播给前端的事件名。
/// Rust 不直接触发采集（采集逻辑全在前端），只广播一次请求，由灵动岛窗口执行。
pub const EVENT_REFRESH_ALL_REQUESTED: &str = "refresh-all-requested";

/// 悬浮窗显示偏好变化时通知灵动岛窗口，由它决定渲染不渲染岛本身。
pub const EVENT_OVERLAY_ENABLED_CHANGED: &str = "overlay-enabled-changed";

/// 托盘动态区条目。文案已由前端（src/core/menubar.ts）格式化好，
/// Rust 侧不做任何拼接，只负责套用——这样菜单栏与设置页预览必然一致。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub enabled: bool,
}

/// 托盘本地状态。
///
/// 轮播放在 Rust 里（而不是前端定时器）：菜单栏不该依赖某个 webview 处于可见状态。
/// macOS 会把隐藏窗口的 webview 定时器整个挂起，之前只要悬浮窗被关掉（或被全屏应用遮挡），
/// 菜单栏就会卡在第一帧不动。
#[derive(Default)]
pub struct TrayState {
    /// 上一次菜单内容的签名（内容没变就不重建菜单）
    pub menu_sig: Mutex<String>,
    /// 当前轮播帧
    pub titles: Mutex<Vec<String>>,
    /// 轮播代次：每次 set_tray_display 自增，旧的轮播任务看到代次变了就自行退出
    pub epoch: AtomicU64,
}

/// 灵动岛（悬浮窗）是否显示。
///
/// 注意这里控制的是「岛要不要渲染」，不是「窗口要不要显示」：窗口始终存活，
/// 因为采集、代理记账刷新、托盘推送的定时器都跑在这个 webview 里，
/// 窗口一旦隐藏，macOS 会把它的定时器全部挂起，数据就不再更新了。
pub struct OverlayPref(pub Mutex<bool>);

impl Default for OverlayPref {
    fn default() -> Self {
        Self(Mutex::new(true))
    }
}

pub fn is_overlay_enabled(app: &AppHandle) -> bool {
    app.try_state::<OverlayPref>()
        .map(|s| *s.0.lock().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or(true)
}

/// 岛当前是否应该渲染：用户偏好开着，且面板没开着（两者同屏会互相压住）。
/// 注意这只决定「渲染不渲染」，窗口本身始终存活——它承载着采集与托盘推送的定时器。
fn island_should_render(app: &AppHandle) -> bool {
    if !is_overlay_enabled(app) {
        return false;
    }
    !app.get_webview_window("dashboard")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 把「岛该不该显示」同步到窗口与前端。
/// 唯一事实来源是 OverlayPref + 面板可见性，所有显隐路径都收敛到这里，
/// 免得出现「窗口隐藏了但偏好还开着」这类对不上的状态。
fn sync_island(app: &AppHandle) {
    let visible = island_should_render(app);
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.show();
        // 不渲染时必须放过鼠标事件，否则屏幕顶部会留一块看不见却吞点击的区域
        let _ = w.set_ignore_cursor_events(!visible);
    }
    let _ = app.emit_to("overlay", EVENT_OVERLAY_ENABLED_CHANGED, visible);
}

/// 启动时按持久化的偏好决定岛是否显示。
/// 窗口在 tauri.conf.json 里是 visible:true 创建的，前端不挂载设置页就不会调
/// set_overlay_enabled，所以「关掉悬浮窗 -> 重启」必须在这里兜住。
pub fn restore_overlay_pref(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<OverlayPref>() {
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = enabled;
    }
    sync_island(app);
}

/// 设置岛是否显示：立刻生效，并记住偏好（前端同时写进 settings 做持久化）
#[tauri::command]
pub fn set_overlay_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_overlay_pref(&app, enabled);
    Ok(())
}

pub fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    app.manage(TrayState::default());
    app.manage(OverlayPref::default());

    let menu = build_menu(app.handle(), &[])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| Image::new(&[], 0, 0));

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        // 左键直接展开下拉菜单（面板入口在菜单里）；之前设成 false 又没有走菜单，
        // 结果左键只会弹面板、根本看不到菜单
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => show_dashboard(app),
                "toggle_overlay" => toggle_overlay(app),
                "refresh_all" => {
                    // 采集在前端做，这里只广播请求（灵动岛窗口监听并执行一次全量采集）
                    let _ = app.emit(EVENT_REFRESH_ALL_REQUESTED, ());
                }
                "quit" => app.exit(0),
                // 账户条目（前端生成的 acc-<id>）：点开面板看明细
                _ if id.starts_with("acc-") => show_dashboard(app),
                // 汇总条目：同样打开面板
                "agg" => show_dashboard(app),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// 动态条目 + 分隔线 + 固定操作项。固定项文案目前仍是中文（Rust 侧未接 i18n）。
fn build_menu(app: &AppHandle, items: &[TrayMenuItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let mut owned: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    for it in items {
        owned.push(Box::new(MenuItem::with_id(
            app,
            it.id.clone(),
            it.label.clone(),
            it.enabled,
            None::<&str>,
        )?));
    }
    if !items.is_empty() {
        owned.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    owned.push(Box::new(MenuItem::with_id(
        app,
        "refresh_all",
        "全部刷新",
        true,
        None::<&str>,
    )?));
    owned.push(Box::new(MenuItem::with_id(
        app,
        "show",
        "显示面板",
        true,
        None::<&str>,
    )?));
    owned.push(Box::new(MenuItem::with_id(
        app,
        "toggle_overlay",
        "显示/隐藏灵动岛",
        true,
        None::<&str>,
    )?));
    owned.push(Box::new(MenuItem::with_id(
        app,
        "quit",
        "退出",
        true,
        None::<&str>,
    )?));

    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = owned.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// 更新菜单栏整体显示：标题、悬停提示、菜单项、图标显隐，并（重）启轮播。
///
/// `titles` 是全部候选帧（前端已按需做定宽补齐），`rotate_secs` 为轮播间隔；
/// 只有一帧时不轮播。
#[tauri::command]
pub fn set_tray_display(
    app: AppHandle,
    titles: Vec<String>,
    tooltip: Option<String>,
    show_icon: bool,
    show_title: bool,
    rotate_secs: u64,
    items: Vec<TrayMenuItem>,
) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Err("托盘尚未初始化".into());
    };

    // 数据每 30 秒刷新一次，但菜单内容通常没变；此时重建会把用户正打开的菜单关掉，
    // 所以只有内容真的变了才 set_menu。
    let sig = items
        .iter()
        .map(|it| format!("{}|{}|{}", it.id, it.label, it.enabled))
        .collect::<Vec<_>>()
        .join("\n");
    let changed = app
        .try_state::<TrayState>()
        .map(|st| {
            let mut cur = st.menu_sig.lock().unwrap_or_else(|e| e.into_inner());
            if *cur == sig {
                false
            } else {
                *cur = sig;
                true
            }
        })
        .unwrap_or(true);

    if changed {
        let menu = build_menu(&app, &items).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }

    let frames: Vec<String> = if show_title { titles } else { Vec::new() };
    tray.set_title(frames.first().map(String::as_str))
        .map_err(|e| e.to_string())?;
    tray.set_tooltip(tooltip.as_deref())
        .map_err(|e| e.to_string())?;

    // 图标与标题全都不显示的话，菜单栏项会彻底消失、应用再也点不到，所以那种情况必须留图标
    if !show_icon && !frames.is_empty() {
        let _ = tray.set_icon(None);
    } else if let Some(icon) = app.default_window_icon().cloned() {
        let _ = tray.set_icon(Some(icon));
    }

    start_rotation(&app, frames, rotate_secs);
    Ok(())
}

/// （重）启轮播：记下帧与代次，再让一个后台任务按间隔换标题。
/// 旧任务发现代次变了就自行退出，所以连续推送不会叠出多个定时器。
fn start_rotation(app: &AppHandle, frames: Vec<String>, rotate_secs: u64) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *state.titles.lock().unwrap_or_else(|e| e.into_inner()) = frames.clone();
    if frames.len() <= 1 {
        return;
    }

    let secs = rotate_secs.clamp(2, 600);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut i = 1usize;
        loop {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            let Some(st) = app.try_state::<TrayState>() else {
                return;
            };
            if st.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let frames = st.titles.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if frames.len() <= 1 {
                return;
            }
            let idx = i % frames.len();
            i += 1;
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_title(Some(frames[idx].as_str()));
            }
        }
    });
}

/// 打开面板：面板与岛同屏会互相压住，所以同步逻辑会把岛收起来
fn show_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    sync_island(app);
}

/// 打开面板（托盘菜单 / 岛上的「⤢」按钮）。显隐与岛的状态在 Rust 侧一次同步好
#[tauri::command]
pub fn show_dashboard_command(app: AppHandle) {
    show_dashboard(&app);
}

/// 收起面板并把岛还回来（用户本来就关着岛时，偏好不变，岛仍不渲染）
pub fn hide_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.hide();
    }
    sync_island(app);
}

/// 面板「隐藏到托盘」按钮走这里：显隐与岛的状态在 Rust 侧一次同步好
#[tauri::command]
pub fn hide_dashboard_command(app: AppHandle) {
    hide_dashboard(&app);
}

/// 关掉岛（托盘菜单 / 岛上的「—」按钮 / Cmd+W）。偏好写回 settings，重启后依然是关的。
pub fn disable_overlay(app: &AppHandle) {
    set_overlay_pref(app, false);
}

fn toggle_overlay(app: &AppHandle) {
    // 以偏好为准而不是看窗口可见性：面板打开时岛是被临时收起的，看可见性会判断反
    let enabled = !is_overlay_enabled(app);
    set_overlay_pref(app, enabled);
}

/// 全局快捷键（Cmd+Shift+O）走这里：和托盘菜单同一个入口，
/// 会一并落盘偏好并 sync_island，避免出现「窗口看着关了、偏好还开着」的错位状态。
#[tauri::command]
pub fn toggle_overlay_command(app: AppHandle) {
    toggle_overlay(&app);
}

/// 只改偏好 + 同步 + 落盘，不做任何窗口可见性判断
fn set_overlay_pref(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<OverlayPref>() {
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = enabled;
    }
    sync_island(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ =
            crate::secret::write_setting(&app, "overlay_enabled", if enabled { "1" } else { "0" })
                .await;
    });
}
