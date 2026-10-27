#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod library;
mod models;
mod state;

use crate::{
    models::{Annotation, Document, DocumentMetaPatch, ImportResult, LibraryInfo},
    state::AppState,
};
use std::{fs, sync::Mutex};
use tauri::{AppHandle, Manager};

#[tauri::command]
fn library_info(app: AppHandle) -> Result<LibraryInfo, String> {
    library::info(&app)
}

#[tauri::command]
async fn scan_library(app: AppHandle) -> Result<LibraryInfo, String> {
    tauri::async_runtime::spawn_blocking(move || library::scan(&app))
        .await
        .map_err(|error| format!("书库扫描失败：{error}"))?
}

#[tauri::command]
async fn import_pdf(app: AppHandle, path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || library::import_pdf(&app, &path))
        .await
        .map_err(|error| format!("导入任务失败：{error}"))?
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
                library_root,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_info,
            scan_library,
            import_pdf,
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
