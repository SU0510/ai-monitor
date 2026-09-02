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
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {e}"))?
        .join("ai-monitor.db");

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
