#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod db;
mod fsrs;
mod library;
mod mcp;
mod models;
mod notes;
mod pdf_export;
mod search;
mod settings;
mod state;
mod webclip;

use crate::{
    models::{
        AiAnswer, AiSettingsInput, AiSettingsView, Annotation, Bookmark, CardView, ChatTurn,
        DeleteReport, Document, DocumentMetaPatch, ImportResult, NoteHit, PageHit, PageIndexStatus,
        PageTextInput, ScanReport, SearchHit, SidecarVersion, SmartCollection,
    },
    state::AppState,
};
use serde::Serialize;
use std::{
    collections::HashMap,
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
async fn import_document(app: AppHandle, path: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || library::import_document(&app, &path))
        .await
        .map_err(|error| format!("导入任务失败：{error}"))?
}

#[tauri::command]
async fn read_document_text(app: AppHandle, doc_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || library::read_document_text(&app, &doc_id))
        .await
        .map_err(|error| format!("读取文档失败：{error}"))?
}

#[tauri::command]
async fn fetch_web_page(url: String) -> Result<webclip::FetchedWebPage, String> {
    webclip::fetch_web_page(url).await
}

#[tauri::command]
async fn download_web_assets(urls: Vec<String>) -> Result<Vec<webclip::DownloadedAsset>, String> {
    webclip::download_web_assets(urls).await
}

#[tauri::command]
async fn import_html_snapshot(
    app: AppHandle,
    input: library::HtmlSnapshotInput,
) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || library::import_html_snapshot(&app, input))
        .await
        .map_err(|error| format!("保存网页快照失败：{error}"))?
}

#[tauri::command]
async fn open_document(app: AppHandle, doc_id: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || library::open_document(&app, &doc_id))
        .await
        .map_err(|error| format!("打开文档失败：{error}"))?
}

#[tauri::command]
async fn save_cover(
    app: AppHandle,
    doc_id: String,
    bytes: Vec<u8>,
    source: String,
) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || library::save_cover(&app, &doc_id, bytes, source))
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
async fn export_annotated_pdf(
    app: AppHandle,
    doc_id: String,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || library::export_pdf(&app, &doc_id, &path))
        .await
        .map_err(|error| format!("导出 PDF 任务失败：{error}"))?
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

#[tauri::command]
async fn upsert_annotations(
    app: AppHandle,
    doc_id: String,
    annotations: Vec<Annotation>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::upsert_annotations(&app, &doc_id, &annotations)
    })
    .await
    .map_err(|error| format!("导入标注任务失败：{error}"))?
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
#[allow(clippy::too_many_arguments)]
async fn ai_followup(
    app: AppHandle,
    doc_id: String,
    mode: String,
    page: Option<u32>,
    quote: String,
    context: String,
    question: String,
    history: Vec<ChatTurn>,
) -> Result<AiAnswer, String> {
    ai::followup(&app, &doc_id, mode, page, quote, context, question, history).await
}

#[tauri::command]
async fn ai_summarize(
    app: AppHandle,
    doc_id: String,
    annotations_only: bool,
) -> Result<AiAnswer, String> {
    ai::summarize(&app, &doc_id, annotations_only).await
}

#[tauri::command]
async fn ai_explain_stream(
    app: AppHandle,
    request_id: String,
    doc_id: String,
    page: u32,
    quote: String,
    context: String,
) -> Result<AiAnswer, String> {
    ai::explain_stream(&app, &request_id, &doc_id, page, quote, context).await
}

#[tauri::command]
async fn ai_answer_stream(
    app: AppHandle,
    request_id: String,
    doc_id: String,
    question: String,
) -> Result<AiAnswer, String> {
    ai::answer_stream(&app, &request_id, &doc_id, question).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ai_followup_stream(
    app: AppHandle,
    request_id: String,
    doc_id: String,
    mode: String,
    page: Option<u32>,
    quote: String,
    context: String,
    question: String,
    history: Vec<ChatTurn>,
) -> Result<AiAnswer, String> {
    ai::followup_stream(
        &app,
        &request_id,
        &doc_id,
        mode,
        page,
        quote,
        context,
        question,
        history,
    )
    .await
}

#[tauri::command]
async fn ai_summarize_stream(
    app: AppHandle,
    request_id: String,
    doc_id: String,
    annotations_only: bool,
) -> Result<AiAnswer, String> {
    ai::summarize_stream(&app, &request_id, &doc_id, annotations_only).await
}

#[tauri::command(async)]
fn update_document_meta(
    app: AppHandle,
    doc_id: String,
    patch: DocumentMetaPatch,
) -> Result<Document, String> {
    library::update_meta(&app, &doc_id, patch)
}

#[tauri::command]
fn library_root(app: AppHandle) -> Result<String, String> {
    Ok(app
        .state::<AppState>()
        .root()
        .to_string_lossy()
        .into_owned())
}

#[tauri::command(async)]
fn load_page_texts(app: AppHandle, doc_id: String) -> Result<Vec<PageTextInput>, String> {
    library::load_page_texts(&app, &doc_id)
}

#[tauri::command(async)]
fn save_page_texts(
    app: AppHandle,
    doc_id: String,
    pages: Vec<PageTextInput>,
) -> Result<usize, String> {
    library::save_page_texts(&app, &doc_id, pages)
}

#[tauri::command(async)]
fn page_texts_ready(app: AppHandle, doc_id: String, page_count: u32) -> Result<bool, String> {
    library::page_texts_ready(&app, &doc_id, page_count)
}

#[tauri::command(async)]
fn prune_page_texts(app: AppHandle, doc_id: String, page_count: u32) -> Result<usize, String> {
    library::prune_page_texts(&app, &doc_id, page_count)
}

#[tauri::command(async)]
fn organize_document(
    app: AppHandle,
    doc_id: String,
    favorite: Option<bool>,
    tags: Option<Vec<String>>,
    folder: Option<String>,
) -> Result<Document, String> {
    library::organize_document(&app, &doc_id, favorite, tags, folder)
}

#[tauri::command(async)]
fn organize_documents(
    app: AppHandle,
    doc_ids: Vec<String>,
    favorite: Option<bool>,
    add_tags: Vec<String>,
    remove_tags: Vec<String>,
    folder: Option<String>,
) -> Result<Vec<Document>, String> {
    library::organize_documents(&app, doc_ids, favorite, add_tags, remove_tags, folder)
}

#[tauri::command(async)]
fn delete_documents(app: AppHandle, doc_ids: Vec<String>) -> Result<DeleteReport, String> {
    library::delete_documents(&app, doc_ids)
}

#[tauri::command(async)]
fn reorder_documents(app: AppHandle, doc_ids: Vec<String>) -> Result<Vec<Document>, String> {
    library::reorder_documents(&app, doc_ids)
}

#[tauri::command(async)]
fn list_folders(app: AppHandle) -> Vec<String> {
    library::list_folders(&app)
}

#[tauri::command(async)]
fn save_folders(app: AppHandle, folders: Vec<String>) -> Result<Vec<String>, String> {
    library::save_folders(&app, folders)
}

#[tauri::command(async)]
fn list_smart_collections(app: AppHandle) -> Vec<SmartCollection> {
    library::list_smart_collections(&app)
}

#[tauri::command(async)]
fn save_smart_collections(
    app: AppHandle,
    collections: Vec<SmartCollection>,
) -> Result<Vec<SmartCollection>, String> {
    library::save_smart_collections(&app, collections)
}

#[tauri::command(async)]
fn search_pages(app: AppHandle, query: String) -> Result<Vec<PageHit>, String> {
    library::search_pages(&app, query)
}

#[tauri::command(async)]
fn page_index_status(app: AppHandle) -> Result<PageIndexStatus, String> {
    library::page_index_status(&app)
}

#[tauri::command(async)]
fn search_notes(app: AppHandle, query: String) -> Result<Vec<NoteHit>, String> {
    library::search_notes(&app, query)
}

#[tauri::command]
async fn read_document_note(app: AppHandle, doc_id: String) -> Result<notes::NoteFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let root = state.root();
        {
            let conn = state
                .db
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if db::find_by_id(&conn, &doc_id)?.is_none() {
                return Err(format!("文档不存在：{doc_id}"));
            }
        }
        notes::read_note(&root, &doc_id)
    })
    .await
    .map_err(|error| format!("读取笔记任务失败：{error}"))?
}

#[tauri::command]
async fn save_document_note(
    app: AppHandle,
    doc_id: String,
    text: String,
    expected_revision: String,
) -> Result<notes::NoteSaveOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let root = state.root();
        {
            let conn = state
                .db
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if db::find_by_id(&conn, &doc_id)?.is_none() {
                return Err(format!("文档不存在：{doc_id}"));
            }
        }
        let _guard = state
            .note_write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        notes::save_note(&root, &doc_id, &text, &expected_revision)
    })
    .await
    .map_err(|error| format!("保存笔记任务失败：{error}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteAnnotationTarget {
    doc_id: String,
    /// 0 基，供阅读器直接跳页。
    page: u32,
    quote: String,
    color: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteDocumentTarget {
    title: String,
    name: String,
    page_count: u32,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteLinkTargets {
    annotations: HashMap<String, NoteAnnotationTarget>,
    documents: HashMap<String, NoteDocumentTarget>,
}

#[tauri::command(async)]
fn resolve_note_links(
    app: AppHandle,
    annotation_ids: Vec<String>,
    doc_ids: Vec<String>,
) -> Result<NoteLinkTargets, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut annotations = HashMap::new();
    for id in annotation_ids.into_iter().take(200) {
        if let Some((doc_id, annotation)) = db::get_annotation_with_doc(&conn, &id)? {
            let quote = annotation
                .anchor
                .get("quote")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            annotations.insert(
                id,
                NoteAnnotationTarget {
                    doc_id,
                    page: annotation.page,
                    quote,
                    color: annotation.color,
                    kind: annotation.kind,
                },
            );
        }
    }

    let mut documents = HashMap::new();
    for id in doc_ids.into_iter().take(200) {
        if let Some(document) = db::find_by_id(&conn, &id)? {
            documents.insert(
                id,
                NoteDocumentTarget {
                    title: document.title,
                    name: document.name,
                    page_count: document.page_count,
                    kind: document.kind,
                },
            );
        }
    }

    Ok(NoteLinkTargets {
        annotations,
        documents,
    })
}

#[tauri::command(async)]
fn mcp_status(app: AppHandle) -> mcp::McpSettingsView {
    mcp::status(&app)
}

#[tauri::command]
async fn mcp_set_enabled(app: AppHandle, enabled: bool) -> Result<mcp::McpSettingsView, String> {
    mcp::set_enabled(app, enabled).await
}

#[tauri::command]
async fn mcp_set_port(app: AppHandle, port: u16) -> Result<mcp::McpSettingsView, String> {
    mcp::set_port(app, port).await
}

#[tauri::command]
async fn mcp_set_expose_text(
    app: AppHandle,
    expose_text: bool,
) -> Result<mcp::McpSettingsView, String> {
    mcp::set_expose_text(app, expose_text)
}

#[tauri::command]
async fn mcp_reset_token(app: AppHandle) -> Result<mcp::McpSettingsView, String> {
    mcp::reset_token(app).await
}

#[tauri::command(async)]
fn save_bookmarks(
    app: AppHandle,
    doc_id: String,
    bookmarks: Vec<Bookmark>,
) -> Result<Document, String> {
    library::save_bookmarks(&app, &doc_id, bookmarks)
}

#[tauri::command(async)]
fn list_sidecar_versions(app: AppHandle, doc_id: String) -> Result<Vec<SidecarVersion>, String> {
    library::list_sidecar_versions(&app, &doc_id)
}

#[tauri::command(async)]
fn restore_sidecar_version(
    app: AppHandle,
    doc_id: String,
    version_id: String,
) -> Result<ImportResult, String> {
    library::restore_sidecar_version(&app, &doc_id, &version_id)
}

/// 默认窗口是 1280×860 逻辑像素；在 125%/150% 缩放的小屏笔记本上，
/// 外框会高过屏幕工作区，底部（例如 AI 追问输入框）被任务栏裁掉。
/// 启动时把窗口收缩并挪回工作区内，已有窗口能放下就不动。
fn fit_window_to_work_area(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let work = *monitor.work_area();
    let outer = window.outer_size()?;

    if outer.width > work.size.width || outer.height > work.size.height {
        let inner = window.inner_size()?;
        let decoration_width = outer.width.saturating_sub(inner.width);
        let decoration_height = outer.height.saturating_sub(inner.height);
        let max_inner_width = work.size.width.saturating_sub(decoration_width);
        let max_inner_height = work.size.height.saturating_sub(decoration_height);

        window.set_size(tauri::PhysicalSize::new(
            inner.width.min(max_inner_width),
            inner.height.min(max_inner_height),
        ))?;
    }

    // 收缩后窗口仍可能贴着屏幕外，按工作区四边再校正一次位置。
    let outer = window.outer_size()?;
    let position = window.outer_position()?;
    let max_x =
        (work.position.x + work.size.width as i32 - outer.width as i32).max(work.position.x);
    let max_y =
        (work.position.y + work.size.height as i32 - outer.height as i32).max(work.position.y);
    let x = position.x.clamp(work.position.x, max_x);
    let y = position.y.clamp(work.position.y, max_y);
    if x != position.x || y != position.y {
        window.set_position(tauri::PhysicalPosition::new(x, y))?;
    }

    Ok(())
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
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = fit_window_to_work_area(&window) {
                    eprintln!("调整窗口到屏幕工作区失败：{error}");
                }
            }

            let handle = app.handle().clone();
            let app_data = settings::app_data_dir(&handle)
                .map_err(std::io::Error::other)?;
            fs::create_dir_all(&app_data).map_err(std::io::Error::other)?;

            // 先读设置（坏文件会被改名留档），再解析书库目录。
            let (settings, settings_backup) = settings::load_reporting(&handle);
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

            let mcp_state = mcp::McpState::from_settings(&settings.mcp);
            let mcp_enabled = settings.mcp.enabled;
            handle.manage(AppState {
                db: Mutex::new(connection),
                library_root: RwLock::new(library_root),
                startup_notice: Mutex::new((!notice.is_empty()).then_some(notice)),
                mcp: Mutex::new(mcp_state),
                note_write: Mutex::new(()),
            });
            if mcp_enabled {
                mcp::spawn_start(handle.clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_notice,
            scan_library,
            set_library_root,
            import_document,
            read_document_text,
            fetch_web_page,
            download_web_assets,
            import_html_snapshot,
            open_document,
            save_cover,
            save_progress,
            search_annotations,
            export_annotated_pdf,
            export_markdown,
            list_documents,
            upsert_annotation,
            upsert_annotations,
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
            ai_followup,
            ai_summarize,
            ai_explain_stream,
            ai_answer_stream,
            ai_followup_stream,
            ai_summarize_stream,
            update_document_meta,
            library_root,
            load_page_texts,
            save_page_texts,
            page_texts_ready,
            prune_page_texts,
            organize_document,
            organize_documents,
            delete_documents,
            reorder_documents,
            list_folders,
            save_folders,
            list_smart_collections,
            save_smart_collections,
            search_pages,
            page_index_status,
            search_notes,
            read_document_note,
            save_document_note,
            resolve_note_links,
            mcp_status,
            mcp_set_enabled,
            mcp_set_port,
            mcp_set_expose_text,
            mcp_reset_token,
            save_bookmarks,
            list_sidecar_versions,
            restore_sidecar_version,
        ])
        .run(tauri::generate_context!())
        .expect("GlossNote 启动失败");
}
