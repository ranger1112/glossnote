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
}

impl AppState {
    pub fn root(&self) -> PathBuf {
        self.library_root
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}
