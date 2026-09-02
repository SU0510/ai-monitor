use tauri::Manager;

/// 保存 API Key 到本地加密存储（AES-256-GCM，存于应用数据目录 SQLite）
#[tauri::command]
pub async fn save_secret(app: tauri::AppHandle, account: String, secret: String) -> Result<(), String> {
    crate::secret::set(&app, &account, &secret).await
}

/// 从本地加密存储读取 API Key
#[tauri::command]
pub async fn get_secret(app: tauri::AppHandle, account: String) -> Result<String, String> {
    match crate::secret::get(&app, &account).await? {
        Some(v) => Ok(v),
        None => Err("读取密钥失败: 密钥不存在".to_string()),
    }
}

/// 删除本地加密存储中的 API Key
#[tauri::command]
pub async fn delete_secret(app: tauri::AppHandle, account: String) -> Result<(), String> {
    crate::secret::remove(&app, &account).await
}

/// 显示指定窗口
#[tauri::command]
pub fn show_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or("window not found")?
        .show()
        .map_err(|e| e.to_string())
}

/// 隐藏指定窗口
#[tauri::command]
pub fn hide_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or("window not found")?
        .hide()
        .map_err(|e| e.to_string())
}

/// 切换窗口显示/隐藏
#[tauri::command]
pub fn toggle_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        if w.is_visible().map_err(|e| e.to_string())? {
            w.hide().map_err(|e| e.to_string())?;
        } else {
            w.show().map_err(|e| e.to_string())?;
            w.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 通过 Rust 侧发起 HTTP GET 请求并解析 JSON
/// 用于规避 webview 的 CORS 限制（各家 AI 平台 API 大多不允许跨域）
#[tauri::command]
pub async fn http_get_json(
    url: String,
    headers: Vec<(String, String)>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ai-monitor/0.1.0")
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let mut req = client.get(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }

    let resp = req.send().await.map_err(|e| {
        eprintln!("[http_get_json] 请求失败 url={url} err={e}");
        format!("请求失败: {e}")
    })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        eprintln!("[http_get_json] HTTP {} url={} body={}", status, url, body);
        return Err(format!("HTTP {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("JSON 解析失败: {e}"))
}

/// 通用 HTTP 请求（任意 method / headers / body），用于自定义余额查询 API。
/// 可选 body 仅对带请求体的方法生效；响应统一按 JSON 解析。
#[tauri::command]
pub async fn http_request(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ai-monitor/0.1.0")
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("不支持的方法 {method}: {e}"))?;

    let mut req = client.request(m, &url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }

    let resp = req.send().await.map_err(|e| {
        eprintln!("[http_request] 请求失败 method={method} url={url} err={e}");
        format!("请求失败: {e}")
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        eprintln!("[http_request] HTTP {status} method={method} url={url} body={text}");
        return Err(format!("HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败: {e}"))
}

/// 退出应用
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 设置代理密钥（x-proxy-secret），运行时热更新，无需重启
#[tauri::command]
pub async fn set_proxy_secret(app: tauri::AppHandle, secret: String) -> Result<(), String> {
    crate::proxy::set_proxy_secret(&app, secret).await
}

/// 更新托盘标题：总余额与今日花费
#[tauri::command]
pub fn set_tray_status(app: tauri::AppHandle, total: String, today: String) {
    crate::tray::update_tray_status(&app, total, today);
}

/// 把 CSV 内容写入用户「下载」目录（用于导出用量账单），返回完整路径
#[tauri::command]
pub fn export_usage_csv(csv: String) -> Result<String, String> {
    let dir = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join("Downloads"))
        .unwrap_or_else(|_| std::env::temp_dir());
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let name = format!("ai-monitor-usage-{}.csv", chrono_now_u32());
    let path = dir.join(name);
    std::fs::write(&path, csv).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path.display().to_string())
}

/// 生成时间戳文件名（HHMMSS）
fn chrono_now_u32() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs:x}")
}

/// 通过 Rust 侧发起 HTTP POST 请求（用于 Webhook 通知）
#[tauri::command]
pub async fn http_post_json(
    url: String,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("ai-monitor/0.1.0")
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let mut req = client.post(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        eprintln!("[http_post_json] HTTP {} url={} body={}", status, url, text);
        return Err(format!("HTTP {status}: {text}"));
    }
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
}

/// 通过 Rust 侧发起 HTTP GET 请求并返回原始文本（用于抓取网页数据）
#[tauri::command]
pub async fn http_get_text(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    Ok(body)
}
