use rusqlite::Connection;
use std::{path::PathBuf, sync::Mutex};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub library_root: PathBuf,
}
