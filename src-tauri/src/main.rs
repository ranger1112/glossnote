#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod library;
mod models;
mod state;

use crate::{
    models::{
        Annotation, Document, DocumentMetaPatch, ImportResult, LibraryInfo, ScanReport, SearchHit,
    },
    state::AppState,
};
use std::{
    fs,
    sync::{Mutex, RwLock},
};
use tauri::{AppHandle, Manager};

#[tauri::command]
fn library_info(app: AppHandle) -> Result<LibraryInfo, String> {
    library::info(&app)
}

#[tauri::command]
async fn scan_library(app: AppHandle) -> Result<ScanReport, String> {
    tauri::async_runtime::spawn_blocking(move || library::scan(&app))
        .await
        .map_err(|error| format!("书库扫描失败：{error}"))?
}

#[tauri::command]
async fn set_library_root(app: AppHandle, path: String) -> Result<ScanReport, String> {
    tauri::async_runtime::spawn_blocking(move || library::set_root(&app, &path))
        .await
        .map_err(|error| format!("切换书库失败：{error}"))?
}

#[tauri::command]
async fn import_pdf(app: AppHandle, path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || library::import_pdf(&app, &path))
        .await
        .map_err(|error| format!("导入任务失败：{error}"))?
}

#[tauri::command]
async fn open_document(app: AppHandle, doc_id: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || library::open_document(&app, &doc_id))
        .await
        .map_err(|error| format!("打开文档失败：{error}"))?
}

#[tauri::command]
async fn save_cover(app: AppHandle, doc_id: String, bytes: Vec<u8>) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || library::save_cover(&app, &doc_id, bytes))
        .await
        .map_err(|error| format!("封面任务失败：{error}"))?
}

#[tauri::command]
fn save_progress(app: AppHandle, doc_id: String, last_page: u32) -> Result<(), String> {
    library::save_progress(&app, &doc_id, last_page)
}

#[tauri::command]
fn search_annotations(app: AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    library::search(&app, query)
}

#[tauri::command]
async fn export_markdown(
    app: AppHandle,
    path: String,
    doc_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || library::export_markdown(&app, path, doc_id))
        .await
        .map_err(|error| format!("导出任务失败：{error}"))?
}

#[tauri::command]
fn last_document(app: AppHandle) -> Result<Option<ImportResult>, String> {
    library::last_document(&app)
}

#[tauri::command]
fn list_documents(app: AppHandle) -> Result<Vec<Document>, String> {
    library::list_documents(&app)
}

#[tauri::command]
fn list_annotations(app: AppHandle, doc_id: String) -> Result<Vec<Annotation>, String> {
    library::list_annotations(&app, &doc_id)
}

#[tauri::command]
fn upsert_annotation(app: AppHandle, doc_id: String, annotation: Annotation) -> Result<(), String> {
    library::upsert_annotation(&app, &doc_id, annotation)
}

#[tauri::command]
fn delete_annotation(app: AppHandle, doc_id: String, id: String) -> Result<(), String> {
    library::delete_annotation(&app, &doc_id, &id)
}

#[tauri::command]
fn update_document_meta(
    app: AppHandle,
    doc_id: String,
    patch: DocumentMetaPatch,
) -> Result<Document, String> {
    library::update_meta(&app, &doc_id, patch)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let app_data = handle
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            fs::create_dir_all(&app_data).map_err(std::io::Error::other)?;

            let connection =
                db::open(&app_data.join("library.db")).map_err(std::io::Error::other)?;
            let library_root = library::resolve_root(&handle).map_err(std::io::Error::other)?;
            library::ensure_dirs(&library_root).map_err(std::io::Error::other)?;

            handle.manage(AppState {
                db: Mutex::new(connection),
                library_root: RwLock::new(library_root),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_info,
            scan_library,
            set_library_root,
            import_pdf,
            open_document,
            save_cover,
            save_progress,
            search_annotations,
            export_markdown,
            last_document,
            list_documents,
            list_annotations,
            upsert_annotation,
            delete_annotation,
            update_document_meta,
        ])
        .run(tauri::generate_context!())
        .expect("GlossNote 启动失败");
}
