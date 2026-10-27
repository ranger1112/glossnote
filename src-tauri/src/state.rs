use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{Mutex, RwLock},
};

pub struct AppState {
    pub db: Mutex<Connection>,
    /// 书库目录可以在运行时切换，所以用 RwLock 而不是固定的 PathBuf。
    pub library_root: RwLock<PathBuf>,
}

impl AppState {
    pub fn root(&self) -> PathBuf {
        self.library_root
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}
