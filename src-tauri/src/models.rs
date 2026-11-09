use serde::{Deserialize, Serialize};
use std::path::Path;

/// 数据库里的文档行：路径相对书库根目录，书库搬家后仍可重挂接。
#[derive(Clone, Debug)]
pub struct DocumentRow {
    pub id: String,
    pub name: String,
    /// pdf / txt / html / epub；旧库没有该列时迁移补成 pdf。
    pub kind: String,
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub rel_path: String,
    pub size: u64,
    pub mtime: i64,
    pub added_at: i64,
    pub last_opened_at: i64,
    pub cover: String,
    /// pdf / text / native；空字符串表示旧库或尚未判定。
    pub cover_source: String,
    pub last_page: u32,
    pub favorite: bool,
    pub tags: Vec<String>,
    /// 页面书签；随 sidecar 做整表 LWW。
    pub bookmarks: Vec<Bookmark>,
    /// 虚拟文件夹名；空字符串表示「未分类」。不移动 books/ 里的 PDF。
    pub folder: String,
    /// 手动排序位置，只存在本机索引里，不写 sidecar。
    pub position: i64,
    /// 导入时的原始路径，仅本机使用：HTML 的相对图片按它解析；不写 sidecar。
    pub source_path: String,
    /// 网页剪藏的来源 URL，仅本机使用，不写 sidecar。
    pub source_url: String,
    /// 收藏、文档标签与文件夹的 LWW 时间戳，随 sidecar 同步。
    pub meta_updated_at: i64,
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
            kind: self.kind.clone(),
            title: self.title.clone(),
            author: self.author.clone(),
            page_count: self.page_count,
            path: root.join(relative).to_string_lossy().into_owned(),
            cover,
            cover_source: self.cover_source.clone(),
            size: self.size,
            added_at: self.added_at,
            last_opened_at: self.last_opened_at,
            last_page: self.last_page,
            favorite: self.favorite,
            tags: self.tags.clone(),
            bookmarks: self.bookmarks.clone(),
            folder: self.folder.clone(),
            position: self.position,
            source_path: self.source_path.clone(),
            source_url: self.source_url.clone(),
            annotation_count: self.annotation_count,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub name: String,
    /// pdf / txt / html / epub。
    pub kind: String,
    pub title: String,
    pub author: String,
    pub page_count: u32,
    pub path: String,
    pub cover: String,
    /// pdf / text / native；空字符串表示旧库或尚未判定。
    pub cover_source: String,
    pub size: u64,
    pub added_at: i64,
    pub last_opened_at: i64,
    pub last_page: u32,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub bookmarks: Vec<Bookmark>,
    pub folder: String,
    pub position: i64,
    /// 导入时的原始路径，仅本机使用。
    pub source_path: String,
    /// 网页剪藏的来源 URL，仅本机使用。
    pub source_url: String,
    pub annotation_count: usize,
}

/// 文档内的一页书签；标签由用户改，页码从 0 开始。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub page: u32,
    pub label: String,
    #[serde(default)]
    pub created_at: i64,
}

/// 书库里「智能收藏夹」：保存一组筛选条件，不复制文档，点开时动态匹配。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartCollection {
    pub id: String,
    pub name: String,
    /// 只显示收藏文档。
    #[serde(default)]
    pub favorite: bool,
    /// 文档必须带这个标签；空字符串表示不限标签。
    #[serde(default)]
    pub tag: String,
    /// None 表示不限文件夹；空字符串表示「未分类」。
    #[serde(default)]
    pub folder: Option<String>,
    /// 打开收藏夹时使用的排序：recent / added / title / annotations / manual。
    #[serde(default = "default_collection_sort")]
    pub sort: String,
}

fn default_collection_sort() -> String {
    "recent".to_string()
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

fn default_document_kind() -> String {
    "pdf".to_string()
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

/// AI 面板里的一轮对话，用来把追问的上下文带回模型。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
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

/// 全库正文搜索的一条命中；snippet 从原始页面文字里截取，不是索引词。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageHit {
    pub doc_id: String,
    pub doc_name: String,
    pub page: u32,
    pub snippet: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageIndexStatus {
    pub documents: usize,
    pub indexed_documents: usize,
    pub pages: usize,
    pub indexed_pages: usize,
}

/// 版本历史里的一份 sidecar 快照。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SidecarVersion {
    pub id: String,
    pub created_at: i64,
    pub annotations: usize,
    pub cards: usize,
    pub bookmarks: usize,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub folder: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
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
    /// 旧 sidecar 没有格式字段：缺省按 PDF 处理。
    #[serde(default = "default_document_kind")]
    pub kind: String,
    pub size: u64,
    #[serde(default)]
    pub page_count: u32,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    /// 0.6 起随 sidecar 同步卡片；旧文件没有该字段时按空数组处理。
    #[serde(default)]
    pub cards: Vec<Card>,
    /// 文档级组织信息（收藏、标签）；旧 sidecar 没有这些字段时按默认值处理。
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 旧 sidecar 没有书签字段：None 表示「没提供」，不覆盖本机书签。
    #[serde(default)]
    pub bookmarks: Option<Vec<Bookmark>>,
    /// 旧版 sidecar 没有该字段：None 表示「没提供」，合并时不要覆盖本机文件夹。
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub meta_updated_at: i64,
}

/// 批量删除的结果：文件进回收站，索引立即移除。
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub removed: usize,
    pub trashed_files: usize,
    pub missing_files: usize,
    /// 文件进不了回收站的文档；这些文档会保留在书库里。
    pub failed: Vec<String>,
}
