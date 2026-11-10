pub mod mapping;
pub mod server;
pub mod tools;

use crate::{settings, state::AppState};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub expose_text: bool,
}

impl From<&settings::McpSettings> for McpConfig {
    fn from(value: &settings::McpSettings) -> Self {
        Self {
            enabled: value.enabled,
            port: value.port,
            token: value.token.clone(),
            expose_text: value.expose_text,
        }
    }
}

pub struct McpRuntime {
    pub port: u16,
    pub shutdown: Option<oneshot::Sender<()>>,
    pub cancel: CancellationToken,
    pub task: tauri::async_runtime::JoinHandle<()>,
}

pub struct McpState {
    pub config: McpConfig,
    pub runtime: Option<McpRuntime>,
    pub last_error: Option<String>,
    /// 每次启停、换端口或重置 token 都递增；启动任务完成时若已过期就丢弃，
    /// 避免启动较慢的旧任务把刚关闭的服务重新挂上。
    pub generation: u64,
}

impl McpState {
    pub fn from_settings(value: &settings::McpSettings) -> Self {
        Self {
            config: McpConfig::from(value),
            runtime: None,
            last_error: None,
            generation: 0,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpSettingsView {
    pub enabled: bool,
    pub port: u16,
    pub expose_text: bool,
    pub running: bool,
    pub actual_port: Option<u16>,
    pub error: Option<String>,
    pub url: String,
    pub config_json: String,
    pub token_set: bool,
}

fn lock_mcp(state: &AppState) -> std::sync::MutexGuard<'_, McpState> {
    state
        .mcp
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn config_json(url: &str) -> String {
    serde_json::json!({
        "mcpServers": {
            "glossnote": { "url": url }
        }
    })
    .to_string()
}

pub fn status(app: &AppHandle) -> McpSettingsView {
    let state = app.state::<AppState>();
    let slot = lock_mcp(&state);
    let actual_port = slot.runtime.as_ref().map(|runtime| runtime.port);
    let url = if slot.config.enabled && !slot.config.token.is_empty() {
        let port = actual_port.unwrap_or(slot.config.port);
        format!("http://127.0.0.1:{port}/mcp/{}", slot.config.token)
    } else {
        String::new()
    };
    McpSettingsView {
        enabled: slot.config.enabled,
        port: slot.config.port,
        expose_text: slot.config.expose_text,
        running: slot.runtime.is_some(),
        actual_port,
        error: if slot.config.enabled {
            slot.last_error.clone()
        } else {
            None
        },
        config_json: if url.is_empty() {
            String::new()
        } else {
            config_json(&url)
        },
        url,
        token_set: !slot.config.token.is_empty(),
    }
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("生成 MCP token 失败：{error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 取走当前监听任务并推进 generation；之后完成的旧启动任务都会被丢弃。
async fn take_runtime(app: &AppHandle) -> (Option<McpRuntime>, u64) {
    let state = app.state::<AppState>();
    let mut slot = lock_mcp(&state);
    slot.generation = slot.generation.wrapping_add(1);
    (slot.runtime.take(), slot.generation)
}

async fn stop_runtime(runtime: McpRuntime) {
    runtime.cancel.cancel();
    if let Some(shutdown) = runtime.shutdown {
        let _ = shutdown.send(());
    }
    if tokio::time::timeout(Duration::from_secs(2), runtime.task)
        .await
        .is_err()
    {
        eprintln!("MCP 服务未在 2 秒内退出，监听端口可能延迟释放");
    }
}

/// 先同步 bind 到 loopback，拿到实际端口后再交给 axum；失败只返回错误，不阻塞应用。
async fn start(app: &AppHandle, config: &McpConfig) -> Result<McpRuntime, String> {
    if config.token.is_empty() {
        return Err("MCP token 为空，请在设置页重置 token 后重试".to_string());
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.port))
        .await
        .map_err(|error| format!("MCP 端口 {} 启动失败：{error}", config.port))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取 MCP 端口失败：{error}"))?
        .port();
    let (shutdown, receiver) = oneshot::channel();
    let cancel = CancellationToken::new();
    let router = server::router(app.clone(), config.token.clone(), cancel.clone());
    let task = tauri::async_runtime::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = receiver.await;
            })
            .await;
        if let Err(error) = result {
            eprintln!("MCP 服务退出：{error}");
        }
    });
    Ok(McpRuntime {
        port,
        shutdown: Some(shutdown),
        cancel,
        task,
    })
}

async fn start_and_record(app: &AppHandle, config: McpConfig, generation: u64) {
    let result = start(app, &config).await;
    let state = app.state::<AppState>();
    // 在锁内完成决策并取出需要停止的任务；await 必须发生在释放锁之后。
    let stale_runtime = {
        let mut slot = lock_mcp(&state);
        if slot.generation != generation {
            result.ok()
        } else {
            match result {
                Ok(runtime) => {
                    slot.runtime = Some(runtime);
                    slot.last_error = None;
                }
                Err(error) => {
                    slot.runtime = None;
                    slot.last_error = Some(error);
                }
            }
            None
        }
    };
    // 新的启停操作已经接管：本次启动结果不能落进状态，已绑定的端口要立刻释放。
    if let Some(runtime) = stale_runtime {
        stop_runtime(runtime).await;
    }
}

pub fn spawn_start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let (mut config, generation) = {
            let state = app.state::<AppState>();
            let slot = lock_mcp(&state);
            (slot.config.clone(), slot.generation)
        };
        if !config.enabled {
            return;
        }
        if config.token.is_empty() {
            match update_settings(&app, |settings| {
                settings.mcp.token = generate_token()?;
                Ok(())
            }) {
                Ok((settings, _)) => config = McpConfig::from(&settings.mcp),
                Err(error) => {
                    let state = app.state::<AppState>();
                    let mut slot = lock_mcp(&state);
                    // 等待 token 期间设置可能已被用户关闭，过期的错误同样不应写回。
                    if slot.generation == generation {
                        slot.last_error = Some(error);
                    }
                    return;
                }
            }
        }
        if !config.enabled {
            return;
        }
        start_and_record(&app, config, generation).await;
    });
}

fn update_settings<T>(
    app: &AppHandle,
    change: impl FnOnce(&mut settings::AppSettings) -> Result<T, String>,
) -> Result<(settings::AppSettings, T), String> {
    let state = app.state::<AppState>();
    let _guard = settings::write_lock();
    let mut settings = settings::load(app);
    let value = change(&mut settings)?;
    settings.mcp.normalize();
    settings::save(app, &settings)?;
    {
        let mut slot = lock_mcp(&state);
        slot.config = McpConfig::from(&settings.mcp);
    }
    Ok((settings, value))
}

pub async fn set_enabled(app: AppHandle, enabled: bool) -> Result<McpSettingsView, String> {
    // 先持久化再动监听：写盘失败时旧服务继续运行，不会出现
    // 「命令报错、端口已关、设置仍是旧的」这种三不管状态。
    let (settings, _) = update_settings(&app, |settings| {
        settings.mcp.enabled = enabled;
        if enabled && settings.mcp.token.is_empty() {
            settings.mcp.token = generate_token()?;
        }
        Ok(())
    })?;
    let (runtime, generation) = take_runtime(&app).await;
    if let Some(runtime) = runtime {
        stop_runtime(runtime).await;
    }
    if enabled {
        start_and_record(&app, McpConfig::from(&settings.mcp), generation).await;
    }
    Ok(status(&app))
}

pub async fn set_port(app: AppHandle, port: u16) -> Result<McpSettingsView, String> {
    if !(1024..=65535).contains(&port) {
        return Err("MCP 端口需在 1024–65535 之间".to_string());
    }
    let (settings, _) = update_settings(&app, |settings| {
        settings.mcp.port = port;
        Ok(())
    })?;
    let (runtime, generation) = take_runtime(&app).await;
    if let Some(runtime) = runtime {
        stop_runtime(runtime).await;
    }
    if settings.mcp.enabled {
        start_and_record(&app, McpConfig::from(&settings.mcp), generation).await;
    }
    Ok(status(&app))
}

pub fn set_expose_text(app: AppHandle, expose_text: bool) -> Result<McpSettingsView, String> {
    update_settings(&app, |settings| {
        settings.mcp.expose_text = expose_text;
        Ok(())
    })?;
    Ok(status(&app))
}

pub async fn reset_token(app: AppHandle) -> Result<McpSettingsView, String> {
    let (settings, _) = update_settings(&app, |settings| {
        settings.mcp.token = generate_token()?;
        Ok(())
    })?;
    let (runtime, generation) = take_runtime(&app).await;
    if let Some(runtime) = runtime {
        stop_runtime(runtime).await;
    }
    if settings.mcp.enabled {
        start_and_record(&app, McpConfig::from(&settings.mcp), generation).await;
    }
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_is_64_hex_characters() {
        let token = generate_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn config_json_contains_the_endpoint() {
        let value = config_json("http://127.0.0.1:8765/mcp/abc");
        assert!(value.contains("mcpServers"));
        assert!(value.contains("http://127.0.0.1:8765/mcp/abc"));
    }

    #[tokio::test]
    async fn stop_runtime_cancels_and_joins() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        let cancel = CancellationToken::new();
        let child = cancel.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_child = stopped.clone();
        let task = tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(async move {
            child.cancelled().await;
            stopped_child.store(true, Ordering::SeqCst);
        }));
        let (shutdown, receiver) = oneshot::channel();
        let runtime = McpRuntime {
            port: 0,
            shutdown: Some(shutdown),
            cancel,
            task,
        };

        stop_runtime(runtime).await;
        drop(receiver);
        assert!(stopped.load(Ordering::SeqCst));
    }
}
