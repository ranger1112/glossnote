use super::mapping::{self, *};
use crate::{db, notes, state::AppState};
use rmcp::{
    handler::server::{
        router::tool::ToolRouter,
        wrapper::{Json, Parameters},
    },
    model::{CallToolResult, ContentBlock, ServerCapabilities, ServerConfig},
    schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::future::Future;
use tauri::{AppHandle, Manager};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;
const READ_TEXT_DEFAULT_PAGES: u32 = 10;
const READ_TEXT_MAX_PAGES: u32 = 50;
const READ_TEXT_DEFAULT_CHARS: usize = 20_000;
const READ_TEXT_MAX_CHARS: usize = 50_000;
const READ_TEXT_TOTAL_CHARS: usize = 200_000;
const TEXT_DISABLED: &str =
    "正文读取未开启。请在 GlossNote 设置 → MCP 中打开「允许读取正文」后重试。";
const TEXT_NOT_INDEXED: &str = "正文尚未索引。请在 GlossNote 书库中建立正文索引后重试。";

#[derive(Clone)]
pub struct GlossnoteServer {
    #[expect(dead_code, reason = "tool_handler macro accesses this router field")]
    tool_router: ToolRouter<Self>,
    app: AppHandle,
}

impl GlossnoteServer {
    pub fn new(app: AppHandle) -> Self {
        Self {
            tool_router: Self::tool_router(),
            app,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListDocumentsArgs {
    pub query: Option<String>,
    pub kind: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArgs {
    pub doc_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchAnnotationsArgs {
    pub query: String,
    pub doc_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListAnnotationsArgs {
    pub doc_id: String,
    pub page: Option<u32>,
    pub kind: Option<String>,
    pub color: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationArgs {
    pub doc_id: String,
    pub annotation_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchPagesArgs {
    pub query: String,
    pub doc_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentTextArgs {
    pub doc_id: String,
    pub page_start: Option<u32>,
    pub page_end: Option<u32>,
    pub max_chars: Option<usize>,
}

fn clamp_limit(value: Option<usize>) -> usize {
    match value {
        Some(limit) if limit > 0 => limit.min(MAX_LIMIT),
        _ => DEFAULT_LIMIT,
    }
}

fn validate_kind(kind: Option<String>) -> Result<Option<String>, String> {
    let Some(kind) = kind.map(|value| value.trim().to_lowercase()) else {
        return Ok(None);
    };
    if kind.is_empty() {
        return Ok(None);
    }
    if !matches!(kind.as_str(), "pdf" | "txt" | "html" | "epub") {
        return Err("kind 只支持 pdf、txt、html、epub".to_string());
    }
    Ok(Some(kind))
}

fn validate_annotation_kind(kind: Option<String>) -> Result<Option<String>, String> {
    let Some(kind) = kind.map(|value| value.trim().to_lowercase()) else {
        return Ok(None);
    };
    if kind.is_empty() {
        return Ok(None);
    }
    if !matches!(kind.as_str(), "highlight" | "underline" | "strikethrough") {
        return Err("标注 kind 只支持 highlight、underline、strikethrough".to_string());
    }
    Ok(Some(kind))
}

fn validate_color(color: Option<String>) -> Result<Option<String>, String> {
    let Some(color) = color.map(|value| value.trim().to_lowercase()) else {
        return Ok(None);
    };
    if color.is_empty() {
        return Ok(None);
    }
    if !matches!(color.as_str(), "yellow" | "green" | "blue" | "pink") {
        return Err("color 只支持 yellow、green、blue、pink".to_string());
    }
    Ok(Some(color))
}

fn with_connection<T>(
    app: &AppHandle,
    action: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&conn)
}

fn require_expose_text(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let slot = state
        .mcp
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.config.expose_text {
        Ok(())
    } else {
        Err(TEXT_DISABLED.to_string())
    }
}

pub fn list_documents(app: &AppHandle, args: ListDocumentsArgs) -> Result<DocumentList, String> {
    let limit = clamp_limit(args.limit);
    let offset = args.offset.unwrap_or(0);
    let kind = validate_kind(args.kind)?;
    let query = args.query.unwrap_or_default().trim().to_lowercase();

    with_connection(app, |conn| {
        let documents = db::list_documents(conn)?;
        let matched: Vec<_> = documents
            .into_iter()
            .filter(|document| {
                if let Some(kind) = &kind {
                    if &document.kind != kind {
                        return false;
                    }
                }
                if query.is_empty() {
                    return true;
                }
                document.name.to_lowercase().contains(&query)
                    || document.title.to_lowercase().contains(&query)
                    || document.author.to_lowercase().contains(&query)
            })
            .collect();
        let total = matched.len();
        let items = matched
            .iter()
            .skip(offset)
            .take(limit)
            .map(mapping::document_summary)
            .collect();
        Ok(DocumentList {
            items,
            total,
            limit,
            offset,
        })
    })
}

pub fn get_document(app: &AppHandle, args: DocumentArgs) -> Result<DocumentDetail, String> {
    with_connection(app, |conn| {
        let document = db::find_by_id(conn, &args.doc_id)?
            .ok_or_else(|| format!("文档不存在：{}", args.doc_id))?;
        Ok(mapping::document_detail(&document))
    })
}

pub fn search_annotations(
    app: &AppHandle,
    args: SearchAnnotationsArgs,
) -> Result<SearchAnnotationList, String> {
    let limit = clamp_limit(args.limit);
    let doc_id = args.doc_id.as_deref().filter(|value| !value.is_empty());
    with_connection(app, |conn| {
        let hits = db::search_annotations_filtered(conn, &args.query, doc_id, limit)?;
        Ok(SearchAnnotationList {
            items: hits.iter().map(mapping::search_hit_view).collect(),
            limit,
        })
    })
}

pub fn list_annotations(
    app: &AppHandle,
    args: ListAnnotationsArgs,
) -> Result<AnnotationList, String> {
    let limit = clamp_limit(args.limit);
    let kind = validate_annotation_kind(args.kind)?;
    let color = validate_color(args.color)?;
    with_connection(app, |conn| {
        db::find_by_id(conn, &args.doc_id)?
            .ok_or_else(|| format!("文档不存在：{}", args.doc_id))?;
        let annotations = db::list_annotations(conn, &args.doc_id)?;
        let matched: Vec<_> = annotations
            .into_iter()
            .filter(|annotation| !annotation.deleted)
            .filter(|annotation| {
                args.page
                    .map(|page| annotation.page.saturating_add(1) == page)
                    .unwrap_or(true)
            })
            .filter(|annotation| {
                kind.as_ref()
                    .map(|kind| &annotation.kind == kind)
                    .unwrap_or(true)
            })
            .filter(|annotation| {
                color
                    .as_ref()
                    .map(|color| &annotation.color == color)
                    .unwrap_or(true)
            })
            .collect();
        let total = matched.len();
        let items = matched
            .into_iter()
            .take(limit)
            .map(|annotation| mapping::annotation_view(&args.doc_id, &annotation))
            .collect();
        Ok(AnnotationList {
            items,
            total,
            limit,
        })
    })
}

pub fn get_annotation(app: &AppHandle, args: AnnotationArgs) -> Result<AnnotationView, String> {
    with_connection(app, |conn| {
        let annotation = db::get_annotation_in_doc(conn, &args.doc_id, &args.annotation_id)?
            .ok_or_else(|| "标注不存在或已删除".to_string())?;
        Ok(mapping::annotation_view(&args.doc_id, &annotation))
    })
}

pub fn search_pages(app: &AppHandle, args: SearchPagesArgs) -> Result<PageSearchList, String> {
    require_expose_text(app)?;
    let limit = clamp_limit(args.limit);
    let doc_id = args.doc_id.as_deref().filter(|value| !value.is_empty());
    with_connection(app, |conn| {
        let hits = db::search_pages_filtered(conn, &args.query, doc_id, limit)?;
        Ok(PageSearchList {
            items: hits.iter().map(mapping::page_hit_view).collect(),
            limit,
        })
    })
}

pub fn read_document_text(
    app: &AppHandle,
    args: ReadDocumentTextArgs,
) -> Result<DocumentText, String> {
    require_expose_text(app)?;
    let max_chars = match args.max_chars {
        Some(value) if value > 0 => value.min(READ_TEXT_MAX_CHARS),
        _ => READ_TEXT_DEFAULT_CHARS,
    };

    with_connection(app, |conn| {
        let document = db::find_by_id(conn, &args.doc_id)?
            .ok_or_else(|| format!("文档不存在：{}", args.doc_id))?;
        let page_count = if document.page_count > 0 {
            document.page_count
        } else {
            db::page_texts_max_page(conn, &document.id)?
                .map(|page| page.saturating_add(1))
                .unwrap_or(0)
        };
        if page_count == 0 {
            return Err(TEXT_NOT_INDEXED.to_string());
        }

        let start = args.page_start.unwrap_or(1).max(1);
        if start > page_count {
            return Err(format!("pageStart 超出文档页数（共 {page_count} 页）"));
        }
        let end = args
            .page_end
            .unwrap_or_else(|| start.saturating_add(READ_TEXT_DEFAULT_PAGES - 1))
            .min(page_count);
        if end < start {
            return Err("pageEnd 不能小于 pageStart".to_string());
        }
        if end - start + 1 > READ_TEXT_MAX_PAGES {
            return Err(format!("单次最多读取 {READ_TEXT_MAX_PAGES} 页"));
        }

        let rows = db::page_texts_range(conn, &document.id, start - 1, end - 1)?;
        if rows.is_empty() {
            return Err(TEXT_NOT_INDEXED.to_string());
        }
        let texts: HashMap<u32, String> = rows
            .into_iter()
            .map(|(page, text)| (page.saturating_add(1), text))
            .collect();

        let mut pages = Vec::new();
        let mut used_chars = 0usize;
        let mut truncated = false;
        let mut next_page = None;

        for page in start..=end {
            let remaining = READ_TEXT_TOTAL_CHARS.saturating_sub(used_chars);
            if remaining == 0 {
                truncated = true;
                next_page = Some(page);
                break;
            }
            let text = texts.get(&page).cloned().unwrap_or_default();
            let (chunk, cut) = take_chars(&text, max_chars.min(remaining));
            used_chars += chunk.chars().count();
            pages.push(PageText {
                page,
                text: chunk,
                truncated: cut,
            });
            if cut {
                truncated = true;
                next_page = (page < end).then_some(page.saturating_add(1));
                break;
            }
        }

        Ok(DocumentText {
            doc_id: document.id,
            page_count,
            page_start: start,
            page_end: end,
            pages,
            truncated,
            next_page,
        })
    })
}

pub fn get_notes(app: &AppHandle, args: DocumentArgs) -> Result<NoteView, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let doc_id = with_connection(app, |conn| {
        db::find_by_id(conn, &args.doc_id)?
            .map(|document| document.id)
            .ok_or_else(|| format!("文档不存在：{}", args.doc_id))
    })?;
    let note = notes::read_note(&root, &doc_id)?;
    Ok(NoteView {
        exists: !note.revision.is_empty(),
        doc_id,
        text: note.text,
        updated_at: note.updated_at,
        revision: note.revision,
    })
}

pub fn library_resource(app: &AppHandle) -> Result<LibrarySummary, String> {
    let state = app.state::<AppState>();
    let expose_text = state
        .mcp
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .config
        .expose_text;
    with_connection(app, |conn| {
        let documents = db::list_documents(conn)?;
        let annotations = db::count_annotations(conn)?;
        Ok(mapping::library_summary(
            &documents,
            annotations,
            expose_text,
        ))
    })
}

pub fn document_resource(app: &AppHandle, doc_id: &str) -> Result<DocumentDetail, String> {
    get_document(
        app,
        DocumentArgs {
            doc_id: doc_id.to_string(),
        },
    )
}

pub fn recent_resource_documents(
    app: &AppHandle,
    limit: usize,
) -> Result<Vec<crate::models::DocumentRow>, String> {
    with_connection(app, |conn| {
        let mut documents = db::list_documents(conn)?;
        documents.truncate(limit);
        Ok(documents)
    })
}

fn take_chars(text: &str, limit: usize) -> (String, bool) {
    if limit == 0 {
        return (String::new(), !text.is_empty());
    }
    let mut out = String::new();
    for (index, character) in text.chars().enumerate() {
        if index >= limit {
            return (out, true);
        }
        out.push(character);
    }
    (out, false)
}

async fn run<T, F>(app: AppHandle, task: F) -> Result<Json<T>, CallToolResult>
where
    T: serde::Serialize + schemars::JsonSchema + Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(move || task(&app)).await {
        Ok(Ok(value)) => Ok(Json(value)),
        Ok(Err(error)) => Err(tool_error(error)),
        Err(error) => Err(tool_error(format!("工具执行失败：{error}"))),
    }
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message.into())])
}

#[tool_router]
impl GlossnoteServer {
    #[tool(
        description = "List indexed documents. Supports a case-insensitive name/title/author query and optional kind filter."
    )]
    async fn list_documents(
        &self,
        Parameters(args): Parameters<ListDocumentsArgs>,
    ) -> Result<Json<DocumentList>, CallToolResult> {
        run(self.app.clone(), move |app| list_documents(app, args)).await
    }

    #[tool(
        description = "Get one document's metadata, tags, folder, bookmarks and reading position."
    )]
    async fn get_document(
        &self,
        Parameters(args): Parameters<DocumentArgs>,
    ) -> Result<Json<DocumentDetail>, CallToolResult> {
        run(self.app.clone(), move |app| get_document(app, args)).await
    }

    #[tool(
        description = "Search annotations by quote, note body, tags, document name or title. Returns annotation ids for get_annotation."
    )]
    async fn search_annotations(
        &self,
        Parameters(args): Parameters<SearchAnnotationsArgs>,
    ) -> Result<Json<SearchAnnotationList>, CallToolResult> {
        run(self.app.clone(), move |app| search_annotations(app, args)).await
    }

    #[tool(
        description = "List annotations in one document, optionally filtered by page, kind and color."
    )]
    async fn list_annotations(
        &self,
        Parameters(args): Parameters<ListAnnotationsArgs>,
    ) -> Result<Json<AnnotationList>, CallToolResult> {
        run(self.app.clone(), move |app| list_annotations(app, args)).await
    }

    #[tool(description = "Get a single annotation by document id and annotation id.")]
    async fn get_annotation(
        &self,
        Parameters(args): Parameters<AnnotationArgs>,
    ) -> Result<Json<AnnotationView>, CallToolResult> {
        run(self.app.clone(), move |app| get_annotation(app, args)).await
    }

    #[tool(
        description = "Search indexed page text. Requires the user to enable text exposure in GlossNote settings."
    )]
    async fn search_pages(
        &self,
        Parameters(args): Parameters<SearchPagesArgs>,
    ) -> Result<Json<PageSearchList>, CallToolResult> {
        run(self.app.clone(), move |app| search_pages(app, args)).await
    }

    #[tool(
        description = "Read indexed page text in a bounded page range. Requires the user to enable text exposure in GlossNote settings."
    )]
    async fn read_document_text(
        &self,
        Parameters(args): Parameters<ReadDocumentTextArgs>,
    ) -> Result<Json<DocumentText>, CallToolResult> {
        run(self.app.clone(), move |app| read_document_text(app, args)).await
    }

    #[tool(description = "Read the document's Markdown note, revision and updated time.")]
    async fn get_notes(
        &self,
        Parameters(args): Parameters<DocumentArgs>,
    ) -> Result<Json<NoteView>, CallToolResult> {
        run(self.app.clone(), move |app| get_notes(app, args)).await
    }
}

#[tool_handler]
impl ServerHandler for GlossnoteServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "glossnote",
            env!("CARGO_PKG_VERSION"),
        ))
        .with_instructions(
            "GlossNote local reading library. Read-only access to documents, annotations and notes. \
             Page numbers are 1-based. Page text tools require explicit user opt-in.",
        )
    }

    fn list_resources(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> impl Future<Output = Result<rmcp::model::ListResourcesResult, ErrorData>> + Send + '_ {
        let app = self.app.clone();
        async move {
            let documents =
                tauri::async_runtime::spawn_blocking(move || recent_resource_documents(&app, 20))
                    .await
                    .map_err(|error| {
                        ErrorData::internal_error(format!("读取资源失败：{error}"), None)
                    })?
                    .map_err(|error| ErrorData::internal_error(error, None))?;

            let mut resources = vec![rmcp::model::Resource::new("glossnote://library", "library")
                .with_title("GlossNote library summary")
                .with_description("Document counts, annotation counts and text exposure state")
                .with_mime_type("application/json")];
            for document in documents {
                let uri = format!("glossnote://doc/{}", document.id);
                let title = if document.title.trim().is_empty() {
                    document.name.clone()
                } else {
                    document.title.clone()
                };
                resources.push(
                    rmcp::model::Resource::new(uri, document.id)
                        .with_title(title)
                        .with_description("Document metadata and bookmarks")
                        .with_mime_type("application/json"),
                );
            }
            Ok(rmcp::model::ListResourcesResult::with_all_items(resources))
        }
    }

    fn read_resource(
        &self,
        request: rmcp::model::ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> impl Future<Output = Result<rmcp::model::ReadResourceResponse, ErrorData>> + Send + '_
    {
        let app = self.app.clone();
        async move {
            let uri = request.uri;
            let text = if uri == "glossnote://library" {
                let summary = tauri::async_runtime::spawn_blocking(move || library_resource(&app))
                    .await
                    .map_err(|error| {
                        ErrorData::internal_error(format!("读取资源失败：{error}"), None)
                    })?
                    .map_err(|error| ErrorData::internal_error(error, None))?;
                serde_json::to_string(&summary).map_err(|error| {
                    ErrorData::internal_error(format!("序列化资源失败：{error}"), None)
                })?
            } else if let Some(doc_id) = uri.strip_prefix("glossnote://doc/") {
                let doc_id = doc_id.to_string();
                let detail =
                    tauri::async_runtime::spawn_blocking(move || document_resource(&app, &doc_id))
                        .await
                        .map_err(|error| {
                            ErrorData::internal_error(format!("读取资源失败：{error}"), None)
                        })?
                        .map_err(|error| ErrorData::internal_error(error, None))?;
                serde_json::to_string(&detail).map_err(|error| {
                    ErrorData::internal_error(format!("序列化资源失败：{error}"), None)
                })?
            } else {
                return Err(ErrorData::resource_not_found(
                    format!("未知资源：{uri}"),
                    None,
                ));
            };
            Ok(
                rmcp::model::ReadResourceResult::new(vec![rmcp::model::ResourceContents::text(
                    text, uri,
                )
                .with_mime_type("application/json")])
                .into(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_default_and_clamp() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(10)), 10);
        assert_eq!(clamp_limit(Some(10_000)), MAX_LIMIT);
    }

    #[test]
    fn text_is_cut_by_characters_not_bytes() {
        let (text, cut) = take_chars("你好世界", 2);
        assert_eq!(text, "你好");
        assert!(cut);
        let (text, cut) = take_chars("abc", 10);
        assert_eq!(text, "abc");
        assert!(!cut);
        let (text, cut) = take_chars("", 0);
        assert_eq!(text, "");
        assert!(!cut);
    }

    #[test]
    fn filters_reject_unknown_values() {
        assert_eq!(
            validate_kind(Some("PDF".into())).unwrap().as_deref(),
            Some("pdf")
        );
        assert!(validate_kind(Some("docx".into())).is_err());
        assert!(validate_annotation_kind(Some("area".into())).is_err());
        assert!(validate_color(Some("orange".into())).is_err());
    }
}
