use crate::models::{Annotation, Bookmark, DocumentRow, PageHit, SearchHit};
use rmcp::schemars::{self, JsonSchema};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub annotation_count: usize,
    pub last_page: u32,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkView {
    pub page: u32,
    pub label: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDetail {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub annotation_count: usize,
    pub last_page: u32,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub folder: String,
    pub bookmarks: Vec<BookmarkView>,
    pub source_url: String,
    pub added_at: i64,
    pub last_opened_at: i64,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentList {
    pub items: Vec<DocumentSummary>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationView {
    pub id: String,
    pub doc_id: String,
    pub page: u32,
    pub quote: String,
    pub body: String,
    pub color: String,
    pub kind: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationList {
    pub items: Vec<AnnotationView>,
    pub total: usize,
    pub limit: usize,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchAnnotationList {
    pub items: Vec<AnnotationView>,
    pub limit: usize,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageSearchView {
    pub doc_id: String,
    pub doc_name: String,
    pub page: u32,
    pub snippet: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageSearchList {
    pub items: Vec<PageSearchView>,
    pub limit: usize,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub page: u32,
    pub text: String,
    pub truncated: bool,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub doc_id: String,
    pub page_count: u32,
    pub page_start: u32,
    pub page_end: u32,
    pub pages: Vec<PageText>,
    pub truncated: bool,
    pub next_page: Option<u32>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    pub doc_id: String,
    pub text: String,
    pub updated_at: i64,
    pub revision: String,
    pub exists: bool,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KindCount {
    pub kind: String,
    pub count: usize,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub documents: usize,
    pub annotations: usize,
    pub documents_by_kind: Vec<KindCount>,
    pub expose_text: bool,
    pub generated_at: i64,
}

pub fn quote_of(annotation: &Annotation) -> String {
    annotation
        .anchor
        .get("quote")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn document_summary(row: &DocumentRow) -> DocumentSummary {
    DocumentSummary {
        id: row.id.clone(),
        name: row.name.clone(),
        kind: row.kind.clone(),
        title: row.title.clone(),
        author: row.author.clone(),
        page_count: row.page_count,
        annotation_count: row.annotation_count,
        last_page: row.last_page.saturating_add(1),
    }
}

pub fn document_detail(row: &DocumentRow) -> DocumentDetail {
    DocumentDetail {
        id: row.id.clone(),
        name: row.name.clone(),
        kind: row.kind.clone(),
        title: row.title.clone(),
        author: row.author.clone(),
        page_count: row.page_count,
        annotation_count: row.annotation_count,
        last_page: row.last_page.saturating_add(1),
        favorite: row.favorite,
        tags: row.tags.clone(),
        folder: row.folder.clone(),
        bookmarks: row.bookmarks.iter().map(bookmark_view).collect(),
        source_url: if row.source_url.starts_with("http://")
            || row.source_url.starts_with("https://")
        {
            row.source_url.clone()
        } else {
            String::new()
        },
        added_at: row.added_at,
        last_opened_at: row.last_opened_at,
    }
}

pub fn bookmark_view(bookmark: &Bookmark) -> BookmarkView {
    BookmarkView {
        page: bookmark.page.saturating_add(1),
        label: bookmark.label.clone(),
    }
}

pub fn annotation_view(doc_id: &str, annotation: &Annotation) -> AnnotationView {
    AnnotationView {
        id: annotation.id.clone(),
        doc_id: doc_id.to_string(),
        page: annotation.page.saturating_add(1),
        quote: quote_of(annotation),
        body: annotation.body.clone(),
        color: annotation.color.clone(),
        kind: annotation.kind.clone(),
        tags: annotation.tags.clone(),
        created_at: annotation.created_at,
        updated_at: annotation.updated_at,
    }
}

pub fn search_hit_view(hit: &SearchHit) -> AnnotationView {
    AnnotationView {
        id: hit.annotation_id.clone(),
        doc_id: hit.doc_id.clone(),
        page: hit.page.saturating_add(1),
        quote: hit.quote.clone(),
        body: hit.body.clone(),
        color: hit.color.clone(),
        kind: hit.kind.clone(),
        tags: hit.tags.clone(),
        created_at: hit.created_at,
        updated_at: hit.updated_at,
    }
}

pub fn page_hit_view(hit: &PageHit) -> PageSearchView {
    PageSearchView {
        doc_id: hit.doc_id.clone(),
        doc_name: hit.doc_name.clone(),
        page: hit.page.saturating_add(1),
        snippet: truncate_chars(&hit.snippet, 240),
    }
}

pub fn library_summary(
    documents: &[DocumentRow],
    annotations: usize,
    expose_text: bool,
) -> LibrarySummary {
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for document in documents {
        *counts.entry(document.kind.clone()).or_insert(0) += 1;
    }
    LibrarySummary {
        documents: documents.len(),
        annotations,
        documents_by_kind: counts
            .into_iter()
            .map(|(kind, count)| KindCount { kind, count })
            .collect(),
        expose_text,
        generated_at: now_ms(),
    }
}

pub fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
