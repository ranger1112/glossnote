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
        Ok(settings) => (settings, None),
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
