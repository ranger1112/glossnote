use crate::mcp::McpState;
use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{Mutex, RwLock},
};

pub struct AppState {
    pub db: Mutex<Connection>,
    /// 书库目录可以在运行时切换，所以用 RwLock 而不是固定的 PathBuf。
    pub library_root: RwLock<PathBuf>,
    /// 启动时的恢复提示（坏库重建、设置回退），由前端取走一次后清空。
    pub startup_notice: Mutex<Option<String>>,
    /// MCP 开关、端口、token 与运行中的监听任务。
    pub mcp: Mutex<McpState>,
    /// 笔记保存串行化，避免两个防抖请求同时通过 revision 检查。
    pub note_write: Mutex<()>,
    /// settings.json 的 MCP 读改写串行化，避免并发命令互相覆盖。
    pub settings_write: Mutex<()>,
}

impl AppState {
    pub fn root(&self) -> PathBuf {
        self.library_root
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}
