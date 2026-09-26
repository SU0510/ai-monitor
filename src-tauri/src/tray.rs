use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const TRAY_ID: &str = "main-tray";

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

/// 托盘本地状态：创建时记住图标（供「隐藏图标」后再恢复），
/// 以及上一次菜单内容的签名（内容没变就不重建菜单）。
#[derive(Default)]
pub struct TrayState {
    pub icon: Mutex<Option<Image<'static>>>,
    pub menu_sig: Mutex<String>,
}

pub fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let icon = app.default_window_icon().cloned();
    app.manage(TrayState {
        icon: Mutex::new(icon.clone()),
        menu_sig: Mutex::new(String::new()),
    });

    let menu = build_menu(app.handle(), &[])?;
    let icon = icon.unwrap_or_else(|| Image::new(&[], 0, 0));

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => show_dashboard(app),
                "toggle_overlay" => toggle_overlay(app),
                "quit" => app.exit(0),
                // 账户条目（前端生成的 acc-<id>）：点开面板看明细
                _ if id.starts_with("acc-") => show_dashboard(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_dashboard(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 动态条目 + 分隔线 + 固定操作项。固定项文案目前仍是中文（Rust 侧未接 i18n）。
fn build_menu(app: &AppHandle, items: &[TrayMenuItem]) -> tauri::Result<Menu> {
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

/// 更新菜单栏整体显示：标题、悬停提示、菜单项、图标显隐
#[tauri::command]
pub fn set_tray_display(
    app: AppHandle,
    title: Option<String>,
    tooltip: Option<String>,
    show_icon: bool,
    show_title: bool,
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

    let text: Option<&str> = if show_title { title.as_deref() } else { None };
    tray.set_title(text).map_err(|e| e.to_string())?;
    tray.set_tooltip(tooltip.as_deref()).map_err(|e| e.to_string())?;

    // 图标与标题全都不显示的话，菜单栏项会彻底消失、应用再也点不到，所以那种情况必须留图标
    if !show_icon && text.is_some() {
        let _ = tray.set_icon(None);
    } else if let Some(state) = app.try_state::<TrayState>() {
        let restored = state.icon.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(icon) = restored {
            let _ = tray.set_icon(Some(icon));
        }
    }
    Ok(())
}

/// 只换标题：轮播时每秒级调用，避免反复重建菜单（菜单被打开时重建会闪一下）
#[tauri::command]
pub fn set_tray_title(app: AppHandle, title: Option<String>) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Err("托盘尚未初始化".into());
    };
    tray.set_title(title.as_deref()).map_err(|e| e.to_string())
}

fn show_dashboard(app: &AppHandle) {
    // 显示面板时隐藏灵动岛（二者互斥）
    if let Some(ov) = app.get_webview_window("overlay") {
        let _ = ov.hide();
    }
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}
