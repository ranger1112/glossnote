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
}

impl DocumentRow {
    pub fn to_document(&self, root: &Path) -> Document {
        let relative = self.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR);
        Document {
            id: self.id.clone(),
            name: self.name.clone(),
            title: self.title.clone(),
            author: self.author.clone(),
            page_count: self.page_count,
            path: root.join(relative).to_string_lossy().into_owned(),
            size: self.size,
            added_at: self.added_at,
            last_opened_at: self.last_opened_at,
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
    pub size: u64,
    pub added_at: i64,
    pub last_opened_at: i64,
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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub root: String,
    pub documents: usize,
    pub annotations: usize,
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
}
