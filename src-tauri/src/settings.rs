use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process};
use tauri::{AppHandle, Manager};

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

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub library_dir: Option<String>,
    #[serde(default)]
    pub ai: AiSettings,
}

pub fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|error| format!("定位应用数据目录失败：{error}"))
}

pub fn load(app: &AppHandle) -> AppSettings {
    let Ok(path) = path(app) else {
        return AppSettings::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return AppSettings::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建应用数据目录失败：{error}"))?;
    }

    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|error| format!("序列化设置失败：{error}"))?;
    let temp = path.with_extension(format!("json.tmp-{}", process::id()));
    fs::write(&temp, bytes).map_err(|error| format!("写入设置失败：{error}"))?;
    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&path);
        fs::rename(&temp, &path).map_err(|_| format!("保存设置失败：{error}"))?;
    }
    Ok(())
}
