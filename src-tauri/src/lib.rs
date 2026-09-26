// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod proxy;
mod secret;
mod tray;

use tauri::{Manager, WindowEvent};

/// 让 macOS 应用作为「Agent」运行：不占用 Dock（程序坞），仅存在于菜单栏/灵动岛。
#[cfg(target_os = "macos")]
fn hide_from_dock() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    }
}

#[cfg(not(target_os = "macos"))]
fn hide_from_dock() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:ai-monitor.db", vec![])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            hide_from_dock();

            // 初始化本地加密密钥存储（替代系统钥匙串，避免未签名 app 反复弹授权框）
            tauri::async_runtime::block_on(secret::init(app.handle()))?;

            tray::create_tray(app)?;

            // 恢复持久化的偏好：悬浮窗是否显示存在 settings 表里，但要在这里就生效，
            // 不能等前端设置页挂载（不打开设置页就永远不会写回），否则关了悬浮窗重启又冒出来。
            let overlay_on = tauri::async_runtime::block_on(secret::read_setting(
                app.handle(),
                "overlay_enabled",
            ))
            .map(|v| v != "0")
            .unwrap_or(true);
            tray::restore_overlay_pref(app.handle(), overlay_on);

            // 启动统一代理（本地 HTTP，自动记录 token 用量）
            proxy::start(app.handle().clone());

            let handle = app.handle().clone();

            // 关闭窗口 = 隐藏到托盘，进程常驻
            // dashboard 关闭 -> 收面板 + 把岛还回来（岛窗口本身不隐藏，它承载着定时器）
            if let Some(w) = app.get_webview_window("dashboard") {
                let w2 = w.clone();
                let h = handle.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                        tray::hide_dashboard(&h);
                    }
                });
            }
            // 岛窗口被关（Cmd+W 等）等同于「关掉悬浮窗」：记住偏好，窗口继续留着跑定时器
            if let Some(w) = app.get_webview_window("overlay") {
                let h = handle.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        tray::disable_overlay(&h);
                    }
                });
            }

            // 仅首次启动（还没添加账户）自动弹出主面板引导；之后启动只留菜单栏/灵动岛，
            // 不再每次都把面板盖上来打断用户。面板随时可以从托盘菜单打开。
            if !tauri::async_runtime::block_on(secret::has_accounts(app.handle())) {
                if let Some(d) = app.get_webview_window("dashboard") {
                    let _ = d.show();
                    let _ = d.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_secret,
            commands::get_secret,
            commands::delete_secret,
            commands::set_proxy_secret,
            tray::set_tray_display,
            tray::set_overlay_enabled,
            tray::show_dashboard_command,
            tray::hide_dashboard_command,
            commands::show_window,
            commands::hide_window,
            commands::toggle_window,
            commands::export_usage_csv,
            commands::http_get_json,
            commands::http_request,
            commands::http_post_json,
            commands::http_get_text,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
