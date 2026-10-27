use crate::{
    db,
    models::{
        Annotation, Document, DocumentMetaPatch, DocumentRow, ImportResult, LibraryInfo,
        ScanReport, SearchHit, Sidecar,
    },
    state::AppState,
};
use chrono::Local;
use serde::{Deserialize, Serialize};
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

const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;
const SIDECAR_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    library_dir: Option<String>,
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|error| format!("定位应用数据目录失败：{error}"))
}

pub fn resolve_root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = settings_path(app)?;
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(settings) = serde_json::from_str::<AppSettings>(&text) {
            if let Some(dir) = settings
                .library_dir
                .filter(|value| !value.trim().is_empty())
            {
                return Ok(PathBuf::from(dir));
            }
        }
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

fn save_settings(app: &AppHandle, root: &Path) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建应用数据目录失败：{error}"))?;
    }

    let settings = AppSettings {
        library_dir: Some(root.to_string_lossy().into_owned()),
    };
    let bytes =
        serde_json::to_vec_pretty(&settings).map_err(|error| format!("序列化设置失败：{error}"))?;

    let temp = path.with_extension(format!("json.tmp-{}", process::id()));
    fs::write(&temp, bytes).map_err(|error| format!("写入设置失败：{error}"))?;
    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&path);
        fs::rename(&temp, &path).map_err(|_| format!("保存设置失败：{error}"))?;
    }
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

    save_settings(app, &root)?;

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

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
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
    if !name.to_lowercase().ends_with(".pdf") {
        name.push_str(".pdf");
    }
    name
}

fn unique_dest(books: &Path, name: &str, hash: &str) -> PathBuf {
    let candidate = books.join(name);
    if !candidate.exists() || hash_file(&candidate).ok().as_deref() == Some(hash) {
        return candidate;
    }

    let stem = name.trim_end_matches(".pdf");
    for index in 2..1000 {
        let candidate = books.join(format!("{stem} ({index}).pdf"));
        if !candidate.exists() || hash_file(&candidate).ok().as_deref() == Some(hash) {
            return candidate;
        }
    }

    books.join(format!("{}-{}.pdf", stem, hash))
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
    archived: usize,
    ignored: usize,
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

        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("跳过无法读取的 sidecar {}：{error}", path.display());
                ignored += 1;
                continue;
            }
        };
        let sidecar: Sidecar = match serde_json::from_str(&text) {
            Ok(sidecar) => sidecar,
            Err(error) => {
                eprintln!("跳过无效的 sidecar {}：{error}", path.display());
                ignored += 1;
                continue;
            }
        };
        if sidecar.doc_id.trim().is_empty() {
            ignored += 1;
            continue;
        }

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
    document: &DocumentRow,
    sidecar: &Sidecar,
    page_count: &mut u32,
    merged: &mut usize,
) -> Result<(), String> {
    if *page_count == 0 && sidecar.page_count > 0 {
        *page_count = sidecar.page_count;
        db::update_meta(conn, &document.id, Some(sidecar.page_count), None, None)?;
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

    Ok(())
}

/// 合并该文档的所有 sidecar：规范文件优先赢得同时间戳的平局，
/// 合并后回写规范文件，再把冲突副本移出标注目录。
fn reconcile_document(
    conn: &rusqlite::Connection,
    root: &Path,
    document: &DocumentRow,
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
        apply_sidecar(conn, document, sidecar, &mut page_count, &mut stats.merged)?;
    }

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

/// 单文档场景（导入/打开）：现读目录，合并并归档该文档的冲突副本。
fn merge_document(
    conn: &rusqlite::Connection,
    root: &Path,
    document: &DocumentRow,
) -> Result<Vec<Annotation>, String> {
    let (mut groups, ignored) = load_sidecars(root)?;
    let files = groups.remove(&document.id).unwrap_or_default();
    let mut stats = MergeStats {
        ignored,
        ..Default::default()
    };
    reconcile_document(conn, root, document, &files, &mut stats)
}

pub fn write_sidecar(conn: &rusqlite::Connection, root: &Path, doc_id: &str) -> Result<(), String> {
    let document = db::find_by_id(conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    let annotations = db::list_annotations(conn, doc_id)?;
    let sidecar = Sidecar {
        schema_version: SIDECAR_VERSION,
        doc_id: document.id.clone(),
        name: document.name.clone(),
        size: document.size,
        page_count: document.page_count,
        annotations,
    };

    let path = sidecar_path(root, doc_id);
    let directory = path.parent().ok_or_else(|| "标注路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建标注目录失败：{error}"))?;

    let temp = directory.join(format!(
        "{}.json.tmp-{}-{}",
        doc_id,
        process::id(),
        now_ms()
    ));
    let bytes =
        serde_json::to_vec_pretty(&sidecar).map_err(|error| format!("序列化标注失败：{error}"))?;
    fs::write(&temp, bytes).map_err(|error| format!("写入标注失败：{error}"))?;

    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&path);
        fs::rename(&temp, &path).map_err(|_| format!("保存标注失败：{error}"))?;
    }
    Ok(())
}

pub fn import_pdf(app: &AppHandle, source: &str) -> Result<ImportResult, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    ensure_dirs(&root)?;

    let source = PathBuf::from(source);
    let metadata = fs::metadata(&source).map_err(|error| format!("读取文件信息失败：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件".to_string());
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err("文件超过 200 MB，请先压缩或拆分后再导入".to_string());
    }

    let id = hash_file(&source)?;
    let now = now_ms();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(existing) = db::find_by_id(&conn, &id)? {
        let destination = root.join(&existing.rel_path);
        if !destination.exists() {
            copy_atomic(&source, &destination)?;
        }
        db::touch_document(&conn, &id, now)?;
        let document = db::find_by_id(&conn, &id)?.ok_or_else(|| "文档不存在".to_string())?;
        let annotations = merge_document(&conn, &root, &document)?;
        let document = db::find_by_id(&conn, &id)?.unwrap_or(document);
        return Ok(ImportResult {
            document: document.to_document(&root),
            annotations,
        });
    }

    let original_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf");
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
        .unwrap_or("document.pdf")
        .to_string();

    let row = DocumentRow {
        id: id.clone(),
        name: document_name,
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
        annotation_count: 0,
    };
    db::upsert_document(&conn, &row)?;

    let annotations = merge_document(&conn, &root, &row)?;
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
    let mut paths = Vec::new();
    for entry in fs::read_dir(&books).map_err(|error| format!("读取书库失败：{error}"))? {
        let entry = entry.map_err(|error| format!("读取书库条目失败：{error}"))?;
        let path = entry.path();
        if path.is_file() && is_pdf(&path) {
            paths.push(path);
        }
    }
    paths.sort();

    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    let mut seen = std::collections::HashSet::new();
    let mut duplicate_pdfs = 0;

    for path in paths {
        let metadata = fs::metadata(&path).map_err(|error| format!("读取书库文件失败：{error}"))?;
        let size = metadata.len();
        let mtime = mtime_ms(&metadata);
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| "无法计算书库相对路径".to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        let by_path = db::find_by_rel_path(&conn, &relative)?;
        let id = match &by_path {
            Some(row) if row.size == size && row.mtime == mtime => row.id.clone(),
            _ => hash_file(&path)?,
        };

        if !seen.insert(id.clone()) {
            duplicate_pdfs += 1;
            continue;
        }

        if let Some(stale) = &by_path {
            if stale.id != id {
                db::remove_document(&conn, &stale.id)?;
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
        let row = DocumentRow {
            id: id.clone(),
            name,
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
            annotation_count: 0,
        };

        db::upsert_document(&conn, &row)?;
        let files = sidecar_groups.remove(&id).unwrap_or_default();
        reconcile_document(&conn, &root, &row, &files, &mut stats)?;
    }

    let (documents, annotations) = db::counts(&conn)?;
    Ok(ScanReport {
        root: root.to_string_lossy().into_owned(),
        documents,
        annotations,
        merged: stats.merged,
        archived: stats.archived,
        duplicate_pdfs,
        ignored_sidecars: stats.ignored,
        scanned_at: now_ms(),
    })
}

pub fn last_document(app: &AppHandle) -> Result<Option<ImportResult>, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    ensure_dirs(&root)?;

    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    for row in db::list_documents(&conn)? {
        if !root.join(&row.rel_path).exists() {
            continue;
        }
        db::touch_document(&conn, &row.id, now_ms())?;
        let annotations = merge_document(&conn, &root, &row)?;
        let document = db::find_by_id(&conn, &row.id)?.unwrap_or(row);
        return Ok(Some(ImportResult {
            document: document.to_document(&root),
            annotations,
        }));
    }

    Ok(None)
}

pub fn list_documents(app: &AppHandle) -> Result<Vec<Document>, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(db::list_documents(&conn)?
        .iter()
        .map(|row| row.to_document(&root))
        .collect())
}

pub fn open_document(app: &AppHandle, doc_id: &str) -> Result<ImportResult, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    ensure_dirs(&root)?;
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let row = db::find_by_id(&conn, doc_id)?.ok_or_else(|| "文档不存在".to_string())?;
    if !root
        .join(row.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        .exists()
    {
        return Err("文档文件不存在".to_string());
    }

    db::touch_document(&conn, doc_id, now_ms())?;
    let annotations = merge_document(&conn, &root, &row)?;
    let document = db::find_by_id(&conn, doc_id)?.unwrap_or(row);

    Ok(ImportResult {
        document: document.to_document(&root),
        annotations,
    })
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

pub fn search(app: &AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::search_annotations(&conn, &query)
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

pub fn list_annotations(app: &AppHandle, doc_id: &str) -> Result<Vec<Annotation>, String> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    db::list_annotations(&conn, doc_id)
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

pub fn info(app: &AppHandle) -> Result<LibraryInfo, String> {
    let state = app.state::<AppState>();
    let root = state.root();
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (documents, annotations) = db::counts(&conn)?;
    Ok(LibraryInfo {
        root: root.to_string_lossy().into_owned(),
        documents,
        annotations,
    })
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

    fn document(id: &str, rel_path: &str) -> DocumentRow {
        DocumentRow {
            id: id.to_string(),
            name: "doc.pdf".to_string(),
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
        let merged = merge_document(&conn, &root, &row).unwrap();
        assert_eq!(merged[0].body, "newer");

        // 数据库更新、sidecar 落后：旧 sidecar 不得覆盖新数据。
        db::upsert_annotation(&conn, &row.id, &annotation("a1", 30, "database wins")).unwrap();
        let merged = merge_document(&conn, &root, &row).unwrap();
        assert_eq!(merged[0].body, "database wins");

        let _ = fs::remove_dir_all(&dir);
    }

    fn sidecar_for(doc_id: &str, annotations: Vec<Annotation>) -> Sidecar {
        Sidecar {
            schema_version: SIDECAR_VERSION,
            doc_id: doc_id.to_string(),
            name: "doc.pdf".to_string(),
            size: 10,
            page_count: 2,
            annotations,
        }
    }

    #[test]
    fn merges_and_archives_conflict_sidecars() {
        let dir = temp_dir("conflict");
        let root = dir.join("library");
        ensure_dirs(&root).unwrap();
        let conn = db::open(&dir.join("test.db")).unwrap();
        let row = document("doc1", "books/doc1.pdf");
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
        let merged = reconcile_document(&conn, &root, &row, &files, &mut stats).unwrap();

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
        let row = document("doc1", "books/doc1.pdf");

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
        let merged = reconcile_document(&conn, &root, &row, &files, &mut stats).unwrap();

        assert!(merged[0].deleted);
        assert_eq!(stats.archived, 1);
        let canonical: Sidecar =
            serde_json::from_slice(&fs::read(sidecar_path(&root, "doc1")).unwrap()).unwrap();
        assert!(canonical.annotations[0].deleted);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_name_cleans_and_forces_pdf() {
        assert_eq!(safe_name("a:b?.pdf"), "a_b_.pdf");
        assert_eq!(safe_name("report"), "report.pdf");
        assert_eq!(safe_name("   "), "document.pdf");
    }
}
