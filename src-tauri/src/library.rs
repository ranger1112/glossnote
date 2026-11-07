use crate::{
    db,
    fsrs::{self, MemoryState},
    models::{
        Annotation, Bookmark, Card, CardView, DeleteReport, Document, DocumentMetaPatch,
        DocumentRow, ImportResult, PageHit, PageIndexStatus, PageTextInput, ScanReport, SearchHit,
        Sidecar, SidecarVersion, SmartCollection,
    },
    settings,
    state::AppState,
};
use chrono::Local;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_DOCUMENT_BYTES: u64 = 200 * 1024 * 1024;
/// 文本会整份读进前端内存，限制比 PDF 更保守。
const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EPUB_BYTES: u64 = 50 * 1024 * 1024;
const SUPPORTED_EXTENSIONS: [&str; 5] = ["pdf", "txt", "html", "htm", "epub"];
const SIDECAR_VERSION: u32 = 1;

pub fn resolve_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = settings::load(app)
        .library_dir
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(PathBuf::from(dir));
    }

    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("定位文档目录失败：{error}"))?;
    Ok(documents.join("GlossNote"))
}

pub fn ensure_dirs(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("books")).map_err(|error| format!("创建书库目录失败：{error}"))?;
    fs::create_dir_all(root.join(".glossnote").join("annotations"))
        .map_err(|error| format!("创建标注目录失败：{error}"))?;
    Ok(())
}

/// 切换书库目录：校验可写、写设置、清空旧索引，再扫描新目录。
pub fn set_root(app: &AppHandle, path: &str) -> Result<ScanReport, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("书库目录不能为空".to_string());
    }

    let root = PathBuf::from(trimmed);
    fs::create_dir_all(&root).map_err(|error| format!("创建书库目录失败：{error}"))?;
    ensure_dirs(&root)?;

    let probe = root
        .join(".glossnote")
        .join(format!(".write-test-{}", process::id()));
    fs::write(&probe, b"ok").map_err(|error| format!("书库目录不可写：{error}"))?;
    let _ = fs::remove_file(&probe);

    let mut app_settings = settings::load(app);
    app_settings.library_dir = Some(root.to_string_lossy().into_owned());
    // 空文件夹属于旧书库；新书库的文件夹会从文档与 sidecar 重新并出来。
    app_settings.folders.clear();
    settings::save(app, &app_settings)?;

    {
        let state = app.state::<AppState>();
        *state
            .library_root
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = root;
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        db::clear_library(&conn)?;
    }

    scan(app)
}

pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("打开 PDF 失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取 PDF 失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 支持的文档格式；返回 None 表示不认识的扩展名。
fn document_kind(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => Some("pdf"),
        Some(extension) if extension.eq_ignore_ascii_case("txt") => Some("txt"),
        Some(extension)
            if extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm") =>
        {
            Some("html")
        }
        Some(extension) if extension.eq_ignore_ascii_case("epub") => Some("epub"),
        _ => None,
    }
}

fn is_supported_document(path: &Path) -> bool {
    document_kind(path).is_some()
}

fn safe_name(original: &str) -> String {
    let mut name: String = original
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();

    name = name.trim().trim_end_matches('.').to_string();
    if name.is_empty() {
        name = "document.pdf".to_string();
    }
    // 保留支持的扩展名；没写扩展名时沿用旧行为补 .pdf。
    let lower = name.to_lowercase();
    let supported = SUPPORTED_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(&format!(".{extension}")));
    if !supported {
        name.push_str(".pdf");
    }
    name
}

fn unique_dest(books: &Path, name: &str, hash: &str) -> PathBuf {
    let candidate = books.join(name);
    if !candidate.exists() || hash_file(&candidate).ok().as_deref() == Some(hash) {
        return candidate;
    }

    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pdf");
    for index in 2..1000 {
        let candidate = books.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() || hash_file(&candidate).ok().as_deref() == Some(hash) {
            return candidate;
        }
    }

    books.join(format!("{stem}-{hash}.{extension}"))
}

fn copy_atomic(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let temp = destination.with_extension(format!("pdf.tmp-{}", process::id()));
    fs::copy(source, &temp).map_err(|error| format!("复制 PDF 失败：{error}"))?;
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::remove_file(destination);
        fs::rename(&temp, destination).map_err(|_| format!("保存 PDF 失败：{error}"))?;
    }
    Ok(())
}

fn sidecar_path(root: &Path, doc_id: &str) -> PathBuf {
    root.join(".glossnote")
        .join("annotations")
        .join(format!("{doc_id}.json"))
}

type SidecarEntry = (PathBuf, Sidecar);

#[derive(Default)]
struct MergeStats {
    merged: usize,
    merged_cards: usize,
    archived: usize,
    ignored: usize,
}

/// 读一个 sidecar；无法读取、JSON 无效或 docId 为空时返回 None。
fn read_sidecar(path: &Path) -> Option<Sidecar> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("跳过无法读取的 sidecar {}：{error}", path.display());
            return None;
        }
    };
    match serde_json::from_str::<Sidecar>(&text) {
        Ok(sidecar) if !sidecar.doc_id.trim().is_empty() => Some(sidecar),
        Ok(_) => None,
        Err(error) => {
            eprintln!("跳过无效的 sidecar {}：{error}", path.display());
            None
        }
    }
}

/// 标注目录里的所有 JSON 都可能是别的设备/云盘生成的冲突副本，
/// 因此按文件里的 docId 分组，而不是只认 `<docId>.json`。
fn load_sidecars(root: &Path) -> Result<(HashMap<String, Vec<SidecarEntry>>, usize), String> {
    let directory = root.join(".glossnote").join("annotations");
    let mut groups: HashMap<String, Vec<SidecarEntry>> = HashMap::new();
    let mut ignored = 0;

    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(_) if !directory.exists() => return Ok((groups, ignored)),
        Err(error) => return Err(format!("读取标注目录失败：{error}")),
    };

    for entry in entries {
        let entry = entry.map_err(|error| format!("读取标注条目失败：{error}"))?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let Some(sidecar) = read_sidecar(&path) else {
            ignored += 1;
            continue;
        };

        groups
            .entry(sidecar.doc_id.clone())
            .or_default()
            .push((path, sidecar));
    }

    for entries in groups.values_mut() {
        entries.sort_by(|left, right| left.0.cmp(&right.0));
    }

    Ok((groups, ignored))
}

/// 单文档合并只读与它相关的文件：规范文件与云盘冲突副本都以 docId 开头。
/// 打开/导入因此不再扫描整个标注目录；名字被改过的 sidecar 由全库扫描兜底。
fn load_sidecars_for(root: &Path, doc_id: &str) -> Result<(Vec<SidecarEntry>, usize), String> {
    let directory = root.join(".glossnote").join("annotations");
    let mut files = Vec::new();
    let mut ignored = 0;

    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(_) if !directory.exists() => return Ok((files, ignored)),
        Err(error) => return Err(format!("读取标注目录失败：{error}")),
    };

    for entry in entries {
        let entry = entry.map_err(|error| format!("读取标注条目失败：{error}"))?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !name.starts_with(doc_id) {
            continue;
        }

        let Some(sidecar) = read_sidecar(&path) else {
            ignored += 1;
            continue;
        };
        // 文件名匹配不代表内容匹配；只合并内部 docId 一致的文件。
        if sidecar.doc_id == doc_id {
            files.push((path, sidecar));
        }
    }

    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok((files, ignored))
}

fn is_canonical(path: &Path, doc_id: &str) -> bool {
    path.file_name().and_then(|value| value.to_str()) == Some(&format!("{doc_id}.json"))
}

fn archive_sidecar(root: &Path, path: &Path) -> Result<(), String> {
    let directory = root.join(".glossnote").join("conflicts");
    fs::create_dir_all(&directory).map_err(|error| format!("创建冲突归档目录失败：{error}"))?;

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "冲突文件名无效".to_string())?;
    let mut destination = directory.join(name);
    if destination.exists() {
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("sidecar");
        destination = directory.join(format!("{stem}.{}.json", now_ms()));
    }

    fs::rename(path, &destination).map_err(|error| format!("归档冲突副本失败：{error}"))
}

fn apply_sidecar(
    conn: &rusqlite::Connection,
    document: &mut DocumentRow,
    sidecar: &Sidecar,
    page_count: &mut u32,
    merged: &mut usize,
    merged_cards: &mut usize,
) -> Result<(), String> {
    if *page_count == 0 && sidecar.page_count > 0 {
        *page_count = sidecar.page_count;
        db::update_meta(conn, &document.id, Some(sidecar.page_count), None, None)?;
    }

    // 收藏/标签/书签/文件夹按时间戳做 LWW；旧 sidecar 没有的字段不会覆盖本机设置。
    if sidecar.meta_updated_at > document.meta_updated_at {
        document.favorite = sidecar.favorite;
        document.tags = sidecar.tags.clone();
        if let Some(bookmarks) = &sidecar.bookmarks {
            document.bookmarks = bookmarks.clone();
        }
        // 旧版应用写 sidecar 时没有 folder 字段，不能把已有的文件夹清空。
        if let Some(folder) = &sidecar.folder {
            document.folder = folder.clone();
        }
        document.meta_updated_at = sidecar.meta_updated_at;
        db::update_organization(
            conn,
            &document.id,
            Some(document.favorite),
            Some(&document.tags),
            Some(&document.folder),
            Some(&document.bookmarks),
            document.meta_updated_at,
        )?;
    }

    for annotation in &sidecar.annotations {
        let keep_database = db::get_annotation(conn, &annotation.id)?
            .map(|existing| existing.updated_at >= annotation.updated_at)
            .unwrap_or(false);
        if !keep_database {
            db::upsert_annotation(conn, &document.id, annotation)?;
            *merged += 1;
        }
    }

    for card in &sidecar.cards {
        // 卡片只跟随来源文档的 sidecar，避免错误文件把卡片挪到别的文档。
        if card.source_doc_id.as_deref() != Some(document.id.as_str()) {
            continue;
        }
        let keep_database = db::get_card(conn, &card.id)?
            .map(|existing| existing.updated_at >= card.updated_at)
            .unwrap_or(false);
        if !keep_database {
            db::upsert_card(conn, card)?;
            *merged_cards += 1;
        }
    }

    Ok(())
}

/// 合并该文档的所有 sidecar：规范文件优先赢得同时间戳的平局，
/// 合并后回写规范文件，再把冲突副本移出标注目录。
fn reconcile_document(
    conn: &rusqlite::Connection,
    root: &Path,
    document: &mut DocumentRow,
    files: &[SidecarEntry],
    stats: &mut MergeStats,
) -> Result<Vec<Annotation>, String> {
    let mut page_count = document.page_count;
    let mut ordered: Vec<&SidecarEntry> = files.iter().collect();
    ordered.sort_by_key(|(path, _)| {
        if is_canonical(path, &document.id) {
            0
        } else {
            1
        }
    });

    for (_, sidecar) in &ordered {
        if sidecar.schema_version != SIDECAR_VERSION {
            stats.ignored += 1;
            continue;
        }
        apply_sidecar(
            conn,
            document,
            sidecar,
            &mut page_count,
            &mut stats.merged,
            &mut stats.merged_cards,
        )?;
    }

    db::orphan_cards_for_document(conn, &document.id, now_ms())?;
    // 合并结果没变就不要碰文件：扫描和打开文档都会走到这里，
    // 每次重写会让云盘客户端把整座书库当成“已修改”。
    write_sidecar(conn, root, &document.id)?;

    for (path, sidecar) in &ordered {
        if is_canonical(path, &document.id) || sidecar.schema_version != SIDECAR_VERSION {
            continue;
        }
        match archive_sidecar(root, path) {
            Ok(()) => stats.archived += 1,
            Err(error) => eprintln!("{error}"),
        }
    }

    db::list_annotations(conn, &document.id)
}

/// 单文档场景（导入/打开）：合并调用方在锁外读到的 sidecar，并归档冲突副本。
fn merge_document(
    conn: &rusqlite::Connection,
    root: &Path,
    document: &mut DocumentRow,
    files: Vec<SidecarEntry>,
    ignored: usize,
) -> Result<Vec<Annotation>, String> {
    let mut stats = MergeStats {
        ignored,
        ..Default::default()
    };
    reconcile_document(conn, root, document, &files, &mut stats)
}

fn serialized_sidecar(conn: &rusqlite::Connection, doc_id: &str) -> Result<Vec<u8>, String> {
    let document = db::find_by_id(conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    let annotations = db::list_annotations(conn, doc_id)?;
    let cards = db::list_cards_for_document(conn, doc_id)?;
    let sidecar = Sidecar {
        schema_version: SIDECAR_VERSION,
        doc_id: document.id.clone(),
        name: document.name.clone(),
        kind: document.kind.clone(),
        size: document.size,
        page_count: document.page_count,
        annotations,
        cards,
        favorite: document.favorite,
        tags: document.tags.clone(),
        bookmarks: Some(document.bookmarks.clone()),
        folder: Some(document.folder.clone()),
        meta_updated_at: document.meta_updated_at,
    };

    let bytes =
        serde_json::to_vec_pretty(&sidecar).map_err(|error| format!("序列化标注失败：{error}"))?;
    Ok(bytes)
}

const HISTORY_VERSIONS: usize = 30;

fn history_dir(root: &Path, doc_id: &str) -> PathBuf {
    root.join(".glossnote").join("history").join(doc_id)
}

/// 覆盖 sidecar 之前把旧内容留一份；文件名用毫秒时间戳，同毫秒追加序号。
fn snapshot_sidecar(root: &Path, doc_id: &str, previous: &[u8]) -> Result<(), String> {
    let directory = history_dir(root, doc_id);
    fs::create_dir_all(&directory).map_err(|error| format!("创建版本目录失败：{error}"))?;

    // 固定宽度的序号保证同一毫秒内的多份快照也能按文件名正确排序。
    let stamp = now_ms();
    let mut suffix = 0u32;
    let path = loop {
        let candidate = directory.join(format!("{stamp}-{suffix:04}.json"));
        if !candidate.exists() {
            break candidate;
        }
        suffix += 1;
    };
    fs::write(&path, previous).map_err(|error| format!("保存标注历史失败：{error}"))?;

    prune_history(&directory);
    Ok(())
}

fn prune_history(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    // 文件名是「毫秒时间戳-四位序号」，按名字倒序就是新到旧。
    files.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for path in files.into_iter().skip(HISTORY_VERSIONS) {
        let _ = fs::remove_file(path);
    }
}

fn write_sidecar_bytes(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or_else(|| "标注路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建标注目录失败：{error}"))?;

    if let Ok(existing) = fs::read(path) {
        // 内容没变就不碰文件：否则云盘客户端会把每次启动都当成一次修改。
        if existing == bytes {
            return Ok(());
        }
        let doc_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("sidecar");
        if let Err(error) = snapshot_sidecar(root, doc_id, &existing) {
            // 历史版本是附加保护，不能因为它失败而丢当前标注。
            eprintln!("保存标注历史失败：{error}");
        }
    }

    let temp = directory.join(format!(
        "{}.json.tmp-{}-{}",
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("sidecar"),
        process::id(),
        now_ms()
    ));
    fs::write(&temp, bytes).map_err(|error| format!("写入标注失败：{error}"))?;

    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(path);
        fs::rename(&temp, path).map_err(|_| format!("保存标注失败：{error}"))?;
    }
    Ok(())
}

/// 扫描/打开文档时会走一遍合并，即使什么都没变也会被调到这里。
/// 内容相同就在 `write_sidecar_bytes` 里直接跳过，不产生历史版本。
pub fn write_sidecar(conn: &rusqlite::Connection, root: &Path, doc_id: &str) -> Result<(), String> {
    let bytes = serialized_sidecar(conn, doc_id)?;
    write_sidecar_bytes(root, &sidecar_path(root, doc_id), &bytes)
}

pub fn import_document(app: &AppHandle, source: &str) -> Result<ImportResult, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    ensure_dirs(&root)?;

    let source = PathBuf::from(source);
    let kind = document_kind(&source)
        .ok_or_else(|| "只支持 PDF、TXT、HTML 与 EPUB 文件".to_string())?
        .to_string();
    let metadata = fs::metadata(&source).map_err(|error| format!("读取文件信息失败：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件".to_string());
    }
    let (limit, too_large) = match kind.as_str() {
        "pdf" => (
            MAX_DOCUMENT_BYTES,
            "文件超过 200 MB，请先压缩或拆分后再导入",
        ),
        "epub" => (MAX_EPUB_BYTES, "EPUB 超过 50 MB，请先压缩图片后再导入"),
        _ => (MAX_TEXT_BYTES, "文本文件超过 20 MB，请先拆分后再导入"),
    };
    if metadata.len() > limit {
        return Err(too_large.to_string());
    }

    let id = hash_file(&source)?;
    let now = now_ms();

    // 查重只占一次短锁；复制大文件在锁外做，否则导入期间所有数据库请求都会被堵住。
    let existing = {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        db::find_by_id(&conn, &id)?
    };

    if let Some(existing) = existing {
        let destination = root.join(&existing.rel_path);
        if !destination.exists() {
            copy_atomic(&source, &destination)?;
        }
        // sidecar 读取是文件 I/O，放在锁外；只读与本文档相关的文件。
        let (files, ignored) = load_sidecars_for(&root, &id)?;
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        db::touch_document(&conn, &id, now)?;
        let mut document = db::find_by_id(&conn, &id)?.ok_or_else(|| "文档不存在".to_string())?;
        let annotations = merge_document(&conn, &root, &mut document, files, ignored)?;
        let document = db::find_by_id(&conn, &id)?.unwrap_or(document);
        return Ok(ImportResult {
            document: document.to_document(&root),
            annotations,
        });
    }

    let original_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let name = safe_name(original_name);
    let books = root.join("books");
    let destination = unique_dest(&books, &name, &id);
    if !destination.exists() {
        copy_atomic(&source, &destination)?;
    }

    let relative = destination
        .strip_prefix(&root)
        .map_err(|_| "无法计算书库相对路径".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let file_metadata =
        fs::metadata(&destination).map_err(|error| format!("读取书库文件失败：{error}"))?;
    let document_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document")
        .to_string();

    let mut row = DocumentRow {
        id: id.clone(),
        name: document_name,
        kind,
        title: String::new(),
        author: String::new(),
        page_count: 0,
        rel_path: relative,
        size: file_metadata.len(),
        mtime: mtime_ms(&file_metadata),
        added_at: now,
        last_opened_at: now,
        cover: String::new(),
        last_page: 0,
        favorite: false,
        tags: Vec::new(),
        bookmarks: Vec::new(),
        folder: String::new(),
        // 新导入的文档排在手动排序的最后；之后重排会写成 0..N。
        position: now,
        meta_updated_at: 0,
        annotation_count: 0,
    };
    let (files, ignored) = load_sidecars_for(&root, &id)?;
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::upsert_document(&conn, &row)?;

    let annotations = merge_document(&conn, &root, &mut row, files, ignored)?;
    let document = db::find_by_id(&conn, &id)?.unwrap_or(row);

    Ok(ImportResult {
        document: document.to_document(&root),
        annotations,
    })
}

pub fn scan(app: &AppHandle) -> Result<ScanReport, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    ensure_dirs(&root)?;

    let (mut sidecar_groups, ignored_sidecars) = load_sidecars(&root)?;
    let mut stats = MergeStats {
        ignored: ignored_sidecars,
        ..Default::default()
    };

    let books = root.join("books");
    let mut entries = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();
    for entry in fs::read_dir(&books).map_err(|error| format!("读取书库失败：{error}"))? {
        let entry = entry.map_err(|error| format!("读取书库条目失败：{error}"))?;
        let path = entry.path();
        if !path.is_file() || !is_supported_document(&path) {
            continue;
        }
        let metadata = fs::metadata(&path).map_err(|error| format!("读取书库文件失败：{error}"))?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| "无法计算书库相对路径".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        seen_paths.insert(relative.clone());
        entries.push((path, relative, metadata.len(), mtime_ms(&metadata)));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));

    // 只短暂持锁读一次索引，把哈希放到锁外：大 PDF 的哈希是秒级操作，
    // 不该在扫描期间挡住保存进度、写入标注这些请求。
    let known: HashMap<String, DocumentRow> = {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        db::list_documents(&conn)?
            .into_iter()
            .map(|row| (row.rel_path.clone(), row))
            .collect()
    };

    let mut resolved = Vec::with_capacity(entries.len());
    for (path, relative, size, mtime) in entries {
        let by_path = known.get(&relative).cloned();
        // 路径、大小、修改时间都没变就沿用旧哈希，否则重新计算。
        let id = match &by_path {
            Some(row) if row.size == size && row.mtime == mtime => row.id.clone(),
            _ => hash_file(&path)?,
        };
        resolved.push((path, relative, size, mtime, id, by_path));
    }

    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    let mut seen = std::collections::HashSet::new();
    let mut duplicate_pdfs = 0;

    for (path, relative, size, mtime, id, by_path) in resolved {
        if !seen.insert(id.clone()) {
            duplicate_pdfs += 1;
            continue;
        }

        if let Some(stale) = &by_path {
            if stale.id != id {
                db::remove_document(&conn, &stale.id, now)?;
            }
        }

        let prior = db::find_by_id(&conn, &id)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document.pdf")
            .to_string();
        let cover = prior
            .as_ref()
            .map(|row| row.cover.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                let relative = format!(".glossnote/thumbnails/{id}.jpg");
                root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .exists()
                    .then_some(relative)
            })
            .unwrap_or_default();
        let mut row = DocumentRow {
            id: id.clone(),
            name,
            kind: prior
                .as_ref()
                .map(|row| row.kind.clone())
                .or_else(|| document_kind(&path).map(str::to_string))
                .unwrap_or_else(|| "pdf".to_string()),
            title: prior
                .as_ref()
                .map(|row| row.title.clone())
                .unwrap_or_default(),
            author: prior
                .as_ref()
                .map(|row| row.author.clone())
                .unwrap_or_default(),
            page_count: prior.as_ref().map(|row| row.page_count).unwrap_or(0),
            rel_path: relative,
            size,
            mtime,
            added_at: prior.as_ref().map(|row| row.added_at).unwrap_or(now),
            last_opened_at: prior.as_ref().map(|row| row.last_opened_at).unwrap_or(0),
            cover,
            last_page: prior.as_ref().map(|row| row.last_page).unwrap_or(0),
            favorite: prior.as_ref().map(|row| row.favorite).unwrap_or(false),
            tags: prior
                .as_ref()
                .map(|row| row.tags.clone())
                .unwrap_or_default(),
            bookmarks: prior
                .as_ref()
                .map(|row| row.bookmarks.clone())
                .unwrap_or_default(),
            folder: prior
                .as_ref()
                .map(|row| row.folder.clone())
                .unwrap_or_default(),
            position: prior.as_ref().map(|row| row.position).unwrap_or(now),
            meta_updated_at: prior.as_ref().map(|row| row.meta_updated_at).unwrap_or(0),
            annotation_count: 0,
        };

        db::upsert_document(&conn, &row)?;
        let files = sidecar_groups.remove(&id).unwrap_or_default();
        reconcile_document(&conn, &root, &mut row, &files, &mut stats)?;
    }

    let (documents, annotations) = db::counts(&conn)?;
    // 文件被删除或还没同步下来的文档：索引保留，但不再显示成幽灵卡片。
    let missing_documents = db::list_documents(&conn)?
        .iter()
        .filter(|row| !seen_paths.contains(&row.rel_path))
        .count();
    Ok(ScanReport {
        root: root.to_string_lossy().into_owned(),
        documents,
        annotations,
        missing_documents,
        merged: stats.merged,
        merged_cards: stats.merged_cards,
        archived: stats.archived,
        duplicate_pdfs,
        ignored_sidecars: stats.ignored,
        scanned_at: now_ms(),
    })
}

pub fn list_documents(app: &AppHandle) -> Result<Vec<Document>, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 文件不在磁盘上时不要返回：点开只会报“文档文件不存在”。
    // 云端把文件同步回来之后，下一次扫描会重新挂上，标注都还在。
    Ok(db::list_documents(&conn)?
        .iter()
        .filter(|row| {
            root.join(row.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR))
                .exists()
        })
        .map(|row| row.to_document(&root))
        .collect())
}

pub fn open_document(app: &AppHandle, doc_id: &str) -> Result<ImportResult, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    ensure_dirs(&root)?;

    // 先短锁取路径，再把 sidecar 读取放到锁外；打开文档不该让整个应用等磁盘。
    let row = {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?
    };
    if !root
        .join(row.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        .exists()
    {
        return Err("文档文件不存在".to_string());
    }

    let (files, ignored) = load_sidecars_for(&root, doc_id)?;

    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut row = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    db::touch_document(&conn, doc_id, now_ms())?;
    let annotations = merge_document(&conn, &root, &mut row, files, ignored)?;
    let document = db::find_by_id(&conn, doc_id)?.unwrap_or(row);

    Ok(ImportResult {
        document: document.to_document(&root),
        annotations,
    })
}

/// 读取 TXT / HTML 的原始文本；PDF 与 EPUB 走各自的解析路径。
pub fn read_document_text(app: &AppHandle, doc_id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let row = {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?
    };
    if row.kind != "txt" && row.kind != "html" {
        return Err("该格式不支持文本读取".to_string());
    }

    let path = root.join(row.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let bytes = fs::read(&path).map_err(|error| format!("读取文档失败：{error}"))?;
    decode_text(&bytes)
}

/// UTF-8 优先；中文 TXT 常见 GBK/GB18030，UTF-8 解不开时按超集解码。
fn decode_text(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(_) => {
            let (text, _, _) = encoding_rs::GB18030.decode(bytes);
            Ok(text.into_owned())
        }
    }
}

pub fn save_cover(app: &AppHandle, doc_id: &str, bytes: Vec<u8>) -> Result<Document, String> {
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("封面文件过大".to_string());
    }

    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;

    let relative = format!(".glossnote/thumbnails/{doc_id}.jpg");
    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建封面目录失败：{error}"))?;
    }

    let temp = path.with_extension(format!("jpg.tmp-{}-{}", process::id(), now_ms()));
    fs::write(&temp, &bytes).map_err(|error| format!("写入封面失败：{error}"))?;
    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&path);
        fs::rename(&temp, &path).map_err(|_| format!("保存封面失败：{error}"))?;
    }

    db::set_cover(&conn, doc_id, &relative)?;
    let document = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    Ok(document.to_document(&root))
}

pub fn save_progress(app: &AppHandle, doc_id: &str, last_page: u32) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if db::find_by_id(&conn, doc_id)?.is_none() {
        return Err("文档不存在".to_string());
    }
    db::save_progress(&conn, doc_id, last_page)
}

/// 读取页内查找的文字缓存；没有缓存时返回空数组。
pub fn load_page_texts(app: &AppHandle, doc_id: &str) -> Result<Vec<PageTextInput>, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::load_page_texts(&conn, doc_id)
}

/// 把本次搜索新提取的页面文字写回缓存，下次搜索无需再跑 pdf.js。
pub fn save_page_texts(
    app: &AppHandle,
    doc_id: &str,
    pages: Vec<PageTextInput>,
) -> Result<usize, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if db::find_by_id(&conn, doc_id)?.is_none() {
        return Err("文档不存在".to_string());
    }
    db::save_page_texts(&conn, doc_id, &pages)
}

pub fn search(app: &AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::search_annotations(&conn, &query)
}

pub fn search_pages(app: &AppHandle, query: String) -> Result<Vec<PageHit>, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::search_pages(&conn, &query)
}

pub fn page_index_status(app: &AppHandle) -> Result<PageIndexStatus, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut status = db::page_index_status(&conn)?;
    let documents = db::list_documents(&conn)?;
    let counts = db::page_text_counts(&conn)?;
    for document in documents {
        // 云盘还没同步下来、或已经被删掉的 PDF 不该让覆盖率永远差几份。
        if root
            .join(
                document
                    .rel_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            )
            .is_file()
        {
            continue;
        }
        let pages = document.page_count as usize;
        let cached = counts.get(&document.id).copied().unwrap_or(0);
        status.documents = status.documents.saturating_sub(1);
        status.pages = status.pages.saturating_sub(pages);
        status.indexed_pages = status.indexed_pages.saturating_sub(cached.min(pages));
        // 只有缓存覆盖全部页面才算完整索引；搜索命中上限截断的缓存不算。
        if pages > 0 && cached >= pages {
            status.indexed_documents = status.indexed_documents.saturating_sub(1);
        }
    }
    Ok(status)
}

/// 导出一份带 GlossNote 标注的 PDF 副本；只读取索引与源文件。
pub fn export_pdf(app: &AppHandle, doc_id: &str, path: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let root = state.root();

    let (source, annotations) = {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let row = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
        let source = root.join(row.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !source.exists() {
            return Err("文档文件不存在".to_string());
        }
        (source, db::list_annotations(&conn, doc_id)?)
    };

    let count = crate::pdf_export::append_annotations(&source, Path::new(path), &annotations)?;
    Ok(format!("已导出 {count} 条标注"))
}

pub fn export_markdown(
    app: &AppHandle,
    path: String,
    doc_id: Option<String>,
) -> Result<String, String> {
    use std::fmt::Write as _;

    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let documents = match doc_id.as_deref() {
        Some(id) => vec![db::find_by_id(&conn, id)?.ok_or_else(|| "文档不存在".to_string())?],
        None => db::list_documents(&conn)?,
    };
    if documents.is_empty() {
        return Err("书库里还没有文档".to_string());
    }

    let single = doc_id.is_some();
    let mut out = String::new();
    if !single {
        writeln!(out, "# GlossNote 导出").unwrap();
        writeln!(out).unwrap();
        writeln!(out, "> 导出时间：{}", Local::now().format("%Y-%m-%d %H:%M")).unwrap();
        writeln!(out).unwrap();
    }

    for (index, document) in documents.iter().enumerate() {
        let title = if document.title.trim().is_empty() {
            document.name.trim_end_matches(".pdf")
        } else {
            document.title.trim()
        };
        writeln!(out, "## {title}").unwrap();
        writeln!(out).unwrap();
        writeln!(out, "- 文件：`{}`", document.name).unwrap();
        if !document.author.trim().is_empty() {
            writeln!(out, "- 作者：{}", document.author.trim()).unwrap();
        }
        writeln!(out, "- 页数：{}", document.page_count).unwrap();
        writeln!(out, "- 标注：{}", document.annotation_count).unwrap();
        writeln!(out).unwrap();

        let annotations = db::list_annotations(&conn, &document.id)?;
        let visible: Vec<_> = annotations
            .into_iter()
            .filter(|annotation| !annotation.deleted)
            .collect();

        if visible.is_empty() {
            writeln!(out, "（暂无标注）").unwrap();
            writeln!(out).unwrap();
        } else {
            for annotation in visible {
                let quote = annotation
                    .anchor
                    .get("quote")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                writeln!(out, "### 第 {} 页", annotation.page + 1).unwrap();
                writeln!(out).unwrap();
                for line in quote.lines() {
                    writeln!(out, "> {line}").unwrap();
                }
                writeln!(out).unwrap();

                if !annotation.body.trim().is_empty() {
                    writeln!(out, "{}", annotation.body.trim()).unwrap();
                    writeln!(out).unwrap();
                }

                if !annotation.tags.is_empty() {
                    let tags = annotation
                        .tags
                        .iter()
                        .map(|tag| format!("#{tag}"))
                        .collect::<Vec<_>>()
                        .join(" ");
                    writeln!(out, "{tags}").unwrap();
                    writeln!(out).unwrap();
                }
            }
        }

        if index + 1 < documents.len() {
            writeln!(out, "---").unwrap();
            writeln!(out).unwrap();
        }
    }

    fs::write(&path, out).map_err(|error| format!("写入 Markdown 失败：{error}"))?;
    Ok(path)
}

pub fn upsert_annotation(
    app: &AppHandle,
    doc_id: &str,
    annotation: Annotation,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if db::find_by_id(&conn, doc_id)?.is_none() {
        return Err("文档不存在，无法保存标注".to_string());
    }
    db::upsert_annotation(&conn, doc_id, &annotation)?;
    write_sidecar(&conn, &root, doc_id)
}

/// 批量导入（例如 PDF 自带标注）：同一事务写入，只回写一次 sidecar。
pub fn upsert_annotations(
    app: &AppHandle,
    doc_id: &str,
    annotations: &[Annotation],
) -> Result<(), String> {
    if annotations.is_empty() {
        return Ok(());
    }

    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if db::find_by_id(&conn, doc_id)?.is_none() {
        return Err("文档不存在，无法导入标注".to_string());
    }

    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("开始保存标注事务失败：{error}"))?;
    for annotation in annotations {
        db::upsert_annotation(&transaction, doc_id, annotation)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交标注事务失败：{error}"))?;

    write_sidecar(&conn, &root, doc_id)
}

pub fn delete_annotation(app: &AppHandle, doc_id: &str, id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let Some(mut annotation) = db::get_annotation(&conn, id)? else {
        return Ok(());
    };
    annotation.deleted = true;
    annotation.updated_at = now_ms();
    db::upsert_annotation(&conn, doc_id, &annotation)?;
    // 卡片不跟着删：保留内容，只标记来源失效。
    db::orphan_cards_for_annotation(&conn, id, annotation.updated_at)?;
    write_sidecar(&conn, &root, doc_id)
}

pub fn update_meta(
    app: &AppHandle,
    doc_id: &str,
    patch: DocumentMetaPatch,
) -> Result<Document, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // 前端每次打开文档都会回填页数/标题/作者；值没变就不要写库、写 sidecar。
    let before = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    let page_count_changed = patch
        .page_count
        .map(|value| value != before.page_count)
        .unwrap_or(false);
    let title_changed = patch
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value != before.title)
        .unwrap_or(false);
    let author_changed = patch
        .author
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value != before.author)
        .unwrap_or(false);

    if !page_count_changed && !title_changed && !author_changed {
        return Ok(before.to_document(&root));
    }

    db::update_meta(
        &conn,
        doc_id,
        patch.page_count,
        patch.title.as_deref(),
        patch.author.as_deref(),
    )?;
    write_sidecar(&conn, &root, doc_id)?;
    let document = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    Ok(document.to_document(&root))
}

/// 文档标签只做轻量整理：去空白、去 #、去重、限制长度与数量。
fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut cleaned: Vec<String> = Vec::new();
    for tag in tags {
        let value = tag.trim().trim_start_matches('#').trim();
        if value.is_empty() || value.chars().count() > 24 {
            continue;
        }
        if !cleaned.iter().any(|item| item == value) {
            cleaned.push(value.to_string());
        }
        if cleaned.len() >= 20 {
            break;
        }
    }
    cleaned
}

/// 虚拟文件夹名：空字符串表示未分类；斜杠会让名字看起来像路径，直接拒绝。
fn clean_folder(name: &str) -> Result<String, String> {
    let value = name.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.chars().count() > 40 {
        return Err("文件夹名超过 40 个字符".to_string());
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        return Err("文件夹名不能包含斜杠或控制字符".to_string());
    }
    Ok(value.to_string())
}

fn clean_folders(folders: Vec<String>) -> Result<Vec<String>, String> {
    let mut cleaned: Vec<String> = Vec::new();
    for folder in folders {
        let value = clean_folder(&folder)?;
        if value.is_empty() || cleaned.contains(&value) {
            continue;
        }
        cleaned.push(value);
        if cleaned.len() >= 100 {
            break;
        }
    }
    Ok(cleaned)
}

/// 收藏或重设文档标签/文件夹；结果写回 SQLite 并同步 sidecar。
pub fn organize_document(
    app: &AppHandle,
    doc_id: &str,
    favorite: Option<bool>,
    tags: Option<Vec<String>>,
    folder: Option<String>,
) -> Result<Document, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let tags = tags.map(clean_tags);
    let folder = folder.map(|value| clean_folder(&value)).transpose()?;
    db::update_organization(
        &conn,
        doc_id,
        favorite,
        tags.as_deref(),
        folder.as_deref(),
        None,
        now_ms(),
    )?;
    write_sidecar(&conn, &root, doc_id)?;
    let document = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    Ok(document.to_document(&root))
}

/// 批量设置收藏、文件夹或增删标签；一次持锁完成，避免逐文档往返 IPC。
pub fn organize_documents(
    app: &AppHandle,
    doc_ids: Vec<String>,
    favorite: Option<bool>,
    add_tags: Vec<String>,
    remove_tags: Vec<String>,
    folder: Option<String>,
) -> Result<Vec<Document>, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let add = clean_tags(add_tags);
    let remove = clean_tags(remove_tags);
    let folder = folder.map(|value| clean_folder(&value)).transpose()?;
    let now = now_ms();
    let mut updated = Vec::new();
    for doc_id in doc_ids {
        let Some(row) = db::find_by_id(&conn, &doc_id)? else {
            continue;
        };
        let mut tags: Vec<String> = row
            .tags
            .iter()
            .filter(|tag| !remove.contains(tag))
            .cloned()
            .collect();
        for tag in &add {
            if !tags.contains(tag) {
                tags.push(tag.clone());
            }
        }
        let tags = clean_tags(tags);
        let row = db::update_organization(
            &conn,
            &doc_id,
            favorite,
            Some(&tags),
            folder.as_deref(),
            None,
            now,
        )?;
        write_sidecar(&conn, &root, &doc_id)?;
        updated.push(row.to_document(&root));
    }
    Ok(updated)
}

/// 手动排序：按传入顺序重排书库，位置只存在本机索引里。
pub fn reorder_documents(app: &AppHandle, doc_ids: Vec<String>) -> Result<Vec<Document>, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::reorder_documents(&conn, &doc_ids)?;
    Ok(db::list_documents(&conn)?
        .iter()
        .map(|row| row.to_document(&root))
        .collect())
}

fn clean_bookmarks(bookmarks: Vec<Bookmark>, now: i64) -> Vec<Bookmark> {
    let mut cleaned: Vec<Bookmark> = Vec::new();
    for bookmark in bookmarks {
        let label = bookmark.label.trim();
        if label.is_empty() || label.chars().count() > 80 {
            continue;
        }
        // 一页一个书签，避免同一页出现多条重复入口。
        if cleaned.iter().any(|item| item.page == bookmark.page) {
            continue;
        }
        let id = if bookmark.id.trim().is_empty() {
            format!("bm-{}-{now}", bookmark.page)
        } else {
            bookmark.id
        };
        cleaned.push(Bookmark {
            id,
            page: bookmark.page,
            label: label.to_string(),
            created_at: if bookmark.created_at == 0 {
                now
            } else {
                bookmark.created_at
            },
        });
        if cleaned.len() >= 200 {
            break;
        }
    }
    cleaned.sort_by_key(|item| item.page);
    cleaned
}

/// 保存整份书签列表；与收藏/标签共用 `meta_updated_at` 做 LWW。
pub fn save_bookmarks(
    app: &AppHandle,
    doc_id: &str,
    bookmarks: Vec<Bookmark>,
) -> Result<Document, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let now = now_ms();
    let mut valid = Vec::new();
    let page_count = db::find_by_id(&conn, doc_id)?
        .ok_or_else(|| "文档不存在".to_string())?
        .page_count;
    for bookmark in bookmarks {
        if page_count > 0 && bookmark.page >= page_count {
            continue;
        }
        valid.push(bookmark);
    }
    let cleaned = clean_bookmarks(valid, now);
    db::update_organization(&conn, doc_id, None, None, None, Some(&cleaned), now)?;
    write_sidecar(&conn, &root, doc_id)?;

    let document = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    Ok(document.to_document(&root))
}

/// 只接受可以安全拼进目录的单个文件名。
/// Windows 上 `C:evil.json` 这类盘符相对路径会让 `Path::join` 丢掉基目录，
/// `CON`、`COM1` 等设备名（带任意扩展名）也会被系统特殊处理，都要挡掉。
fn valid_file_name(value: &str) -> bool {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains(':')
        || value == "."
        || value == ".."
        || value.ends_with(' ')
        || value.ends_with('.')
        || value
            .chars()
            .any(|ch| matches!(ch, '<' | '>' | '"' | '|' | '?' | '*' | '\0'))
    {
        return false;
    }

    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn valid_doc_id(doc_id: &str) -> Result<(), String> {
    if !valid_file_name(doc_id) {
        return Err("文档 id 无效".to_string());
    }
    Ok(())
}

fn version_path(root: &Path, doc_id: &str, version_id: &str) -> Result<PathBuf, String> {
    valid_doc_id(doc_id)?;
    if !valid_file_name(version_id) || !version_id.ends_with(".json") {
        return Err("版本 id 无效".to_string());
    }
    Ok(history_dir(root, doc_id).join(version_id))
}

fn version_created_at(path: &Path, id: &str) -> i64 {
    let from_name = id
        .split('-')
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if from_name > 0 {
        return from_name;
    }
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 读取某份文档自动保存的 sidecar 快照，按时间从新到旧。
fn list_versions(root: &Path, doc_id: &str) -> Result<Vec<SidecarVersion>, String> {
    valid_doc_id(doc_id)?;
    let directory = history_dir(root, doc_id);
    let Ok(entries) = fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };

    let mut versions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(id) = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if !id.ends_with(".json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(sidecar) = serde_json::from_str::<Sidecar>(&text) else {
            continue;
        };
        versions.push(SidecarVersion {
            created_at: version_created_at(&path, &id),
            id,
            annotations: sidecar
                .annotations
                .iter()
                .filter(|annotation| !annotation.deleted)
                .count(),
            cards: sidecar.cards.iter().filter(|card| !card.deleted).count(),
            bookmarks: sidecar.bookmarks.as_ref().map(Vec::len).unwrap_or(0),
            favorite: sidecar.favorite,
            tags: sidecar.tags.clone(),
            folder: sidecar.folder.unwrap_or_default(),
        });
    }

    versions.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    versions.truncate(HISTORY_VERSIONS);
    Ok(versions)
}

pub fn list_sidecar_versions(app: &AppHandle, doc_id: &str) -> Result<Vec<SidecarVersion>, String> {
    let state = app.state::<AppState>();
    list_versions(&state.root(), doc_id)
}

/// 把一份快照写回为当前状态：快照里的标注更新时间推进到 now，
/// 快照里没有的当前标注写墓碑，保证跨设备同步时“恢复”也能赢。
fn restore_from_sidecar(
    conn: &rusqlite::Connection,
    root: &Path,
    doc_id: &str,
    sidecar: Sidecar,
) -> Result<(DocumentRow, Vec<Annotation>), String> {
    valid_doc_id(doc_id)?;
    if sidecar.doc_id != doc_id {
        return Err("版本文件与当前文档不匹配".to_string());
    }

    let now = now_ms();
    // 恢复要么整体成功，要么什么都不改：逐条自动提交时磁盘满或写盘失败，
    // 会留下一半标注被恢复、一半被墓碑的中间状态。
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("开始恢复事务失败：{error}"))?;

    let current = db::list_annotations(&transaction, doc_id)?;
    for annotation in &current {
        let in_snapshot = sidecar
            .annotations
            .iter()
            .any(|item| item.id == annotation.id);
        if !in_snapshot && !annotation.deleted {
            let mut tombstone = annotation.clone();
            tombstone.deleted = true;
            tombstone.updated_at = now;
            db::upsert_annotation(&transaction, doc_id, &tombstone)?;
        }
    }
    for annotation in &sidecar.annotations {
        let mut restored = annotation.clone();
        restored.updated_at = now;
        db::upsert_annotation(&transaction, doc_id, &restored)?;
    }
    db::orphan_cards_for_document(&transaction, doc_id, now)?;

    // 旧格式快照没有 bookmarks/folder 字段：None 表示快照没提供，恢复时保留当前值，
    // 不能像空数组一样把现有书签和文件夹清掉。
    let bookmarks = sidecar
        .bookmarks
        .as_ref()
        .map(|items| clean_bookmarks(items.clone(), now));
    db::update_organization(
        &transaction,
        doc_id,
        Some(sidecar.favorite),
        Some(&sidecar.tags),
        sidecar.folder.as_deref(),
        bookmarks.as_deref(),
        now,
    )?;

    // 写盘时会先把“恢复前”的 sidecar 留成一份新历史，误恢复还能再退回来。
    // 在提交前写：写盘失败就回滚，不会出现库改了、文件没改的半恢复状态。
    write_sidecar(&transaction, root, doc_id)?;
    transaction
        .commit()
        .map_err(|error| format!("提交恢复事务失败：{error}"))?;

    let document = db::find_by_id(conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    let annotations = db::list_annotations(conn, doc_id)?;
    Ok((document, annotations))
}

pub fn restore_sidecar_version(
    app: &AppHandle,
    doc_id: &str,
    version_id: &str,
) -> Result<ImportResult, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let path = version_path(&root, doc_id, version_id)?;
    let text = fs::read_to_string(&path).map_err(|error| format!("读取版本失败：{error}"))?;
    let sidecar: Sidecar =
        serde_json::from_str(&text).map_err(|error| format!("版本文件无法解析：{error}"))?;

    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (document, annotations) = restore_from_sidecar(&conn, &root, doc_id, sidecar)?;
    Ok(ImportResult {
        document: document.to_document(&root),
        annotations,
    })
}

pub fn list_folders(app: &AppHandle) -> Vec<String> {
    // 设置文件可能被手动改过；坏名字直接跳过，不要让它挡住整个侧栏。
    let mut cleaned: Vec<String> = Vec::new();
    for folder in settings::load(app).folders {
        if let Ok(value) = clean_folder(&folder) {
            if !value.is_empty() && !cleaned.contains(&value) {
                cleaned.push(value);
            }
        }
    }
    cleaned
}

/// 保存虚拟文件夹列表（允许空文件夹）；返回归一化后的列表。
pub fn save_folders(app: &AppHandle, folders: Vec<String>) -> Result<Vec<String>, String> {
    let cleaned = clean_folders(folders)?;
    let mut app_settings = settings::load(app);
    app_settings.folders = cleaned;
    settings::save(app, &app_settings)?;
    Ok(app_settings.folders)
}

fn clean_smart_collections(
    collections: Vec<SmartCollection>,
) -> Result<Vec<SmartCollection>, String> {
    const SORTS: [&str; 5] = ["recent", "added", "title", "annotations", "manual"];
    let mut cleaned: Vec<SmartCollection> = Vec::new();
    let mut counter = 0usize;

    for collection in collections {
        let name = collection.name.trim();
        if name.is_empty() {
            continue;
        }
        if name.chars().count() > 40 {
            return Err("收藏夹名超过 40 个字符".to_string());
        }
        if cleaned.iter().any(|item| item.id == collection.id) {
            continue;
        }

        let tag = collection
            .tag
            .trim()
            .trim_start_matches('#')
            .trim()
            .to_string();
        if tag.chars().count() > 24 {
            return Err("收藏夹标签超过 24 个字符".to_string());
        }
        let folder = collection.folder.as_deref().map(clean_folder).transpose()?;
        let sort = if SORTS.contains(&collection.sort.as_str()) {
            collection.sort
        } else {
            "recent".to_string()
        };
        let id = if collection.id.trim().is_empty() {
            counter += 1;
            format!("smart-{}-{counter}", now_ms())
        } else {
            collection.id
        };

        cleaned.push(SmartCollection {
            id,
            name: name.to_string(),
            favorite: collection.favorite,
            tag,
            folder,
            sort,
        });
        if cleaned.len() >= 20 {
            break;
        }
    }
    Ok(cleaned)
}

pub fn save_smart_collections(
    app: &AppHandle,
    collections: Vec<SmartCollection>,
) -> Result<Vec<SmartCollection>, String> {
    let cleaned = clean_smart_collections(collections)?;
    let mut app_settings = settings::load(app);
    app_settings.collections = cleaned;
    settings::save(app, &app_settings)?;
    Ok(app_settings.collections)
}

pub fn list_smart_collections(app: &AppHandle) -> Vec<SmartCollection> {
    settings::load(app).collections
}

struct TrashOutcome {
    trashed: usize,
    missing: bool,
}

/// 把一份文档的 PDF 与 sidecar 交给回收站，封面直接删除。
/// 文件已经不在（手动删掉或云盘还没同步）时返回 missing，由调用方决定只清索引。
fn trash_document_files(
    root: &Path,
    row: &DocumentRow,
    trash_file: &mut dyn FnMut(&Path) -> Result<(), String>,
) -> Result<TrashOutcome, String> {
    let pdf = root.join(row.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !pdf.exists() {
        return Ok(TrashOutcome {
            trashed: 0,
            missing: true,
        });
    }

    trash_file(&pdf)?;
    let mut trashed = 1;

    let sidecar = sidecar_path(root, &row.id);
    if sidecar.exists() {
        match trash_file(&sidecar) {
            Ok(()) => trashed += 1,
            // PDF 已经进回收站了，sidecar 失败也只影响「恢复后是否还有标注」这一步。
            Err(error) => eprintln!("无法把标注文件移入回收站：{error}"),
        }
    }

    let thumbnail = root
        .join(".glossnote")
        .join("thumbnails")
        .join(format!("{}.jpg", row.id));
    if thumbnail.exists() {
        let _ = fs::remove_file(&thumbnail);
    }
    // 文档已经从书库移除，历史版本也不再有任何入口；一并清掉，避免留下孤儿文件。
    let history = history_dir(root, &row.id);
    if history.exists() {
        let _ = fs::remove_dir_all(&history);
    }

    Ok(TrashOutcome {
        trashed,
        missing: false,
    })
}

/// 批量删除：PDF、sidecar 与封面进回收站/删除，索引立即移除。
/// 单个文件进不了回收站时保留该文档并报告，避免留下「书库里有、磁盘上没有」的幽灵。
pub fn delete_documents(app: &AppHandle, doc_ids: Vec<String>) -> Result<DeleteReport, String> {
    let state = app.state::<AppState>();
    let root = state.root();

    let rows: Vec<DocumentRow> = {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        doc_ids
            .iter()
            .filter_map(|id| db::find_by_id(&conn, id).ok().flatten())
            .collect()
    };

    let mut report = DeleteReport::default();
    let mut removed = Vec::new();
    let mut trash_file = |path: &Path| trash::delete(path).map_err(|error| error.to_string());
    for row in &rows {
        match trash_document_files(&root, row, &mut trash_file) {
            Ok(outcome) => {
                report.trashed_files += outcome.trashed;
                if outcome.missing {
                    // 文件已经被手动删除或还没从云盘同步下来：清掉索引即可。
                    report.missing_files += 1;
                }
                removed.push(row.id.clone());
            }
            Err(error) => report.failed.push(format!("{}：{error}", row.name)),
        }
    }

    if !removed.is_empty() {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = now_ms();
        for id in &removed {
            db::remove_document(&conn, id, now)?;
        }
    }

    report.removed = removed.len();
    Ok(report)
}

fn memory_state(card: &Card) -> MemoryState {
    MemoryState {
        stability: card.stability,
        difficulty: card.difficulty,
        reps: card.reps,
        lapses: card.lapses,
        last_reviewed_at: card.last_reviewed_at,
    }
}

fn with_previews(mut view: CardView, now: i64) -> CardView {
    view.previews = fsrs::previews(memory_state(&view.card), now);
    view
}

fn card_view(conn: &rusqlite::Connection, id: &str, now: i64) -> Result<CardView, String> {
    db::list_cards(conn)?
        .into_iter()
        .find(|view| view.card.id == id)
        .map(|view| with_previews(view, now))
        .ok_or_else(|| "卡片不存在".to_string())
}

pub fn cards(app: &AppHandle) -> Result<Vec<CardView>, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    Ok(db::list_cards(&conn)?
        .into_iter()
        .map(|view| with_previews(view, now))
        .collect())
}

fn sanitize_links(
    conn: &rusqlite::Connection,
    links: &[String],
    exclude: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for id in links {
        if Some(id.as_str()) == exclude || result.contains(id) {
            continue;
        }
        if let Some(card) = db::get_card(conn, id)? {
            if !card.deleted {
                result.push(id.clone());
            }
        }
    }
    Ok(result)
}

fn default_card_title(quote: &str, body: &str) -> String {
    let text = if quote.trim().is_empty() {
        body.trim()
    } else {
        quote.trim()
    };
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return "未命名卡片".to_string();
    }

    let mut title: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        title.push('…');
    }
    title
}

fn persist_card_sidecar(
    conn: &rusqlite::Connection,
    root: &Path,
    card: &Card,
) -> Result<(), String> {
    if let Some(doc_id) = card.source_doc_id.as_deref() {
        if db::find_by_id(conn, doc_id)?.is_some() {
            write_sidecar(conn, root, doc_id)?;
        }
    }
    Ok(())
}

pub fn create_card(
    app: &AppHandle,
    doc_id: &str,
    annotation_id: &str,
    title: String,
    body: String,
    links: Vec<String>,
) -> Result<CardView, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let annotation = db::list_annotations(&conn, doc_id)?
        .into_iter()
        .find(|annotation| annotation.id == annotation_id)
        .ok_or_else(|| "来源标注不存在".to_string())?;
    if annotation.deleted {
        return Err("来源标注已删除".to_string());
    }

    let now = now_ms();
    let quote = annotation
        .anchor
        .get("quote")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let title = if title.trim().is_empty() {
        default_card_title(quote, &body)
    } else {
        title.trim().to_string()
    };

    // 前端已经按“是否已有卡片”切换入口；这里做成幂等写入，
    // 双击或上次保存中途失败都不会产生第二张卡片或报错。
    if let Some(mut existing) = db::find_card_by_annotation(&conn, annotation_id)? {
        if !existing.deleted {
            existing.title = title;
            existing.body = body.trim().to_string();
            existing.links = sanitize_links(&conn, &links, Some(&existing.id))?;
            existing.updated_at = now;
            db::upsert_card(&conn, &existing)?;
            persist_card_sidecar(&conn, &root, &existing)?;
            return card_view(&conn, &existing.id, now);
        }
    }

    let card = Card {
        id: format!("card-{annotation_id}"),
        title,
        body: body.trim().to_string(),
        source_annotation_id: Some(annotation.id.clone()),
        source_doc_id: Some(doc_id.to_string()),
        source_page: Some(annotation.page),
        links: sanitize_links(&conn, &links, None)?,
        status: "active".to_string(),
        created_at: now,
        updated_at: now,
        due_at: now,
        stability: 0.0,
        difficulty: 0.0,
        reps: 0,
        lapses: 0,
        last_reviewed_at: 0,
        state: "new".to_string(),
        deleted: false,
    };

    db::upsert_card(&conn, &card)?;
    persist_card_sidecar(&conn, &root, &card)?;
    card_view(&conn, &card.id, now)
}

pub fn update_card(
    app: &AppHandle,
    card_id: &str,
    title: String,
    body: String,
    links: Vec<String>,
) -> Result<CardView, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut card = db::get_card(&conn, card_id)?.ok_or_else(|| "卡片不存在".to_string())?;
    if card.deleted {
        return Err("卡片已删除".to_string());
    }
    if title.trim().is_empty() {
        return Err("卡片标题不能为空".to_string());
    }

    card.title = title.trim().to_string();
    card.body = body.trim().to_string();
    card.links = sanitize_links(&conn, &links, Some(card_id))?;
    card.updated_at = now_ms();

    db::upsert_card(&conn, &card)?;
    persist_card_sidecar(&conn, &root, &card)?;
    card_view(&conn, &card.id, card.updated_at)
}

pub fn delete_card(app: &AppHandle, card_id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let Some(mut card) = db::get_card(&conn, card_id)? else {
        return Ok(());
    };
    if card.deleted {
        return Ok(());
    }

    card.deleted = true;
    card.updated_at = now_ms();
    db::upsert_card(&conn, &card)?;
    persist_card_sidecar(&conn, &root, &card)
}

pub fn review_card(app: &AppHandle, card_id: &str, rating: u8) -> Result<CardView, String> {
    if !(1..=4).contains(&rating) {
        return Err("复习评分必须是 1 到 4".to_string());
    }

    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut card = db::get_card(&conn, card_id)?.ok_or_else(|| "卡片不存在".to_string())?;
    if card.deleted {
        return Err("卡片已删除".to_string());
    }

    let now = now_ms();
    let outcome = fsrs::schedule(memory_state(&card), rating, now);
    card.stability = outcome.stability;
    card.difficulty = outcome.difficulty;
    card.due_at = outcome.due_at;
    card.reps = outcome.reps;
    card.lapses = outcome.lapses;
    card.last_reviewed_at = now;
    card.state = "review".to_string();
    card.updated_at = now;

    db::upsert_card(&conn, &card)?;
    persist_card_sidecar(&conn, &root, &card)?;
    card_view(&conn, &card.id, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glossnote-{label}-{}", process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 文档 id 是内容地址；换哈希库时这条必须仍然成立。
    #[test]
    fn hash_file_matches_known_sha256() {
        let dir = temp_dir("hash");
        let path = dir.join("abc.pdf");
        fs::write(&path, b"abc").unwrap();
        assert_eq!(
            hash_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn document(id: &str, rel_path: &str) -> DocumentRow {
        DocumentRow {
            id: id.to_string(),
            name: "doc.pdf".to_string(),
            kind: "pdf".to_string(),
            title: String::new(),
            author: String::new(),
            page_count: 0,
            rel_path: rel_path.to_string(),
            size: 10,
            mtime: 1,
            added_at: 1,
            last_opened_at: 1,
            cover: String::new(),
            last_page: 0,
            favorite: false,
            tags: Vec::new(),
            bookmarks: Vec::new(),
            folder: String::new(),
            position: 0,
            meta_updated_at: 0,
            annotation_count: 0,
        }
    }

    fn annotation(id: &str, updated_at: i64, body: &str) -> Annotation {
        Annotation {
            id: id.to_string(),
            page: 0,
            anchor: serde_json::json!({ "quote": "hello", "start": 0, "end": 5 }),
            color: "yellow".to_string(),
            kind: "highlight".to_string(),
            body: body.to_string(),
            tags: Vec::new(),
            created_at: 1,
            updated_at,
            deleted: false,
        }
    }

    fn merge_from_disk(
        conn: &rusqlite::Connection,
        root: &Path,
        row: &DocumentRow,
    ) -> Vec<Annotation> {
        let (files, ignored) = load_sidecars_for(root, &row.id).unwrap();
        let mut merged_row = row.clone();
        merge_document(conn, root, &mut merged_row, files, ignored).unwrap()
    }

    #[test]
    fn single_document_load_skips_other_sidecars() {
        let dir = temp_dir("single-sidecar");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let row = document("doc1", "books/doc1.pdf");
        db::upsert_document(&conn, &row).unwrap();

        let canonical = sidecar_path(&root, "doc1");
        let write = |path: &Path, sidecar: &Sidecar| {
            fs::write(path, serde_json::to_vec(sidecar).unwrap()).unwrap();
        };
        write(
            &canonical,
            &sidecar_for("doc1", vec![annotation("a1", 10, "canonical")]),
        );
        write(
            &canonical.with_file_name("doc1 (1).json"),
            &sidecar_for("doc1", vec![annotation("a2", 10, "conflict")]),
        );
        write(
            &canonical.with_file_name("doc2.json"),
            &sidecar_for("doc2", vec![annotation("b1", 10, "other")]),
        );
        // 名字被改过，但仍属于 doc1：单文档读取不认，全库扫描兜底。
        write(
            &canonical.with_file_name("renamed.json"),
            &sidecar_for("doc1", vec![annotation("a3", 10, "renamed")]),
        );

        let (files, ignored) = load_sidecars_for(&root, "doc1").unwrap();
        assert_eq!(ignored, 0);
        assert_eq!(files.len(), 2, "只应读规范文件与冲突副本");

        let (groups, _) = load_sidecars(&root).unwrap();
        assert_eq!(
            groups.get("doc1").unwrap().len(),
            3,
            "全库扫描仍覆盖改名文件"
        );

        let merged = merge_from_disk(&conn, &root, &row);
        let ids: Vec<&str> = merged.iter().map(|item| item.id.as_str()).collect();
        assert!(ids.contains(&"a1"));
        assert!(ids.contains(&"a2"));
        assert!(!ids.contains(&"a3"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn document_tags_follow_sidecar_timestamps() {
        let dir = temp_dir("doc-tags");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let row = document("doc1", "books/doc1.pdf");
        db::upsert_document(&conn, &row).unwrap();

        db::update_organization(
            &conn,
            "doc1",
            Some(true),
            Some(&["论文".to_string()]),
            Some("研究"),
            None,
            10,
        )
        .unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();
        let path = sidecar_path(&root, "doc1");
        let mut sidecar: Sidecar = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(sidecar.favorite);
        assert_eq!(sidecar.tags, vec!["论文".to_string()]);
        assert_eq!(sidecar.folder.as_deref(), Some("研究"));

        // 比数据库旧的 sidecar 不得覆盖本机设置。
        sidecar.favorite = false;
        sidecar.tags = vec!["旧".to_string()];
        sidecar.folder = Some("旧文件夹".to_string());
        sidecar.meta_updated_at = 5;
        fs::write(&path, serde_json::to_vec(&sidecar).unwrap()).unwrap();
        let current = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        merge_from_disk(&conn, &root, &current);
        let fresh = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        assert!(fresh.favorite);
        assert_eq!(fresh.tags, vec!["论文".to_string()]);
        assert_eq!(fresh.folder, "研究");

        // 另一台设备写入了更新的版本：合并时应当采用。
        sidecar.favorite = false;
        sidecar.tags = vec!["同步".to_string()];
        sidecar.folder = Some("同步文件夹".to_string());
        sidecar.meta_updated_at = 20;
        fs::write(&path, serde_json::to_vec(&sidecar).unwrap()).unwrap();
        let current = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        merge_from_disk(&conn, &root, &current);
        let fresh = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        assert!(!fresh.favorite);
        assert_eq!(fresh.tags, vec!["同步".to_string()]);
        assert_eq!(fresh.folder, "同步文件夹");

        // 旧版应用写 sidecar 时没有 folder 字段：不能把已有文件夹清空。
        sidecar.favorite = true;
        sidecar.meta_updated_at = 30;
        sidecar.folder = None;
        fs::write(&path, serde_json::to_vec(&sidecar).unwrap()).unwrap();
        let current = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        merge_from_disk(&conn, &root, &current);
        let fresh = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        assert!(fresh.favorite);
        assert_eq!(fresh.folder, "同步文件夹");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_names_are_validated_and_deduplicated() {
        assert_eq!(clean_folder("  研究 ").unwrap(), "研究");
        assert_eq!(clean_folder("").unwrap(), "");
        assert!(clean_folder("a/b").is_err());
        assert!(clean_folder(&"长".repeat(41)).is_err());
        assert_eq!(
            clean_folders(vec![
                "研究".to_string(),
                "研究".to_string(),
                String::new(),
                "资料".to_string(),
            ])
            .unwrap(),
            vec!["研究".to_string(), "资料".to_string()]
        );
    }

    #[test]
    fn manual_order_follows_input_sequence() {
        let dir = temp_dir("reorder");
        let conn = db::open(&dir.join("test.db")).unwrap();
        for id in ["a", "b", "c"] {
            db::upsert_document(&conn, &document(id, &format!("books/{id}.pdf"))).unwrap();
        }

        db::reorder_documents(&conn, &["c".to_string(), "a".to_string(), "b".to_string()]).unwrap();

        let mut rows = db::list_documents(&conn).unwrap();
        rows.sort_by_key(|row| row.position);
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["c", "a", "b"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_documents_trashes_pdf_and_sidecar() {
        let dir = temp_dir("delete-files");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let row = document("doc1", "books/doc1.pdf");
        let pdf = root.join("books").join("doc1.pdf");
        fs::write(&pdf, b"pdf").unwrap();
        let sidecar = sidecar_path(&root, &row.id);
        fs::write(&sidecar, b"{}").unwrap();
        let thumbnail = root.join(".glossnote").join("thumbnails").join("doc1.jpg");
        fs::create_dir_all(thumbnail.parent().unwrap()).unwrap();
        fs::write(&thumbnail, b"jpg").unwrap();

        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let mut trash_file = |path: &Path| {
            let destination = bin.join(path.file_name().unwrap());
            fs::rename(path, destination).map_err(|error| error.to_string())
        };

        let outcome = trash_document_files(&root, &row, &mut trash_file).unwrap();
        assert_eq!(outcome.trashed, 2);
        assert!(!outcome.missing);
        assert!(!pdf.exists());
        assert!(!sidecar.exists());
        assert!(!thumbnail.exists());
        assert!(bin.join("doc1.pdf").exists());
        assert!(bin.join("doc1.json").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_a_missing_pdf_only_clears_the_index() {
        let dir = temp_dir("delete-missing");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let row = document("doc1", "books/doc1.pdf");
        let mut trash_file =
            |_path: &Path| -> Result<(), String> { panic!("缺失文件不应进入回收站") };

        let outcome = trash_document_files(&root, &row, &mut trash_file).unwrap();
        assert_eq!(outcome.trashed, 0);
        assert!(outcome.missing);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn smart_collections_normalize_and_skip_empty_names() {
        let cleaned = clean_smart_collections(vec![
            SmartCollection {
                id: "1".to_string(),
                name: "   ".to_string(),
                ..Default::default()
            },
            SmartCollection {
                id: "2".to_string(),
                name: " 收藏论文 ".to_string(),
                tag: "#论文".to_string(),
                folder: Some("研究".to_string()),
                sort: "manual".to_string(),
                ..Default::default()
            },
        ])
        .unwrap();

        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].name, "收藏论文");
        assert_eq!(cleaned[0].tag, "论文");
        assert_eq!(cleaned[0].folder.as_deref(), Some("研究"));
        assert_eq!(cleaned[0].sort, "manual");
    }

    #[test]
    fn bookmarks_drop_duplicate_pages_and_sort() {
        let cleaned = clean_bookmarks(
            vec![
                Bookmark {
                    id: "b2".to_string(),
                    page: 5,
                    label: " 第五章 ".to_string(),
                    created_at: 0,
                },
                Bookmark {
                    id: "b1".to_string(),
                    page: 1,
                    label: String::new(),
                    created_at: 0,
                },
                Bookmark {
                    id: "b3".to_string(),
                    page: 5,
                    label: "重复".to_string(),
                    created_at: 0,
                },
                Bookmark {
                    id: String::new(),
                    page: 2,
                    label: "第二章".to_string(),
                    created_at: 0,
                },
            ],
            100,
        );

        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[0].page, 2);
        assert_eq!(cleaned[1].page, 5);
        assert_eq!(cleaned[1].label, "第五章");
        assert_eq!(cleaned[0].created_at, 100);
        assert!(cleaned[0].id.starts_with("bm-2-"));
    }

    #[test]
    fn bookmarks_follow_sidecar_timestamps() {
        let dir = temp_dir("doc-bookmarks");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let row = document("doc1", "books/doc1.pdf");
        db::upsert_document(&conn, &row).unwrap();

        let bookmark = Bookmark {
            id: "bm1".to_string(),
            page: 3,
            label: "重点".to_string(),
            created_at: 1,
        };
        db::update_organization(
            &conn,
            "doc1",
            None,
            None,
            None,
            Some(std::slice::from_ref(&bookmark)),
            10,
        )
        .unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();
        let path = sidecar_path(&root, "doc1");
        let mut sidecar: Sidecar = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(sidecar.bookmarks.as_ref().unwrap().len(), 1);

        // 更旧的 sidecar 不能清空本机书签。
        sidecar.bookmarks = Some(Vec::new());
        sidecar.meta_updated_at = 5;
        fs::write(&path, serde_json::to_vec(&sidecar).unwrap()).unwrap();
        let current = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        merge_from_disk(&conn, &root, &current);
        let fresh = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        assert_eq!(fresh.bookmarks.len(), 1);

        // 更新的 sidecar 覆盖本机书签。
        sidecar.bookmarks = Some(vec![Bookmark {
            id: "bm2".to_string(),
            page: 7,
            label: "同步".to_string(),
            created_at: 2,
        }]);
        sidecar.meta_updated_at = 20;
        fs::write(&path, serde_json::to_vec(&sidecar).unwrap()).unwrap();
        let current = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        merge_from_disk(&conn, &root, &current);
        let fresh = db::find_by_id(&conn, "doc1").unwrap().unwrap();
        assert_eq!(fresh.bookmarks[0].label, "同步");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_history_snapshots_changes_and_restores() {
        let dir = temp_dir("history");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let mut row = document("doc1", "books/doc1.pdf");
        row.page_count = 10;
        db::upsert_document(&conn, &row).unwrap();

        db::upsert_annotation(&conn, "doc1", &annotation("a1", 1, "first")).unwrap();
        db::update_organization(
            &conn,
            "doc1",
            None,
            None,
            None,
            Some(std::slice::from_ref(&Bookmark {
                id: "bm1".to_string(),
                page: 0,
                label: "重点".to_string(),
                created_at: 1,
            })),
            5,
        )
        .unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();
        assert!(list_versions(&root, "doc1").unwrap().is_empty());

        db::upsert_annotation(&conn, "doc1", &annotation("a1", 2, "second")).unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();

        db::upsert_annotation(&conn, "doc1", &annotation("a2", 3, "extra")).unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();

        let versions = list_versions(&root, "doc1").unwrap();
        assert_eq!(versions.len(), 2);
        let oldest = versions.last().unwrap();
        let text = fs::read_to_string(history_dir(&root, "doc1").join(&oldest.id)).unwrap();
        let snapshot: Sidecar = serde_json::from_str(&text).unwrap();

        let (restored, annotations) = restore_from_sidecar(&conn, &root, "doc1", snapshot).unwrap();
        assert_eq!(restored.id, "doc1");
        assert_eq!(restored.bookmarks.len(), 1);
        assert_eq!(restored.bookmarks[0].label, "重点");
        let a1 = annotations.iter().find(|item| item.id == "a1").unwrap();
        assert_eq!(a1.body, "first");
        assert!(!a1.deleted);
        let a2 = annotations.iter().find(|item| item.id == "a2").unwrap();
        assert!(a2.deleted);

        // 恢复前状态也要留下历史，误恢复可以再退回来。
        assert!(list_versions(&root, "doc1").unwrap().len() >= 3);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_prunes_to_thirty_versions() {
        let dir = temp_dir("history-prune");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        db::upsert_document(&conn, &document("doc1", "books/doc1.pdf")).unwrap();

        for index in 1..=35 {
            db::upsert_annotation(
                &conn,
                "doc1",
                &annotation("a1", index, &format!("版本 {index}")),
            )
            .unwrap();
            write_sidecar(&conn, &root, "doc1").unwrap();
        }

        assert_eq!(list_versions(&root, "doc1").unwrap().len(), 30);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_round_trip_and_last_write_wins() {
        let dir = temp_dir("sidecar");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let row = document("doc1", "books/doc1.pdf");

        db::upsert_document(&conn, &row).unwrap();
        db::upsert_annotation(&conn, &row.id, &annotation("a1", 10, "first")).unwrap();
        write_sidecar(&conn, &root, &row.id).unwrap();

        let path = sidecar_path(&root, &row.id);
        let mut sidecar: Sidecar = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(sidecar.annotations.len(), 1);
        assert_eq!(sidecar.annotations[0].body, "first");

        // 另一台设备写入了更新的版本：合并时应当采用。
        sidecar.annotations[0].body = "newer".to_string();
        sidecar.annotations[0].updated_at = 20;
        fs::write(&path, serde_json::to_vec(&sidecar).unwrap()).unwrap();
        let merged = merge_from_disk(&conn, &root, &row);
        assert_eq!(merged[0].body, "newer");

        // 数据库更新、sidecar 落后：旧 sidecar 不得覆盖新数据。
        db::upsert_annotation(&conn, &row.id, &annotation("a1", 30, "database wins")).unwrap();
        let merged = merge_from_disk(&conn, &root, &row);
        assert_eq!(merged[0].body, "database wins");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_without_kind_defaults_to_pdf() {
        let sidecar: Sidecar =
            serde_json::from_str(r#"{"schemaVersion":1,"docId":"d1","name":"doc.pdf","size":10}"#)
                .unwrap();
        assert_eq!(sidecar.kind, "pdf");
    }

    fn sidecar_for(doc_id: &str, annotations: Vec<Annotation>) -> Sidecar {
        Sidecar {
            schema_version: SIDECAR_VERSION,
            doc_id: doc_id.to_string(),
            name: "doc.pdf".to_string(),
            kind: "pdf".to_string(),
            size: 10,
            page_count: 2,
            annotations,
            cards: Vec::new(),
            favorite: false,
            tags: Vec::new(),
            bookmarks: None,
            folder: None,
            meta_updated_at: 0,
        }
    }

    fn card(id: &str, doc_id: &str, annotation_id: &str, updated_at: i64, title: &str) -> Card {
        Card {
            id: id.to_string(),
            title: title.to_string(),
            body: "card body".to_string(),
            source_annotation_id: Some(annotation_id.to_string()),
            source_doc_id: Some(doc_id.to_string()),
            source_page: Some(0),
            links: Vec::new(),
            status: "active".to_string(),
            created_at: 1,
            updated_at,
            due_at: 1,
            stability: 0.0,
            difficulty: 0.0,
            reps: 0,
            lapses: 0,
            last_reviewed_at: 0,
            state: "new".to_string(),
            deleted: false,
        }
    }

    fn write_conflict(root: &Path, name: &str, sidecar: &Sidecar) -> PathBuf {
        let path = root.join(".glossnote").join("annotations").join(name);
        fs::write(&path, serde_json::to_vec(sidecar).unwrap()).unwrap();
        path
    }

    #[test]
    fn card_sidecar_round_trip_and_conflict_merge() {
        let dir = temp_dir("cards");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let mut row = document("doc1", "books/doc1.pdf");

        db::upsert_document(&conn, &row).unwrap();
        db::upsert_annotation(&conn, &row.id, &annotation("a1", 10, "note")).unwrap();
        db::upsert_card(&conn, &card("c1", "doc1", "a1", 10, "旧卡片")).unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();

        let canonical: Sidecar =
            serde_json::from_slice(&fs::read(sidecar_path(&root, "doc1")).unwrap()).unwrap();
        assert_eq!(canonical.cards.len(), 1);
        assert_eq!(canonical.cards[0].title, "旧卡片");

        let mut conflict = sidecar_for("doc1", vec![annotation("a1", 10, "note")]);
        conflict.cards = vec![card("c1", "doc1", "a1", 20, "冲突卡片")];
        let conflict_path = write_conflict(&root, "doc1 (conflicted copy).json", &conflict);

        let (mut groups, _) = load_sidecars(&root).unwrap();
        let files = groups.remove("doc1").unwrap();
        let mut stats = MergeStats::default();
        reconcile_document(&conn, &root, &mut row, &files, &mut stats).unwrap();

        assert_eq!(stats.merged_cards, 1);
        assert_eq!(stats.archived, 1);
        assert!(!conflict_path.exists());
        assert_eq!(
            db::get_card(&conn, "c1").unwrap().unwrap().title,
            "冲突卡片"
        );

        let canonical: Sidecar =
            serde_json::from_slice(&fs::read(sidecar_path(&root, "doc1")).unwrap()).unwrap();
        assert_eq!(canonical.cards[0].title, "冲突卡片");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tombstoned_annotation_orphans_but_keeps_card() {
        let dir = temp_dir("orphan");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let mut row = document("doc1", "books/doc1.pdf");

        db::upsert_document(&conn, &row).unwrap();
        db::upsert_annotation(&conn, &row.id, &annotation("a1", 10, "note")).unwrap();
        db::upsert_card(&conn, &card("c1", "doc1", "a1", 10, "要保留的卡片")).unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();

        // 另一台设备删除标注：冲突副本里只有墓碑，卡片本体没变。
        let mut tombstone = annotation("a1", 20, "");
        tombstone.deleted = true;
        let conflict = sidecar_for("doc1", vec![tombstone]);
        write_conflict(&root, "doc1 (2).json", &conflict);

        let (mut groups, _) = load_sidecars(&root).unwrap();
        let files = groups.remove("doc1").unwrap();
        let mut stats = MergeStats::default();
        reconcile_document(&conn, &root, &mut row, &files, &mut stats).unwrap();

        let card = db::get_card(&conn, "c1").unwrap().unwrap();
        assert_eq!(card.title, "要保留的卡片");
        assert_eq!(card.status, "orphaned");
        assert!(!card.deleted);

        let canonical: Sidecar =
            serde_json::from_slice(&fs::read(sidecar_path(&root, "doc1")).unwrap()).unwrap();
        assert_eq!(canonical.cards[0].status, "orphaned");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merges_and_archives_conflict_sidecars() {
        let dir = temp_dir("conflict");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let mut row = document("doc1", "books/doc1.pdf");
        db::upsert_document(&conn, &row).unwrap();

        let canonical = sidecar_for("doc1", vec![annotation("a1", 10, "old")]);
        fs::write(
            sidecar_path(&root, "doc1"),
            serde_json::to_vec(&canonical).unwrap(),
        )
        .unwrap();

        // 云盘生成的冲突副本：同一条更新，另带一条新标注。
        let conflict = sidecar_for(
            "doc1",
            vec![
                annotation("a1", 20, "from conflict"),
                annotation("a2", 15, "new"),
            ],
        );
        let conflict_path = root
            .join(".glossnote")
            .join("annotations")
            .join("doc1 (conflicted copy).json");
        fs::write(&conflict_path, serde_json::to_vec(&conflict).unwrap()).unwrap();
        fs::write(
            root.join(".glossnote")
                .join("annotations")
                .join("broken.json"),
            b"not json",
        )
        .unwrap();

        let (mut groups, ignored) = load_sidecars(&root).unwrap();
        assert_eq!(ignored, 1);
        let files = groups.remove("doc1").unwrap();
        let mut stats = MergeStats::default();
        let merged = reconcile_document(&conn, &root, &mut row, &files, &mut stats).unwrap();

        // 规范文件里的 a1、冲突副本里的 a1 与 a2 都是从 sidecar 采纳的记录。
        assert_eq!(stats.merged, 3);
        assert_eq!(stats.archived, 1);
        assert!(!conflict_path.exists());
        assert!(root
            .join(".glossnote")
            .join("conflicts")
            .join("doc1 (conflicted copy).json")
            .exists());

        let body = |id: &str| {
            merged
                .iter()
                .find(|item| item.id == id)
                .map(|item| item.body.as_str())
                .unwrap()
        };
        assert_eq!(body("a1"), "from conflict");
        assert_eq!(body("a2"), "new");

        let canonical: Sidecar =
            serde_json::from_slice(&fs::read(sidecar_path(&root, "doc1")).unwrap()).unwrap();
        assert_eq!(canonical.annotations.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn conflict_tombstone_wins_by_timestamp() {
        let dir = temp_dir("tombstone");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let mut row = document("doc1", "books/doc1.pdf");

        db::upsert_document(&conn, &row).unwrap();
        db::upsert_annotation(&conn, &row.id, &annotation("a1", 10, "alive")).unwrap();

        let mut tombstone = annotation("a1", 20, "");
        tombstone.deleted = true;
        let conflict = sidecar_for("doc1", vec![tombstone]);
        fs::write(
            root.join(".glossnote")
                .join("annotations")
                .join("doc1 (1).json"),
            serde_json::to_vec(&conflict).unwrap(),
        )
        .unwrap();

        let (mut groups, _) = load_sidecars(&root).unwrap();
        let files = groups.remove("doc1").unwrap();
        let mut stats = MergeStats::default();
        let merged = reconcile_document(&conn, &root, &mut row, &files, &mut stats).unwrap();

        assert!(merged[0].deleted);
        assert_eq!(stats.archived, 1);
        let canonical: Sidecar =
            serde_json::from_slice(&fs::read(sidecar_path(&root, "doc1")).unwrap()).unwrap();
        assert!(canonical.annotations[0].deleted);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_is_only_rewritten_when_content_changes() {
        let dir = temp_dir("sidecar-noop");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let row = document("doc1", "books/doc1.pdf");
        db::upsert_document(&conn, &row).unwrap();
        db::upsert_annotation(&conn, &row.id, &annotation("a1", 10, "note")).unwrap();

        write_sidecar(&conn, &root, "doc1").unwrap();
        let path = sidecar_path(&root, "doc1");
        let first = fs::metadata(&path).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        write_sidecar(&conn, &root, "doc1").unwrap();
        assert_eq!(
            first,
            fs::metadata(&path).unwrap().modified().unwrap(),
            "数据库没变时不应重写 sidecar"
        );

        db::upsert_annotation(&conn, &row.id, &annotation("a1", 20, "newer")).unwrap();
        write_sidecar(&conn, &root, "doc1").unwrap();
        assert!(
            fs::metadata(&path).unwrap().modified().unwrap() > first,
            "数据库变化后应重写 sidecar"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_name_cleans_and_keeps_supported_extensions() {
        assert_eq!(safe_name("a:b?.pdf"), "a_b_.pdf");
        assert_eq!(safe_name("notes.txt"), "notes.txt");
        assert_eq!(safe_name("page.htm"), "page.htm");
        assert_eq!(safe_name("report"), "report.pdf");
        assert_eq!(safe_name("   "), "document.pdf");
    }

    #[test]
    fn detects_document_kind_from_extension() {
        assert_eq!(document_kind(Path::new("a.pdf")), Some("pdf"));
        assert_eq!(document_kind(Path::new("a.TXT")), Some("txt"));
        assert_eq!(document_kind(Path::new("a.htm")), Some("html"));
        assert_eq!(document_kind(Path::new("a.epub")), Some("epub"));
        assert_eq!(document_kind(Path::new("a.docx")), None);
    }

    #[test]
    fn decodes_utf8_bom_and_gb18030_text() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFhello").unwrap(), "hello");
        // GB18030 的「中文」：D6 D0 CE C4
        assert_eq!(decode_text(&[0xD6, 0xD0, 0xCE, 0xC4]).unwrap(), "中文");
    }
}
