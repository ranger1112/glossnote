use serde::{Deserialize, Serialize};
use std::path::Path;

/// 数据库里的文档行：路径相对书库根目录，书库搬家后仍可重挂接。
#[derive(Clone, Debug)]
pub struct DocumentRow {
    pub id: String,
    pub name: String,
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub rel_path: String,
    pub size: u64,
    pub mtime: i64,
    pub added_at: i64,
    pub last_opened_at: i64,
    pub cover: String,
    pub last_page: u32,
    pub annotation_count: usize,
}

impl DocumentRow {
    pub fn to_document(&self, root: &Path) -> Document {
        let relative = self.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR);
        let cover = if self.cover.is_empty() {
            String::new()
        } else {
            root.join(self.cover.replace('/', std::path::MAIN_SEPARATOR_STR))
                .to_string_lossy()
                .into_owned()
        };

        Document {
            id: self.id.clone(),
            name: self.name.clone(),
            title: self.title.clone(),
            author: self.author.clone(),
            page_count: self.page_count,
            path: root.join(relative).to_string_lossy().into_owned(),
            cover,
            size: self.size,
            added_at: self.added_at,
            last_opened_at: self.last_opened_at,
            last_page: self.last_page,
            annotation_count: self.annotation_count,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub name: String,
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub path: String,
    pub cover: String,
    pub size: u64,
    pub added_at: i64,
    pub last_opened_at: i64,
    pub last_page: u32,
    pub annotation_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub page: u32,
    /// 锚定数据保持为 JSON，前端演进时 Rust 侧不需要跟着改结构。
    pub anchor: serde_json::Value,
    pub color: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

fn default_kind() -> String {
    "highlight".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetaPatch {
    pub page_count: Option<u32>,
    pub title: Option<String>,
    pub author: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub document: Document,
    pub annotations: Vec<Annotation>,
}

/// 每次扫描书库的结果，用来在界面上显示合并与冲突处理情况。
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub root: String,
    pub documents: usize,
    pub annotations: usize,
    /// 从 sidecar（含冲突副本）合并进数据库的标注条数。
    pub merged: usize,
    /// 合并后归档到 .glossnote/conflicts/ 的冲突副本数量。
    pub archived: usize,
    /// 内容重复、未重复索引的 PDF 数量。
    pub duplicate_pdfs: usize,
    /// 索引里存在、但文件已经不在书库目录的文档数量。
    pub missing_documents: usize,
    /// 无法解析或版本不认识的 sidecar 数量。
    pub ignored_sidecars: usize,
    /// 从 sidecar 合并进数据库的卡片数量。
    pub merged_cards: usize,
    pub scanned_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub source_annotation_id: Option<String>,
    #[serde(default)]
    pub source_doc_id: Option<String>,
    #[serde(default)]
    pub source_page: Option<u32>,
    #[serde(default)]
    pub links: Vec<String>,
    /// active / orphaned：来源标注被删除后卡片保留，但标记为来源失效。
    #[serde(default = "default_card_status")]
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub due_at: i64,
    #[serde(default)]
    pub stability: f64,
    #[serde(default)]
    pub difficulty: f64,
    #[serde(default)]
    pub reps: u32,
    #[serde(default)]
    pub lapses: u32,
    #[serde(default)]
    pub last_reviewed_at: i64,
    /// new / review
    #[serde(default = "default_card_state")]
    pub state: String,
    #[serde(default)]
    pub deleted: bool,
}

fn default_card_status() -> String {
    "active".to_string()
}

fn default_card_state() -> String {
    "new".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardRef {
    pub id: String,
    pub title: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RatingPreview {
    pub rating: u8,
    pub label: String,
    pub due_at: i64,
    pub interval_days: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardView {
    pub card: Card,
    pub doc_name: String,
    pub source_quote: String,
    pub backlinks: Vec<CardRef>,
    pub previews: Vec<RatingPreview>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub annotation_id: String,
    pub doc_id: String,
    pub doc_name: String,
    pub page: u32,
    pub quote: String,
    pub body: String,
    pub color: String,
    pub tags: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageTextInput {
    pub page: u32,
    #[serde(default)]
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsView {
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key_set: bool,
    pub ready: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_key: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiCitation {
    pub index: usize,
    pub page: Option<u32>,
    pub kind: String,
    pub label: String,
    pub snippet: String,
    pub annotation_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    pub text: String,
    pub citations: Vec<AiCitation>,
    pub model: String,
}

#[derive(Clone, Debug)]
pub struct Chunk {
    pub id: String,
    pub doc_id: String,
    pub page: u32,
    pub text: String,
}

/// 与 PDF 同目录书库里的可移植标注文件。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sidecar {
    pub schema_version: u32,
    pub doc_id: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub page_count: u32,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    /// 0.6 起随 sidecar 同步卡片；旧文件没有该字段时按空数组处理。
    #[serde(default)]
    pub cards: Vec<Card>,
}
