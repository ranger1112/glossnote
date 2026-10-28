#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod db;
mod fsrs;
mod library;
mod models;
mod settings;
mod state;

use crate::{
    models::{
        AiAnswer, AiSettingsInput, AiSettingsView, Annotation, CardView, Document,
        DocumentMetaPatch, ImportResult, PageTextInput, ScanReport, SearchHit,
    },
    state::AppState,
};
use std::{
    fs,
    sync::{Mutex, RwLock},
};
use tauri::{AppHandle, Manager};

/// 启动时的恢复提示只给用户看一次。
#[tauri::command(async)]
fn startup_notice(app: AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let mut slot = state
        .startup_notice
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    slot.take()
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

#[tauri::command(async)]
fn save_progress(app: AppHandle, doc_id: String, last_page: u32) -> Result<(), String> {
    library::save_progress(&app, &doc_id, last_page)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
fn list_documents(app: AppHandle) -> Result<Vec<Document>, String> {
    library::list_documents(&app)
}

#[tauri::command(async)]
fn upsert_annotation(app: AppHandle, doc_id: String, annotation: Annotation) -> Result<(), String> {
    library::upsert_annotation(&app, &doc_id, annotation)
}

#[tauri::command(async)]
fn delete_annotation(app: AppHandle, doc_id: String, id: String) -> Result<(), String> {
    library::delete_annotation(&app, &doc_id, &id)
}

#[tauri::command(async)]
fn list_cards(app: AppHandle) -> Result<Vec<CardView>, String> {
    library::cards(&app)
}

#[tauri::command(async)]
fn create_card(
    app: AppHandle,
    doc_id: String,
    annotation_id: String,
    title: String,
    body: String,
    links: Vec<String>,
) -> Result<CardView, String> {
    library::create_card(&app, &doc_id, &annotation_id, title, body, links)
}

#[tauri::command(async)]
fn update_card(
    app: AppHandle,
    card_id: String,
    title: String,
    body: String,
    links: Vec<String>,
) -> Result<CardView, String> {
    library::update_card(&app, &card_id, title, body, links)
}

#[tauri::command(async)]
fn delete_card(app: AppHandle, card_id: String) -> Result<(), String> {
    library::delete_card(&app, &card_id)
}

#[tauri::command(async)]
fn review_card(app: AppHandle, card_id: String, rating: u8) -> Result<CardView, String> {
    library::review_card(&app, &card_id, rating)
}

#[tauri::command(async)]
fn ai_settings(app: AppHandle) -> AiSettingsView {
    ai::get_settings(&app)
}

#[tauri::command(async)]
fn save_ai_settings(app: AppHandle, settings: AiSettingsInput) -> Result<AiSettingsView, String> {
    ai::save_settings(&app, settings)
}

#[tauri::command]
async fn test_ai(app: AppHandle) -> Result<String, String> {
    ai::test(&app).await
}

#[tauri::command]
async fn index_document_text(
    app: AppHandle,
    doc_id: String,
    pages: Vec<PageTextInput>,
) -> Result<usize, String> {
    // 整本书切块 + 两万条插入：放到阻塞线程池，别占着异步运行时。
    tauri::async_runtime::spawn_blocking(move || ai::index_document_text(&app, &doc_id, pages))
        .await
        .map_err(|error| format!("全文索引任务失败：{error}"))?
}

#[tauri::command(async)]
fn document_index_status(app: AppHandle, doc_id: String) -> Result<bool, String> {
    ai::index_status(&app, &doc_id)
}

#[tauri::command]
async fn ai_explain(
    app: AppHandle,
    doc_id: String,
    page: u32,
    quote: String,
    context: String,
) -> Result<AiAnswer, String> {
    ai::explain(&app, &doc_id, page, quote, context).await
}

#[tauri::command]
async fn ai_answer(app: AppHandle, doc_id: String, question: String) -> Result<AiAnswer, String> {
    ai::answer(&app, &doc_id, question).await
}

#[tauri::command]
async fn ai_summarize(
    app: AppHandle,
    doc_id: String,
    annotations_only: bool,
) -> Result<AiAnswer, String> {
    ai::summarize(&app, &doc_id, annotations_only).await
}

#[tauri::command(async)]
fn update_document_meta(
    app: AppHandle,
    doc_id: String,
    patch: DocumentMetaPatch,
) -> Result<Document, String> {
    library::update_meta(&app, &doc_id, patch)
}

fn main() {
    tauri::Builder::default()
        // 单实例要最先注册：第二个进程在碰数据库和 sidecar 之前就退出。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // 更新检查由用户点击触发；应用默认仍然不联网。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let app_data = handle
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            fs::create_dir_all(&app_data).map_err(std::io::Error::other)?;

            // 先读设置（坏文件会被改名留档），再解析书库目录。
            let (_, settings_backup) = settings::load_reporting(&handle);
            let (connection, db_backup, db_degraded) =
                match db::open_recovering(&app_data.join("library.db")) {
                    Ok((conn, backup)) => (conn, backup, None),
                    // 坏库已经救不回来（权限、磁盘错误）：用内存库先把这次会话跑起来。
                    Err(error) => (
                        db::open_memory().map_err(std::io::Error::other)?,
                        None,
                        Some(error),
                    ),
                };
            let library_root = library::resolve_root(&handle).map_err(std::io::Error::other)?;
            library::ensure_dirs(&library_root).map_err(std::io::Error::other)?;

            let mut notice = String::new();
            if let Some(error) = &db_degraded {
                notice.push_str(&format!(
                    "索引文件无法打开（{error}），本次使用临时索引。PDF 与标注不受影响；释放占用或修复权限后重启即可恢复阅读进度。"
                ));
            }
            if let Some(path) = &db_backup {
                if !notice.is_empty() {
                    notice.push('\n');
                }
                notice.push_str(&format!(
                    "书库索引已损坏，旧文件备份为 {}。本次从书库目录里的标注文件重建，内容不会丢。",
                    path.display()
                ));
            }
            if let Some(path) = &settings_backup {
                if !notice.is_empty() {
                    notice.push('\n');
                }
                notice.push_str(&format!(
                    "设置文件无法解析，已备份为 {}，书库位置与 AI 配置回到默认值。",
                    path.display()
                ));
            }

            handle.manage(AppState {
                db: Mutex::new(connection),
                library_root: RwLock::new(library_root),
                startup_notice: Mutex::new((!notice.is_empty()).then_some(notice)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_notice,
            scan_library,
            set_library_root,
            import_pdf,
            open_document,
            save_cover,
            save_progress,
            search_annotations,
            export_markdown,
            list_documents,
            upsert_annotation,
            delete_annotation,
            list_cards,
            create_card,
            update_card,
            delete_card,
            review_card,
            ai_settings,
            save_ai_settings,
            test_ai,
            index_document_text,
            document_index_status,
            ai_explain,
            ai_answer,
            ai_summarize,
            update_document_meta,
        ])
        .run(tauri::generate_context!())
        .expect("GlossNote 启动失败");
}
