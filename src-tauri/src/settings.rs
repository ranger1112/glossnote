use crate::models::SmartCollection;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};
use tauri::{AppHandle, Manager};

/// 所有 settings.json 的读改写都必须持有这把锁；否则并发命令会把彼此
/// 刚保存的字段覆盖回旧快照（尤其是 mcp.enabled / exposeText）。
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());

pub(crate) fn write_lock() -> MutexGuard<'static, ()> {
    SETTINGS_WRITE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// 明文保存在应用数据目录；界面与文档都会明确提示。
    #[serde(default)]
    pub api_key: String,
}

fn default_provider() -> String {
    "anthropic".to_string()
}

fn default_model() -> String {
    "claude-sonnet-5-5".to_string()
}

fn default_base_url() -> String {
    "https://api.anthropic.com".to_string()
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: default_provider(),
            model: default_model(),
            base_url: default_base_url(),
            api_key: String::new(),
        }
    }
}

fn default_mcp_port() -> u16 {
    8765
}

/// 手改坏的端口不应让整个设置文件被判损坏，从而连带丢掉 libraryDir。
fn deserialize_mcp_port<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(u16::deserialize(deserializer).unwrap_or_else(|_| default_mcp_port()))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(
        default = "default_mcp_port",
        deserialize_with = "deserialize_mcp_port"
    )]
    pub port: u16,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub expose_text: bool,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_mcp_port(),
            token: String::new(),
            expose_text: false,
        }
    }
}

fn valid_mcp_token(token: &str) -> bool {
    (16..=128).contains(&token.len())
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl McpSettings {
    pub fn normalize(&mut self) {
        if !(1024..=65535).contains(&self.port) {
            self.port = default_mcp_port();
        }
        if !self.token.is_empty() && !valid_mcp_token(&self.token) {
            self.token.clear();
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub library_dir: Option<String>,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub mcp: McpSettings,
    /// 虚拟文件夹列表；文档上的归属仍以 SQLite/sidecar 为准。
    #[serde(default)]
    pub folders: Vec<String>,
    /// 智能收藏夹：保存筛选条件，点开时动态匹配文档。
    #[serde(default)]
    pub collections: Vec<SmartCollection>,
}

impl AppSettings {
    fn normalize(&mut self) {
        self.mcp.normalize();
    }
}

/// 桌面冒烟可以在 debug 构建里重定向应用数据目录，避免污染真实书库。
/// release 构建不编译这个分支。
pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("GLOSSNOTE_APP_DATA_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("定位应用数据目录失败：{error}"))
}

pub fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("settings.json"))
}

/// 解析失败时把坏文件改名留档，再用默认值启动。
/// 直接回退默认值会让用户以为书库「空了」，而且下一次保存会覆盖掉原文件。
pub fn load_reporting(app: &AppHandle) -> (AppSettings, Option<PathBuf>) {
    let Ok(path) = path(app) else {
        return (AppSettings::default(), None);
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return (AppSettings::default(), None);
    };
    match serde_json::from_str::<AppSettings>(&text) {
        Ok(mut settings) => {
            settings.normalize();
            (settings, None)
        }
        Err(error) => {
            eprintln!("设置文件无法解析：{error}");
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            let backup = path.with_extension(format!("json.broken-{stamp}"));
            match fs::rename(&path, &backup) {
                Ok(()) => (AppSettings::default(), Some(backup)),
                Err(_) => (AppSettings::default(), None),
            }
        }
    }
}

pub fn load(app: &AppHandle) -> AppSettings {
    load_reporting(app).0
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 同目录临时文件 + rename；失败时保留旧文件，绝不先删除目标。
/// Windows 的 rename 本身会覆盖已存在的文件，删除目标再重试只会在
/// 临时文件被锁住时把唯一一份旧数据毁掉。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!(
        "tmp-{}-{}",
        process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temp, bytes)?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = path(app)?;
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|error| format!("序列化设置失败：{error}"))?;
    write_atomic(&path, &bytes).map_err(|error| format!("写入设置失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_defaults_are_off_and_loopback_friendly() {
        let settings = McpSettings::default();
        assert!(!settings.enabled);
        assert!(!settings.expose_text);
        assert_eq!(settings.port, 8765);
        assert!(settings.token.is_empty());
    }

    #[test]
    fn invalid_port_falls_back_instead_of_breaking_the_file() {
        let parsed: AppSettings =
            serde_json::from_str(r#"{"libraryDir":"D:\\Books","mcp":{"port":99999}}"#).unwrap();
        assert_eq!(parsed.mcp.port, 8765);
        assert_eq!(parsed.library_dir.as_deref(), Some("D:\\Books"));
    }

    #[test]
    fn normalize_clamps_port_and_drops_unsafe_tokens() {
        let mut settings = McpSettings {
            enabled: true,
            port: 80,
            token: "bad/token".to_string(),
            expose_text: true,
        };
        settings.normalize();
        assert_eq!(settings.port, 8765);
        assert!(settings.token.is_empty());

        settings.token = "a".repeat(64);
        settings.port = 9000;
        settings.normalize();
        assert_eq!(settings.token.len(), 64);
        assert_eq!(settings.port, 9000);
    }

    #[test]
    fn write_atomic_replaces_existing_content() {
        let dir =
            std::env::temp_dir().join(format!("glossnote-atomic-replace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_keeps_old_file_when_rename_fails() {
        let dir =
            std::env::temp_dir().join(format!("glossnote-atomic-failure-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 目标是一个目录，rename 必然失败；旧目标不能被删除。
        let path = dir.join("note.md");
        fs::create_dir_all(&path).unwrap();

        assert!(write_atomic(&path, b"new").is_err());
        assert!(path.is_dir());
        // 临时文件应被清理，目录里只剩目标目录。
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        let _ = fs::remove_dir_all(&dir);
    }
}
