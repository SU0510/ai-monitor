//! API Key 本地加密存储（AES-256-GCM）。
//!
//! 为解决 macOS「登录钥匙串」对未签名 app 反复弹授权框的问题，
//! 密钥改为存进应用数据目录的 SQLite（settings 表），密文用
//! 一个本机生成、持久化在同一库里的主密钥做 AES-256-GCM 加密。

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqlitePool};
use tauri::Manager;

const MASTER_KEY_SETTING: &str = "secret_master_key";
const NONCE_LEN: usize = 12;

/// 托管到 app state 的密钥存储（持有独立 SQLite 连接池）
pub struct SecretStore {
    pool: SqlitePool,
}

/// 初始化密钥存储：打开数据库、确保 settings 表存在、生成/加载主密钥。
pub async fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {e}"))?;

    // sqlx 的 create_if_missing 只建数据库文件、不建父目录。
    // 全新安装（即首次运行）时该目录不存在，会以 SQLITE_CANTOPEN(14) 失败，
    // 进而让 setup 钩子报错、应用启动即崩溃，所以必须先建目录。
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;

    let path = dir.join("ai-monitor.db");

    let opts = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .map_err(|e| format!("密钥存储连接失败: {e}"))?;

    sqlx::query("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
        .execute(&pool)
        .await
        .map_err(|e| format!("初始化 settings 表失败: {e}"))?;

    ensure_master_key(&pool).await?;

    app.manage(SecretStore { pool });
    Ok(())
}

async fn ensure_master_key(pool: &SqlitePool) -> Result<[u8; 32], String> {
    if let Ok(key) = master_key(pool).await {
        return Ok(key);
    }

    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
    )
    .bind(MASTER_KEY_SETTING)
    .bind(B64.encode(key))
    .execute(pool)
    .await
    .map_err(|e| format!("保存主密钥失败: {e}"))?;
    Ok(key)
}

async fn master_key(pool: &SqlitePool) -> Result<[u8; 32], String> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(MASTER_KEY_SETTING)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取主密钥失败: {e}"))?;
    let bytes = raw
        .and_then(|s| B64.decode(s).ok())
        .ok_or_else(|| "主密钥缺失".to_string())?;
    let mut key = [0u8; 32];
    if bytes.len() != 32 {
        return Err("主密钥长度错误".to_string());
    }
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn setting_key(account: &str) -> String {
    format!("secret:{account}")
}

/// 读一条 settings 记录。启动时恢复用户偏好要用它——偏好本来存在同一个库里，
/// 但要等前端窗口挂载才会被写回 Rust 内存，那样「关掉悬浮窗 -> 重启」又会自己冒出来。
pub async fn read_setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let store = app.try_state::<SecretStore>()?;
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(&store.pool)
        .await
        .ok()
        .flatten()
}

/// 写一条 settings 记录（供托盘手动切换悬浮窗后把偏好持久化，与前端写的是同一张表）
pub async fn write_setting(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
    let Some(store) = app.try_state::<SecretStore>() else {
        return Err("状态未初始化".into());
    };
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(&store.pool)
    .await
    .map(|_| ())
    .map_err(|e| format!("保存设置失败: {e}"))
}

/// 是否已经添加过账户。`accounts` 表由前端建库时创建，全新安装时还不存在，
/// 这种情况下按「没有账户」处理（正好也是首次启动要引导添加账户的场景）。
pub async fn has_accounts(app: &tauri::AppHandle) -> bool {
    let Some(store) = app.try_state::<SecretStore>() else {
        return false;
    };
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM accounts")
        .fetch_one(&store.pool)
        .await
        .map(|n| n > 0)
        .unwrap_or(false)
}

fn encrypt_with_key(key: &[u8; 32], plain: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|_| "加密失败".to_string())?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

fn decrypt_with_key(key: &[u8; 32], encoded: &str) -> Result<String, String> {
    let raw = B64.decode(encoded).map_err(|_| "密文解码失败".to_string())?;
    if raw.len() <= NONCE_LEN {
        return Err("密文损坏".to_string());
    }
    let (nonce_bytes, ct) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "解密失败".to_string())?;
    String::from_utf8(plain).map_err(|_| "明文不是 UTF-8".to_string())
}

pub async fn set(app: &tauri::AppHandle, account: &str, secret: &str) -> Result<(), String> {
    let store = app.state::<SecretStore>();
    let key = master_key(&store.pool).await?;
    let enc = encrypt_with_key(&key, secret)?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
    )
    .bind(setting_key(account))
    .bind(enc)
    .execute(&store.pool)
    .await
    .map_err(|e| format!("保存密钥失败: {e}"))?;
    Ok(())
}

pub async fn get(app: &tauri::AppHandle, account: &str) -> Result<Option<String>, String> {
    let store = app.state::<SecretStore>();
    let key = master_key(&store.pool).await?;
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(setting_key(account))
        .fetch_optional(&store.pool)
        .await
        .map_err(|e| format!("读取密钥失败: {e}"))?;
    match raw {
        Some(enc) => Ok(Some(decrypt_with_key(&key, &enc)?)),
        None => Ok(None),
    }
}

pub async fn remove(app: &tauri::AppHandle, account: &str) -> Result<(), String> {
    let store = app.state::<SecretStore>();
    sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(setting_key(account))
        .execute(&store.pool)
        .await
        .map_err(|e| format!("删除密钥失败: {e}"))?;
    Ok(())
}

/// 供 proxy 侧按「平台 + API Key」匹配账户：读取某账户的密钥明文做比对。
pub async fn get_plain_for_compare(app: &tauri::AppHandle, account: &str) -> Option<String> {
    get(app, account).await.ok().flatten()
}
