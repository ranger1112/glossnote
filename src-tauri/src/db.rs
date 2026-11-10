use crate::models::{
    Annotation, Bookmark, Card, CardRef, CardView, Chunk, DocumentBrief, DocumentRow, PageHit,
    PageIndexStatus, PageTextInput, SearchHit,
};
use crate::search;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const DOCUMENT_SELECT: &str = "SELECT d.id, d.name, d.title, d.author, d.page_count, d.rel_path, d.size, d.mtime, d.added_at, d.last_opened_at, d.cover, d.last_page, d.favorite, d.tags, d.bookmarks, d.folder, d.position, d.meta_updated_at, (SELECT COUNT(*) FROM annotations a WHERE a.doc_id = d.id AND a.deleted = 0), d.kind, d.source_path, d.source_url, d.cover_source FROM documents d";

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
    // 云盘同步目录里的库文件偶尔会被别的进程短暂锁住；等一会儿比直接报错好。
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("设置数据库超时失败：{error}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("设置 WAL 失败：{error}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("设置同步模式失败：{error}"))?;
    migrate(&conn)?;
    Ok(conn)
}

/// 索引文件实在打不开时的兜底：本次会话用内存库。
/// PDF 与 sidecar 不受影响，标注照常写入书库，只是阅读进度等本机状态不落盘。
pub fn open_memory() -> Result<Connection, String> {
    let conn =
        Connection::open_in_memory().map_err(|error| format!("创建临时索引失败：{error}"))?;
    migrate(&conn)?;
    Ok(conn)
}

/// 打不开或已损坏时，把旧库改名留档，再从空库重建。
/// 索引是派生数据：`books/` + sidecar 才是真相源，重开一次不会丢标注。
pub fn open_recovering(path: &Path) -> Result<(Connection, Option<PathBuf>), String> {
    match open(path) {
        Ok(conn) => Ok((conn, None)),
        // 只在确认是坏库时才重建。磁盘满、被别的进程锁住这类临时错误
        // 换库解决不了，还会白白丢掉索引。
        Err(first) if looks_corrupt(&first) => {
            let backup = backup_database(path)
                .map_err(|error| format!("{first}；备份旧索引失败：{error}"))?;
            let conn = open(path).map_err(|again| format!("{first}；重建索引仍失败：{again}"))?;
            Ok((conn, Some(backup)))
        }
        Err(first) => Err(first),
    }
}

fn looks_corrupt(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("not a database")
        || lower.contains("malformed")
        || lower.contains("corrupt")
        || lower.contains("encrypted")
}

fn backup_database(path: &Path) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let backup = path.with_extension(format!("db.broken-{stamp}"));
    std::fs::rename(path, &backup).map_err(|error| format!("{error}"))?;

    // -wal / -shm 必须跟着走，否则新库会把旧日志当成自己的。
    for suffix in ["-wal", "-shm"] {
        let extra = append_suffix(path, suffix);
        if extra.exists() {
            let _ = std::fs::rename(&extra, append_suffix(&backup, suffix));
        }
    }
    Ok(backup)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'pdf',
          title TEXT NOT NULL DEFAULT '',
          author TEXT NOT NULL DEFAULT '',
          page_count INTEGER NOT NULL DEFAULT 0,
          rel_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL DEFAULT 0,
          cover TEXT NOT NULL DEFAULT '',
          cover_source TEXT NOT NULL DEFAULT '',
          last_page INTEGER NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          tags TEXT NOT NULL DEFAULT '[]',
          bookmarks TEXT NOT NULL DEFAULT '[]',
          folder TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL DEFAULT 0,
          source_path TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          meta_updated_at INTEGER NOT NULL DEFAULT 0,
          text_indexed_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_rel_path ON documents(rel_path);

        CREATE TABLE IF NOT EXISTS annotations (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          page INTEGER NOT NULL,
          anchor TEXT NOT NULL,
          color TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'highlight',
          body TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(doc_id);

        -- 搜索用 LIKE 子串匹配；0.4 建的 FTS5 表从未被查询过，删掉以免每次写标注多维护一份索引。
        DROP TABLE IF EXISTS annotation_fts;

        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          source_annotation_id TEXT,
          source_doc_id TEXT,
          source_page INTEGER,
          links TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          due_at INTEGER NOT NULL DEFAULT 0,
          stability REAL NOT NULL DEFAULT 0,
          difficulty REAL NOT NULL DEFAULT 0,
          reps INTEGER NOT NULL DEFAULT 0,
          lapses INTEGER NOT NULL DEFAULT 0,
          last_reviewed_at INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'new',
          deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(status, due_at);
        CREATE INDEX IF NOT EXISTS idx_cards_doc ON cards(source_doc_id);
        CREATE INDEX IF NOT EXISTS idx_cards_annotation ON cards(source_annotation_id);

        CREATE TABLE IF NOT EXISTS chunks (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          page INTEGER NOT NULL,
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, page);

        -- 页内查找的逐页原文缓存：按 PDF 内容哈希存，重复搜索不必再跑 pdf.js。
        CREATE TABLE IF NOT EXISTS page_texts (
          doc_id TEXT NOT NULL,
          page INTEGER NOT NULL,
          text TEXT NOT NULL,
          tokens TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (doc_id, page)
        );
        "#,
    )
    .map_err(|error| format!("初始化数据库失败：{error}"))?;

    // 0.3 的库没有 cover / last_page，升级时补列。
    ensure_column(conn, "documents", "kind", "TEXT NOT NULL DEFAULT 'pdf'")?;
    ensure_column(conn, "documents", "cover", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(
        conn,
        "documents",
        "cover_source",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(conn, "documents", "last_page", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "documents", "favorite", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "documents", "tags", "TEXT NOT NULL DEFAULT '[]'")?;
    ensure_column(conn, "documents", "bookmarks", "TEXT NOT NULL DEFAULT '[]'")?;
    ensure_column(conn, "documents", "folder", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "documents", "position", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "documents", "source_path", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "documents", "source_url", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(
        conn,
        "documents",
        "meta_updated_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "documents",
        "text_indexed_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "page_texts", "tokens", "TEXT NOT NULL DEFAULT ''")?;

    // 正文搜索索引：FTS5 只存分词后的 token，原始页面文字仍以 page_texts 为准。
    // 外部内容表的 rowid 直接复用 page_texts 的隐式 rowid，触发器负责同步。
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
          tokens,
          content='page_texts',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS page_texts_ai AFTER INSERT ON page_texts BEGIN
          INSERT INTO page_search(rowid, tokens) VALUES (new.rowid, new.tokens);
        END;
        CREATE TRIGGER IF NOT EXISTS page_texts_ad AFTER DELETE ON page_texts BEGIN
          INSERT INTO page_search(page_search, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
        END;
        CREATE TRIGGER IF NOT EXISTS page_texts_au AFTER UPDATE ON page_texts BEGIN
          INSERT INTO page_search(page_search, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
          INSERT INTO page_search(rowid, tokens) VALUES (new.rowid, new.tokens);
        END;
        "#,
    )
    .map_err(|error| format!("初始化正文搜索索引失败：{error}"))?;

    upgrade_page_search(conn)?;
    Ok(())
}

/// 索引版本：
/// - 0：没有 FTS 索引，page_texts 可能已有行；
/// - 1：索引只有二元组，单字查询回退 LIKE；
/// - 2：单字 + 二元组，单字查询也走 FTS。
///
/// 升级时先按内容表整体重建索引，再按新分词改写 tokens——否则回填的 UPDATE
/// 触发器会对不存在的索引行执行 'delete'，FTS5 会直接报「database disk image
/// is malformed」，上层再把 library.db 当成坏库备份重建，阅读进度等本机状态就丢了。
/// 用 user_version 记住迁移已完成，避免每次启动都重建整本索引。
fn upgrade_page_search(conn: &Connection) -> Result<(), String> {
    const INDEX_VERSION: i64 = 2;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取索引版本失败：{error}"))?;
    if version >= INDEX_VERSION {
        return Ok(());
    }

    conn.execute(
        "INSERT INTO page_search(page_search) VALUES ('rebuild')",
        [],
    )
    .map_err(|error| format!("重建正文搜索索引失败：{error}"))?;
    reindex_page_tokens(conn)?;
    conn.pragma_update(None, "user_version", INDEX_VERSION)
        .map_err(|error| format!("更新索引版本失败：{error}"))?;
    Ok(())
}

/// 用当前分词规则重写所有非空页面的 tokens；空页面没有可索引内容，跳过。
fn reindex_page_tokens(conn: &Connection) -> Result<(), String> {
    let rows: Vec<(i64, String)> = {
        let mut statement = conn
            .prepare("SELECT rowid, text FROM page_texts WHERE text <> ''")
            .map_err(|error| format!("准备正文索引回填失败：{error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| format!("读取正文索引回填数据失败：{error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("读取正文索引回填数据失败：{error}"))?
    };
    if rows.is_empty() {
        return Ok(());
    }

    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("开始正文索引回填事务失败：{error}"))?;
    {
        let mut statement = transaction
            .prepare("UPDATE page_texts SET tokens = ?1 WHERE rowid = ?2")
            .map_err(|error| format!("准备正文索引回填写入失败：{error}"))?;
        for (rowid, text) in rows {
            let tokens = search::tokens(&text).join(" ");
            statement
                .execute(params![tokens, rowid])
                .map_err(|error| format!("写入正文索引回填失败：{error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("提交正文索引回填失败：{error}"))?;
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("读取表结构失败：{error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("读取表结构失败：{error}"))?;

    while let Some(row) = rows
        .next()
        .map_err(|error| format!("读取表结构失败：{error}"))?
    {
        let name: String = row.get(1).map_err(|error| error.to_string())?;
        if name == column {
            return Ok(());
        }
    }

    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )
    .map_err(|error| format!("升级表 {table} 失败：{error}"))?;
    Ok(())
}

fn row_to_document(row: &Row<'_>) -> rusqlite::Result<DocumentRow> {
    Ok(DocumentRow {
        id: row.get(0)?,
        name: row.get(1)?,
        title: row.get(2)?,
        author: row.get(3)?,
        page_count: row.get::<_, i64>(4)? as u32,
        rel_path: row.get(5)?,
        size: row.get::<_, i64>(6)? as u64,
        mtime: row.get(7)?,
        added_at: row.get(8)?,
        last_opened_at: row.get(9)?,
        cover: row.get(10)?,
        last_page: row.get::<_, i64>(11)? as u32,
        favorite: row.get::<_, i64>(12)? != 0,
        tags: serde_json::from_str(&row.get::<_, String>(13)?).unwrap_or_default(),
        bookmarks: serde_json::from_str(&row.get::<_, String>(14)?).unwrap_or_default(),
        folder: row.get(15)?,
        position: row.get(16)?,
        meta_updated_at: row.get(17)?,
        annotation_count: row.get::<_, i64>(18)? as usize,
        kind: row.get(19)?,
        source_path: row.get(20)?,
        source_url: row.get(21)?,
        cover_source: row.get(22)?,
    })
}

pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<DocumentRow>, String> {
    conn.query_row(
        &format!("{DOCUMENT_SELECT} WHERE d.id = ?1"),
        params![id],
        row_to_document,
    )
    .optional()
    .map_err(|error| format!("查询文档失败：{error}"))
}

pub fn list_documents(conn: &Connection) -> Result<Vec<DocumentRow>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{DOCUMENT_SELECT} ORDER BY d.last_opened_at DESC, d.added_at DESC"
        ))
        .map_err(|error| format!("准备文档列表查询失败：{error}"))?;

    let rows = statement
        .query_map([], row_to_document)
        .map_err(|error| format!("查询文档列表失败：{error}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取文档列表失败：{error}"))
}

/// 只取筛选需要的字段，避免为每一行执行标注计数和 JSON 解析。
pub fn list_document_briefs(conn: &Connection) -> Result<Vec<DocumentBrief>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, kind, title, author FROM documents
             ORDER BY last_opened_at DESC, added_at DESC",
        )
        .map_err(|error| format!("准备文档摘要查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(DocumentBrief {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                author: row.get(4)?,
            })
        })
        .map_err(|error| format!("查询文档摘要失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取文档摘要失败：{error}"))
}

pub fn document_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
        params![id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|error| format!("查询文档存在性失败：{error}"))
}

/// 笔记搜索命中后批量映射文档名；避免每条命中都走一次完整文档查询。
pub fn document_names(
    conn: &Connection,
    ids: &[String],
) -> Result<HashMap<String, (String, String)>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT id, name, title FROM documents WHERE id IN ({placeholders})");
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("准备文档名查询失败：{error}"))?;
    let rows = statement
        .query_map(
            rusqlite::params_from_iter(ids.iter().map(|id| id.as_str())),
            |row| Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("查询文档名失败：{error}"))?;

    let mut names = HashMap::new();
    for row in rows {
        let (id, name, title): (String, String, String) =
            row.map_err(|error| format!("读取文档名失败：{error}"))?;
        names.insert(id, (name, title));
    }
    Ok(names)
}

pub fn upsert_document(conn: &Connection, document: &DocumentRow) -> Result<(), String> {
    let tags = serde_json::to_string(&document.tags)
        .map_err(|error| format!("序列化文档标签失败：{error}"))?;
    let bookmarks = serde_json::to_string(&document.bookmarks)
        .map_err(|error| format!("序列化书签失败：{error}"))?;
    conn.execute(
        "INSERT INTO documents
           (id, name, title, author, page_count, rel_path, size, mtime, added_at, last_opened_at, cover, last_page, favorite, tags, bookmarks, folder, position, meta_updated_at, kind, source_path, source_url, cover_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           title = excluded.title,
           author = excluded.author,
           page_count = excluded.page_count,
           rel_path = excluded.rel_path,
           size = excluded.size,
           mtime = excluded.mtime,
           cover = excluded.cover,
           last_page = excluded.last_page,
           favorite = excluded.favorite,
           tags = excluded.tags,
           bookmarks = excluded.bookmarks,
           folder = excluded.folder,
           position = excluded.position,
           source_path = excluded.source_path,
           source_url = excluded.source_url,
           cover_source = excluded.cover_source,
           meta_updated_at = excluded.meta_updated_at",
        params![
            document.id,
            document.name,
            document.title,
            document.author,
            document.page_count as i64,
            document.rel_path,
            document.size as i64,
            document.mtime,
            document.added_at,
            document.last_opened_at,
            document.cover,
            document.last_page as i64,
            document.favorite as i64,
            tags,
            bookmarks,
            document.folder,
            document.position,
            document.meta_updated_at,
            document.kind,
            document.source_path,
            document.source_url,
            document.cover_source,
        ],
    )
    .map_err(|error| format!("写入文档失败：{error}"))?;
    Ok(())
}

/// 收藏、文档标签与虚拟文件夹：只改组织字段，并推进 sidecar 合并用的时间戳。
pub fn update_organization(
    conn: &Connection,
    id: &str,
    favorite: Option<bool>,
    tags: Option<&[String]>,
    folder: Option<&str>,
    bookmarks: Option<&[Bookmark]>,
    now: i64,
) -> Result<DocumentRow, String> {
    let mut row = find_by_id(conn, id)?.ok_or_else(|| "文档不存在".to_string())?;
    if let Some(value) = favorite {
        row.favorite = value;
    }
    if let Some(value) = tags {
        row.tags = value.to_vec();
    }
    if let Some(value) = folder {
        row.folder = value.to_string();
    }
    if let Some(value) = bookmarks {
        row.bookmarks = value.to_vec();
    }
    row.meta_updated_at = now;

    let tags_json =
        serde_json::to_string(&row.tags).map_err(|error| format!("序列化文档标签失败：{error}"))?;
    let bookmarks_json = serde_json::to_string(&row.bookmarks)
        .map_err(|error| format!("序列化书签失败：{error}"))?;
    conn.execute(
        "UPDATE documents SET favorite = ?1, tags = ?2, folder = ?3, bookmarks = ?4, meta_updated_at = ?5 WHERE id = ?6",
        params![
            row.favorite as i64,
            tags_json,
            row.folder,
            bookmarks_json,
            row.meta_updated_at,
            id
        ],
    )
    .map_err(|error| format!("保存文档整理信息失败：{error}"))?;
    Ok(row)
}

/// 手动排序：按传入顺序重排全部文档。位置只存在本机索引里，不写 sidecar。
pub fn reorder_documents(conn: &Connection, ids: &[String]) -> Result<(), String> {
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("开始排序事务失败：{error}"))?;
    {
        let mut statement = transaction
            .prepare("UPDATE documents SET position = ?1 WHERE id = ?2")
            .map_err(|error| format!("准备排序写入失败：{error}"))?;
        for (index, id) in ids.iter().enumerate() {
            statement
                .execute(params![index as i64, id])
                .map_err(|error| format!("保存排序失败：{error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("提交排序失败：{error}"))?;
    Ok(())
}

pub fn touch_document(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE documents SET last_opened_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|error| format!("更新最近打开时间失败：{error}"))?;
    Ok(())
}

pub fn save_progress(conn: &Connection, id: &str, last_page: u32) -> Result<(), String> {
    conn.execute(
        "UPDATE documents SET last_page = ?1 WHERE id = ?2",
        params![last_page as i64, id],
    )
    .map_err(|error| format!("保存阅读进度失败：{error}"))?;
    Ok(())
}

pub fn set_cover(conn: &Connection, id: &str, cover: &str, source: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE documents SET cover = ?1, cover_source = ?2 WHERE id = ?3",
        params![cover, source, id],
    )
    .map_err(|error| format!("保存封面失败：{error}"))?;
    Ok(())
}

pub fn update_meta(
    conn: &Connection,
    id: &str,
    page_count: Option<u32>,
    title: Option<&str>,
    author: Option<&str>,
) -> Result<(), String> {
    if let Some(page_count) = page_count {
        conn.execute(
            "UPDATE documents SET page_count = ?1 WHERE id = ?2",
            params![page_count as i64, id],
        )
        .map_err(|error| format!("更新页数失败：{error}"))?;
    }
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        conn.execute(
            "UPDATE documents SET title = ?1 WHERE id = ?2",
            params![title.trim(), id],
        )
        .map_err(|error| format!("更新标题失败：{error}"))?;
    }
    if let Some(author) = author.filter(|value| !value.trim().is_empty()) {
        conn.execute(
            "UPDATE documents SET author = ?1 WHERE id = ?2",
            params![author.trim(), id],
        )
        .map_err(|error| format!("更新作者失败：{error}"))?;
    }
    Ok(())
}

fn row_to_annotation(row: &Row<'_>) -> rusqlite::Result<Annotation> {
    row_to_annotation_at(row, 0)
}

/// 允许在 SELECT 前多取一列（例如 doc_id），再从 offset 开始映射标注字段。
fn row_to_annotation_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<Annotation> {
    let anchor_text: String = row.get(offset + 2)?;
    let tags_text: String = row.get(offset + 6)?;
    Ok(Annotation {
        id: row.get(offset)?,
        page: row.get::<_, i64>(offset + 1)? as u32,
        anchor: serde_json::from_str(&anchor_text).unwrap_or(serde_json::Value::Null),
        color: row.get(offset + 3)?,
        kind: row.get(offset + 4)?,
        body: row.get(offset + 5)?,
        tags: serde_json::from_str(&tags_text).unwrap_or_default(),
        created_at: row.get(offset + 7)?,
        updated_at: row.get(offset + 8)?,
        deleted: row.get::<_, i64>(offset + 9)? != 0,
    })
}

pub fn list_annotations(conn: &Connection, doc_id: &str) -> Result<Vec<Annotation>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted
             FROM annotations WHERE doc_id = ?1 ORDER BY page ASC, created_at ASC",
        )
        .map_err(|error| format!("准备标注查询失败：{error}"))?;

    let rows = statement
        .query_map(params![doc_id], row_to_annotation)
        .map_err(|error| format!("查询标注失败：{error}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取标注失败：{error}"))
}

/// 带过滤与分页的标注列表；page 为 0 基，kind/color 为 None 表示不筛选。
pub fn list_annotations_filtered(
    conn: &Connection,
    doc_id: &str,
    page: Option<u32>,
    kind: Option<&str>,
    color: Option<&str>,
    limit: usize,
) -> Result<(Vec<Annotation>, usize), String> {
    const FILTER: &str = "doc_id = ?1 AND deleted = 0
        AND (?2 IS NULL OR page = ?2)
        AND (?3 IS NULL OR kind = ?3)
        AND (?4 IS NULL OR color = ?4)";
    let page = page.map(|value| value as i64);

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM annotations WHERE {FILTER}"),
            params![doc_id, page, kind, color],
            |row| row.get(0),
        )
        .map_err(|error| format!("统计标注失败：{error}"))?;

    let mut statement = conn
        .prepare(&format!(
            "SELECT id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted
             FROM annotations WHERE {FILTER} ORDER BY page ASC, created_at ASC LIMIT ?5"
        ))
        .map_err(|error| format!("准备标注查询失败：{error}"))?;
    let rows = statement
        .query_map(
            params![doc_id, page, kind, color, limit as i64],
            row_to_annotation,
        )
        .map_err(|error| format!("查询标注失败：{error}"))?;

    let annotations = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取标注失败：{error}"))?;
    Ok((annotations, total.max(0) as usize))
}

pub fn get_annotation(conn: &Connection, id: &str) -> Result<Option<Annotation>, String> {
    conn.query_row(
        "SELECT id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted
         FROM annotations WHERE id = ?1",
        params![id],
        row_to_annotation,
    )
    .optional()
    .map_err(|error| format!("查询标注失败：{error}"))
}

pub fn get_annotation_in_doc(
    conn: &Connection,
    doc_id: &str,
    id: &str,
) -> Result<Option<Annotation>, String> {
    conn.query_row(
        "SELECT id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted
         FROM annotations WHERE doc_id = ?1 AND id = ?2 AND deleted = 0",
        params![doc_id, id],
        row_to_annotation,
    )
    .optional()
    .map_err(|error| format!("查询标注失败：{error}"))
}

/// 笔记引用解析：返回标注所属文档与标注本身，删除的标注不返回。
pub fn get_annotation_with_doc(
    conn: &Connection,
    id: &str,
) -> Result<Option<(String, Annotation)>, String> {
    conn.query_row(
        "SELECT doc_id, id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted
         FROM annotations WHERE id = ?1 AND deleted = 0",
        params![id],
        |row| {
            let doc_id: String = row.get(0)?;
            Ok((doc_id, row_to_annotation_at(row, 1)?))
        },
    )
    .optional()
    .map_err(|error| format!("查询标注失败：{error}"))
}

pub fn upsert_annotation(
    conn: &Connection,
    doc_id: &str,
    annotation: &Annotation,
) -> Result<(), String> {
    let anchor = serde_json::to_string(&annotation.anchor)
        .map_err(|error| format!("序列化锚点失败：{error}"))?;
    let tags = serde_json::to_string(&annotation.tags)
        .map_err(|error| format!("序列化标签失败：{error}"))?;

    conn.execute(
        "INSERT INTO annotations
           (id, doc_id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           doc_id = excluded.doc_id,
           page = excluded.page,
           anchor = excluded.anchor,
           color = excluded.color,
           kind = excluded.kind,
           body = excluded.body,
           tags = excluded.tags,
           updated_at = excluded.updated_at,
           deleted = excluded.deleted",
        params![
            annotation.id,
            doc_id,
            annotation.page as i64,
            anchor,
            annotation.color,
            annotation.kind,
            annotation.body,
            tags,
            annotation.created_at,
            annotation.updated_at,
            annotation.deleted as i64,
        ],
    )
    .map_err(|error| format!("写入标注失败：{error}"))?;

    // 撤销删除会把 deleted = 0 的同一条标注写回来；来源卡片要跟着恢复可用。
    if !annotation.deleted {
        conn.execute(
            "UPDATE cards SET status = 'active', updated_at = ?2
             WHERE source_annotation_id = ?1 AND status = 'orphaned' AND deleted = 0",
            params![annotation.id, annotation.updated_at],
        )
        .map_err(|error| format!("恢复卡片状态失败：{error}"))?;
    }

    Ok(())
}

pub fn search_annotations(conn: &Connection, query: &str) -> Result<Vec<SearchHit>, String> {
    search_annotations_filtered(conn, query, None, 100)
}

pub fn search_annotations_filtered(
    conn: &Connection,
    query: &str,
    doc_id: Option<&str>,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let term = query.trim();
    if term.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");

    let mut statement = conn
        .prepare(
            "SELECT a.id, a.doc_id, d.name, a.page, a.anchor, a.body, a.color, a.kind, a.tags,
                    a.created_at, a.updated_at
             FROM annotations a
             JOIN documents d ON d.id = a.doc_id
             WHERE a.deleted = 0
               AND (?2 IS NULL OR a.doc_id = ?2)
               AND (
                 -- 只搜引文本身：整段 anchor JSON 里还有坐标和 pageHash，
                 -- 直接 LIKE 会让 start、pageHash 这类查询命中所有标注。
                 COALESCE(json_extract(a.anchor, '$.quote'), '') LIKE ?1 ESCAPE '\\'
                 OR a.body LIKE ?1 ESCAPE '\\'
                 OR a.tags LIKE ?1 ESCAPE '\\'
                 OR d.name LIKE ?1 ESCAPE '\\'
                 OR d.title LIKE ?1 ESCAPE '\\'
               )
             ORDER BY a.updated_at DESC
             LIMIT ?3",
        )
        .map_err(|error| format!("准备搜索失败：{error}"))?;

    let rows = statement
        .query_map(params![pattern, doc_id, limit as i64], |row| {
            let anchor_text: String = row.get(4)?;
            let tags_text: String = row.get(8)?;
            let anchor: serde_json::Value =
                serde_json::from_str(&anchor_text).unwrap_or(serde_json::Value::Null);
            Ok(SearchHit {
                annotation_id: row.get(0)?,
                doc_id: row.get(1)?,
                doc_name: row.get(2)?,
                page: row.get::<_, i64>(3)? as u32,
                quote: anchor
                    .get("quote")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: row.get(5)?,
                color: row.get(6)?,
                kind: row.get(7)?,
                tags: serde_json::from_str(&tags_text).unwrap_or_default(),
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|error| format!("搜索失败：{error}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取搜索结果失败：{error}"))
}

pub fn count_annotations(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM annotations WHERE deleted = 0",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as usize)
    .map_err(|error| format!("统计标注失败：{error}"))
}

pub fn is_text_indexed(conn: &Connection, doc_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT text_indexed_at FROM documents WHERE id = ?1",
        params![doc_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0) > 0)
    .map_err(|error| format!("查询全文索引状态失败：{error}"))
}

pub fn replace_chunks(
    conn: &mut Connection,
    doc_id: &str,
    chunks: &[Chunk],
    now: i64,
) -> Result<usize, String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("开始全文索引事务失败：{error}"))?;
    tx.execute("DELETE FROM chunks WHERE doc_id = ?1", params![doc_id])
        .map_err(|error| format!("清理旧全文索引失败：{error}"))?;
    {
        let mut statement = tx
            .prepare("INSERT INTO chunks (id, doc_id, page, text) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|error| format!("准备全文索引写入失败：{error}"))?;
        for chunk in chunks {
            statement
                .execute(params![
                    chunk.id,
                    chunk.doc_id,
                    chunk.page as i64,
                    chunk.text
                ])
                .map_err(|error| format!("写入全文索引失败：{error}"))?;
        }
    }
    // 扫描件没有文字时不要把状态标成已索引，否则界面会一直提供无效的“全文总结”。
    let indexed_at = if chunks.is_empty() { 0 } else { now };
    tx.execute(
        "UPDATE documents SET text_indexed_at = ?2 WHERE id = ?1",
        params![doc_id, indexed_at],
    )
    .map_err(|error| format!("更新全文索引状态失败：{error}"))?;
    tx.commit()
        .map_err(|error| format!("提交全文索引失败：{error}"))?;
    Ok(chunks.len())
}

pub fn list_chunks(conn: &Connection, doc_id: &str) -> Result<Vec<Chunk>, String> {
    let mut statement = conn
        .prepare("SELECT id, doc_id, page, text FROM chunks WHERE doc_id = ?1 ORDER BY page ASC")
        .map_err(|error| format!("准备全文查询失败：{error}"))?;
    let rows = statement
        .query_map(params![doc_id], |row| {
            Ok(Chunk {
                id: row.get(0)?,
                doc_id: row.get(1)?,
                page: row.get::<_, i64>(2)? as u32,
                text: row.get(3)?,
            })
        })
        .map_err(|error| format!("查询全文失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取全文失败：{error}"))
}

/// 页内查找的文字缓存；与 chunks 分开，保留完整分页原文与精确偏移。
pub fn load_page_texts(conn: &Connection, doc_id: &str) -> Result<Vec<PageTextInput>, String> {
    let mut statement = conn
        .prepare("SELECT page, text FROM page_texts WHERE doc_id = ?1 ORDER BY page ASC")
        .map_err(|error| format!("准备页面文字查询失败：{error}"))?;
    let rows = statement
        .query_map(params![doc_id], |row| {
            Ok(PageTextInput {
                page: row.get::<_, i64>(0)? as u32,
                text: row.get(1)?,
            })
        })
        .map_err(|error| format!("查询页面文字失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取页面文字失败：{error}"))
}

/// 读取指定页范围（0 基、闭区间）的正文；MCP 分页读取用。
pub fn page_texts_range(
    conn: &Connection,
    doc_id: &str,
    start: u32,
    end: u32,
) -> Result<Vec<(u32, String)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT page, text FROM page_texts
             WHERE doc_id = ?1 AND page >= ?2 AND page <= ?3
             ORDER BY page ASC",
        )
        .map_err(|error| format!("准备页面文字查询失败：{error}"))?;
    let rows = statement
        .query_map(params![doc_id, start as i64, end as i64], |row| {
            Ok((row.get::<_, i64>(0)? as u32, row.get(1)?))
        })
        .map_err(|error| format!("查询页面文字失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取页面文字失败：{error}"))
}

/// 已缓存正文的最大页号；文档 page_count 为 0 时兜底。
pub fn page_texts_max_page(conn: &Connection, doc_id: &str) -> Result<Option<u32>, String> {
    conn.query_row(
        "SELECT MAX(page) FROM page_texts WHERE doc_id = ?1",
        params![doc_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .map(|value| value.map(|page| page.max(0) as u32))
    .map_err(|error| format!("查询页面文字范围失败：{error}"))
}

/// 页面文字缓存是否覆盖 [0, page_count) 的每一页；用于避免重复建立索引。
pub fn page_texts_ready(conn: &Connection, doc_id: &str, page_count: u32) -> Result<bool, String> {
    if page_count == 0 {
        return Ok(true);
    }
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT page) FROM page_texts
             WHERE doc_id = ?1 AND page >= 0 AND page < ?2",
            params![doc_id, page_count as i64],
            |row| row.get(0),
        )
        .map_err(|error| format!("统计页面文字失败：{error}"))?;
    Ok(count >= page_count as i64)
}

/// 删除超出当前分页数量的旧缓存；分页规则变化后避免搜索命中不存在的页。
pub fn prune_page_texts(conn: &Connection, doc_id: &str, page_count: u32) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM page_texts WHERE doc_id = ?1 AND page >= ?2",
        params![doc_id, page_count as i64],
    )
    .map_err(|error| format!("清理页面文字失败：{error}"))
}

pub fn save_page_texts(
    conn: &Connection,
    doc_id: &str,
    pages: &[PageTextInput],
) -> Result<usize, String> {
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("开始页面文字事务失败：{error}"))?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO page_texts (doc_id, page, text, tokens) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(doc_id, page) DO UPDATE SET
                   text = excluded.text,
                   tokens = excluded.tokens",
            )
            .map_err(|error| format!("准备页面文字写入失败：{error}"))?;
        for page in pages {
            let tokens = search::tokens(&page.text).join(" ");
            statement
                .execute(params![doc_id, page.page as i64, &page.text, tokens])
                .map_err(|error| format!("写入页面文字失败：{error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("提交页面文字失败：{error}"))?;
    Ok(pages.len())
}

/// 全库正文搜索。命中来自 page_texts（已缓存正文的页面），片段从原文截取。
pub fn search_pages(conn: &Connection, query: &str) -> Result<Vec<PageHit>, String> {
    search_pages_filtered(conn, query, None, 100)
}

pub fn search_pages_filtered(
    conn: &Connection,
    query: &str,
    doc_id: Option<&str>,
    limit: usize,
) -> Result<Vec<PageHit>, String> {
    let term = query.trim();
    if term.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let Some(expression) = search::match_query(term) else {
        return Ok(Vec::new());
    };
    let mut statement = conn
        .prepare(
            "SELECT p.doc_id, d.name, p.page, p.text
             FROM page_search
             JOIN page_texts p ON p.rowid = page_search.rowid
             JOIN documents d ON d.id = p.doc_id
             WHERE page_search MATCH ?1
               AND (?2 IS NULL OR p.doc_id = ?2)
             ORDER BY bm25(page_search)
             LIMIT ?3",
        )
        .map_err(|error| format!("准备正文搜索失败：{error}"))?;
    let rows = statement
        .query_map(params![expression, doc_id, limit as i64], |row| {
            let text: String = row.get(3)?;
            Ok(PageHit {
                doc_id: row.get(0)?,
                doc_name: row.get(1)?,
                page: row.get::<_, i64>(2)? as u32,
                snippet: search::snippet(&text, term),
            })
        })
        .map_err(|error| format!("搜索正文失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取正文搜索结果失败：{error}"))
}

pub fn page_index_status(conn: &Connection) -> Result<PageIndexStatus, String> {
    let documents: i64 = conn
        .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
        .map_err(|error| format!("统计文档失败：{error}"))?;
    let pages: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(page_count), 0) FROM documents",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("统计页数失败：{error}"))?;
    // 只有缓存覆盖了全部页面的文档才算完整索引：一次搜索命中 500 条就停下时
    // 只缓存了前几页，不能把这份文档当成「已索引」而隐藏建索引入口。
    let indexed_documents: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM documents d
             WHERE d.page_count > 0
               AND (SELECT COUNT(*) FROM page_texts p WHERE p.doc_id = d.id) >= d.page_count",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("统计已索引文档失败：{error}"))?;
    let indexed_pages: i64 = conn
        .query_row("SELECT COUNT(*) FROM page_texts", [], |row| row.get(0))
        .map_err(|error| format!("统计已索引页数失败：{error}"))?;

    Ok(PageIndexStatus {
        documents: documents as usize,
        indexed_documents: indexed_documents as usize,
        pages: pages as usize,
        indexed_pages: indexed_pages as usize,
    })
}

/// 每份文档已缓存的页面数；书库页用它判断哪些文档已经建好正文索引。
pub fn page_text_counts(conn: &Connection) -> Result<HashMap<String, usize>, String> {
    let mut statement = conn
        .prepare("SELECT doc_id, COUNT(*) FROM page_texts GROUP BY doc_id")
        .map_err(|error| format!("准备页面文字统计失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
        })
        .map_err(|error| format!("读取页面文字统计失败：{error}"))?;
    rows.collect::<rusqlite::Result<HashMap<String, usize>>>()
        .map_err(|error| format!("读取页面文字统计失败：{error}"))
}

/// 切换书库时清空索引；书库目录里的 PDF 与 sidecar 不受影响。
pub fn clear_library(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM cards;
         DELETE FROM chunks;
         DELETE FROM page_texts;
         DELETE FROM annotations;
         DELETE FROM documents;",
    )
    .map_err(|error| format!("清空书库索引失败：{error}"))
}

const CARD_COLUMNS: &str = "id, title, body, source_annotation_id, source_doc_id, source_page, links, status, created_at, updated_at, due_at, stability, difficulty, reps, lapses, last_reviewed_at, state, deleted";
const CARD_COLUMNS_QUALIFIED: &str = "c.id, c.title, c.body, c.source_annotation_id, c.source_doc_id, c.source_page, c.links, c.status, c.created_at, c.updated_at, c.due_at, c.stability, c.difficulty, c.reps, c.lapses, c.last_reviewed_at, c.state, c.deleted";

fn row_to_card(row: &Row<'_>) -> rusqlite::Result<Card> {
    let links_text: String = row.get(6)?;
    Ok(Card {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        source_annotation_id: row.get(3)?,
        source_doc_id: row.get(4)?,
        source_page: row.get::<_, Option<i64>>(5)?.map(|page| page as u32),
        links: serde_json::from_str(&links_text).unwrap_or_default(),
        status: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        due_at: row.get(10)?,
        stability: row.get(11)?,
        difficulty: row.get(12)?,
        reps: row.get::<_, i64>(13)? as u32,
        lapses: row.get::<_, i64>(14)? as u32,
        last_reviewed_at: row.get(15)?,
        state: row.get(16)?,
        deleted: row.get::<_, i64>(17)? != 0,
    })
}

pub fn get_card(conn: &Connection, id: &str) -> Result<Option<Card>, String> {
    conn.query_row(
        &format!("SELECT {CARD_COLUMNS} FROM cards WHERE id = ?1"),
        params![id],
        row_to_card,
    )
    .optional()
    .map_err(|error| format!("查询卡片失败：{error}"))
}

pub fn find_card_by_annotation(
    conn: &Connection,
    annotation_id: &str,
) -> Result<Option<Card>, String> {
    conn.query_row(
        &format!(
            "SELECT {CARD_COLUMNS} FROM cards WHERE source_annotation_id = ?1
             ORDER BY updated_at DESC LIMIT 1"
        ),
        params![annotation_id],
        row_to_card,
    )
    .optional()
    .map_err(|error| format!("查询标注卡片失败：{error}"))
}

pub fn upsert_card(conn: &Connection, card: &Card) -> Result<(), String> {
    let links = serde_json::to_string(&card.links)
        .map_err(|error| format!("序列化卡片链接失败：{error}"))?;

    conn.execute(
        "INSERT INTO cards
           (id, title, body, source_annotation_id, source_doc_id, source_page, links, status,
            created_at, updated_at, due_at, stability, difficulty, reps, lapses,
            last_reviewed_at, state, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           source_annotation_id = excluded.source_annotation_id,
           source_doc_id = excluded.source_doc_id,
           source_page = excluded.source_page,
           links = excluded.links,
           status = excluded.status,
           updated_at = excluded.updated_at,
           due_at = excluded.due_at,
           stability = excluded.stability,
           difficulty = excluded.difficulty,
           reps = excluded.reps,
           lapses = excluded.lapses,
           last_reviewed_at = excluded.last_reviewed_at,
           state = excluded.state,
           deleted = excluded.deleted",
        params![
            card.id,
            card.title,
            card.body,
            card.source_annotation_id,
            card.source_doc_id,
            card.source_page.map(|page| page as i64),
            links,
            card.status,
            card.created_at,
            card.updated_at,
            card.due_at,
            card.stability,
            card.difficulty,
            card.reps as i64,
            card.lapses as i64,
            card.last_reviewed_at,
            card.state,
            card.deleted as i64,
        ],
    )
    .map_err(|error| format!("写入卡片失败：{error}"))?;
    Ok(())
}

/// 写 sidecar 时用：包含墓碑，保证删除也能同步。
pub fn list_cards_for_document(conn: &Connection, doc_id: &str) -> Result<Vec<Card>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {CARD_COLUMNS} FROM cards WHERE source_doc_id = ?1 ORDER BY created_at ASC"
        ))
        .map_err(|error| format!("准备文档卡片查询失败：{error}"))?;

    let rows = statement
        .query_map(params![doc_id], row_to_card)
        .map_err(|error| format!("查询文档卡片失败：{error}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取文档卡片失败：{error}"))
}

pub fn list_cards(conn: &Connection) -> Result<Vec<CardView>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {CARD_COLUMNS_QUALIFIED}, COALESCE(d.name, ''), COALESCE(a.anchor, '')
             FROM cards c
             LEFT JOIN documents d ON d.id = c.source_doc_id
             LEFT JOIN annotations a ON a.id = c.source_annotation_id
             WHERE c.deleted = 0
             ORDER BY c.due_at ASC, c.created_at DESC"
        ))
        .map_err(|error| format!("准备卡片列表查询失败：{error}"))?;

    let rows = statement
        .query_map([], |row| {
            let card = row_to_card(row)?;
            let doc_name: String = row.get(18)?;
            let anchor_text: String = row.get(19)?;
            let anchor: serde_json::Value =
                serde_json::from_str(&anchor_text).unwrap_or(serde_json::Value::Null);
            let source_quote = anchor
                .get("quote")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            Ok(CardView {
                card,
                doc_name,
                source_quote,
                backlinks: Vec::new(),
                previews: Vec::new(),
            })
        })
        .map_err(|error| format!("查询卡片列表失败：{error}"))?;

    let mut views = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取卡片列表失败：{error}"))?;

    let refs: Vec<(String, String, Vec<String>)> = views
        .iter()
        .map(|view| {
            (
                view.card.id.clone(),
                view.card.title.clone(),
                view.card.links.clone(),
            )
        })
        .collect();

    for view in &mut views {
        view.backlinks = refs
            .iter()
            .filter(|(id, _, links)| {
                id != &view.card.id && links.iter().any(|link| link == &view.card.id)
            })
            .map(|(id, title, _)| CardRef {
                id: id.clone(),
                title: title.clone(),
            })
            .collect();
    }

    Ok(views)
}

/// 标注被删除或从 sidecar 合并为墓碑后，来源卡片保留内容但标记失效。
pub fn orphan_cards_for_document(
    conn: &Connection,
    doc_id: &str,
    now: i64,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE cards SET status = 'orphaned', updated_at = ?2
         WHERE deleted = 0 AND status = 'active' AND source_doc_id = ?1
           AND source_annotation_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM annotations a
             WHERE a.id = cards.source_annotation_id AND a.deleted = 0
           )",
        params![doc_id, now],
    )
    .map_err(|error| format!("标记失效卡片失败：{error}"))
}

pub fn orphan_cards_for_annotation(
    conn: &Connection,
    annotation_id: &str,
    now: i64,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE cards SET status = 'orphaned', updated_at = ?2
         WHERE deleted = 0 AND status = 'active' AND source_annotation_id = ?1",
        params![annotation_id, now],
    )
    .map_err(|error| format!("标记失效卡片失败：{error}"))
}

pub fn remove_document(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE cards SET status = 'orphaned', updated_at = ?2 WHERE source_doc_id = ?1",
        params![id, now],
    )
    .map_err(|error| format!("标记失效卡片失败：{error}"))?;
    conn.execute("DELETE FROM chunks WHERE doc_id = ?1", params![id])
        .map_err(|error| format!("清理全文索引失败：{error}"))?;
    conn.execute("DELETE FROM page_texts WHERE doc_id = ?1", params![id])
        .map_err(|error| format!("清理页面文字缓存失败：{error}"))?;
    conn.execute("DELETE FROM annotations WHERE doc_id = ?1", params![id])
        .map_err(|error| format!("清理标注失败：{error}"))?;
    conn.execute("DELETE FROM documents WHERE id = ?1", params![id])
        .map_err(|error| format!("清理文档失败：{error}"))?;
    Ok(())
}

pub fn counts(conn: &Connection) -> Result<(usize, usize), String> {
    let documents: i64 = conn
        .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
        .map_err(|error| format!("统计文档失败：{error}"))?;
    let annotations: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM annotations WHERE deleted = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("统计标注失败：{error}"))?;
    Ok((documents as usize, annotations as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO documents
               (id, name, title, author, page_count, rel_path, size, mtime, added_at)
             VALUES ('d1', 'doc.pdf', '', '', 1, 'books/doc.pdf', 1, 1, 1)",
            [],
        )
        .unwrap();

        let annotation = Annotation {
            id: "a1".to_string(),
            page: 0,
            anchor: serde_json::json!({
                "quote": "标注的价值不在数量",
                "start": 12,
                "end": 21,
                "pageHash": "f1a4122c",
                "rects": [{ "x": 0.11753, "y": 0.2116, "w": 0.34722, "h": 0.02001 }],
            }),
            color: "yellow".to_string(),
            kind: "highlight".to_string(),
            body: String::new(),
            tags: Vec::new(),
            created_at: 1,
            updated_at: 1,
            deleted: false,
        };
        upsert_annotation(&conn, "d1", &annotation).unwrap();
        conn
    }

    #[test]
    fn page_text_readiness_and_prune() {
        let conn = seeded();
        assert!(!page_texts_ready(&conn, "d1", 2).unwrap());

        save_page_texts(
            &conn,
            "d1",
            &[
                PageTextInput {
                    page: 0,
                    text: "a".to_string(),
                },
                PageTextInput {
                    page: 2,
                    text: "c".to_string(),
                },
            ],
        )
        .unwrap();
        // 中间缺页时不能算完整。
        assert!(!page_texts_ready(&conn, "d1", 3).unwrap());

        save_page_texts(
            &conn,
            "d1",
            &[PageTextInput {
                page: 1,
                text: "b".to_string(),
            }],
        )
        .unwrap();
        assert!(page_texts_ready(&conn, "d1", 3).unwrap());

        assert_eq!(prune_page_texts(&conn, "d1", 2).unwrap(), 1);
        assert!(page_texts_ready(&conn, "d1", 2).unwrap());
        assert_eq!(load_page_texts(&conn, "d1").unwrap().len(), 2);
    }

    #[test]
    fn document_kind_defaults_to_pdf_and_round_trips() {
        let conn = seeded();
        let mut row = find_by_id(&conn, "d1").unwrap().unwrap();
        assert_eq!(row.kind, "pdf");

        row.kind = "epub".to_string();
        upsert_document(&conn, &row).unwrap();
        assert_eq!(find_by_id(&conn, "d1").unwrap().unwrap().kind, "epub");
    }

    #[test]
    fn cover_source_round_trips() {
        let conn = seeded();
        assert_eq!(find_by_id(&conn, "d1").unwrap().unwrap().cover_source, "");

        set_cover(&conn, "d1", "thumbnails/d1.jpg", "native").unwrap();
        let row = find_by_id(&conn, "d1").unwrap().unwrap();
        assert_eq!(row.cover, "thumbnails/d1.jpg");
        assert_eq!(row.cover_source, "native");
    }

    #[test]
    fn recovers_from_corrupt_database() {
        let dir = std::env::temp_dir().join(format!("glossnote-db-recover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        std::fs::write(&path, b"this is not a sqlite database").unwrap();

        let (conn, backup) = open_recovering(&path).unwrap();
        let backup = backup.expect("坏库应当被备份");
        assert!(backup.exists());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_text_cache_round_trips_and_clears_with_document() {
        let conn = seeded();
        save_page_texts(
            &conn,
            "d1",
            &[
                PageTextInput {
                    page: 0,
                    text: "第一页".to_string(),
                },
                PageTextInput {
                    page: 1,
                    text: String::new(),
                },
            ],
        )
        .unwrap();

        let pages = load_page_texts(&conn, "d1").unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].text, "第一页");
        assert_eq!(pages[1].page, 1);
        assert!(pages[1].text.is_empty());

        // 同一页再次提取时覆盖旧值，空页也要留着，避免下次重复提取。
        save_page_texts(
            &conn,
            "d1",
            &[PageTextInput {
                page: 0,
                text: "改过".to_string(),
            }],
        )
        .unwrap();
        let pages = load_page_texts(&conn, "d1").unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].text, "改过");

        remove_document(&conn, "d1", 2).unwrap();
        assert!(load_page_texts(&conn, "d1").unwrap().is_empty());
    }

    #[test]
    fn restoring_annotation_reactivates_orphaned_card() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards
               (id, title, body, source_annotation_id, source_doc_id, source_page, links,
                status, created_at, updated_at)
             VALUES ('c1', '卡片', '', 'a1', 'd1', 0, '[]', 'orphaned', 1, 1)",
            [],
        )
        .unwrap();

        // 撤销删除会把同一条标注以 deleted = 0 写回来。
        let annotation = get_annotation(&conn, "a1").unwrap().unwrap();
        upsert_annotation(&conn, "d1", &annotation).unwrap();

        let status: String = conn
            .query_row("SELECT status FROM cards WHERE id = 'c1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "active");
    }

    #[test]
    fn full_text_search_matches_chinese_english_and_single_char() {
        let conn = seeded();
        save_page_texts(
            &conn,
            "d1",
            &[
                PageTextInput {
                    page: 0,
                    text: "认知科学是研究心智的科学。Annotating is the heart.".to_string(),
                },
                PageTextInput {
                    page: 1,
                    text: "第二页没有关键词。".to_string(),
                },
                PageTextInput {
                    page: 2,
                    text: "认知与科学分开写，不算一个短语。".to_string(),
                },
            ],
        )
        .unwrap();

        let hits = search_pages(&conn, "认知").unwrap();
        let mut pages: Vec<u32> = hits.iter().map(|hit| hit.page).collect();
        pages.sort_unstable();
        assert_eq!(pages, vec![0, 2]);
        assert!(hits
            .iter()
            .find(|hit| hit.page == 0)
            .unwrap()
            .snippet
            .contains("认知科学"));

        // 连续中文按二元组短语匹配：分开写的「认知」「科学」不算「认知科学」。
        let phrase = search_pages(&conn, "认知科学").unwrap();
        assert_eq!(phrase.len(), 1);
        assert_eq!(phrase[0].page, 0);

        assert_eq!(search_pages(&conn, "annot").unwrap().len(), 1);
        assert_eq!(search_pages(&conn, "科").unwrap().len(), 2);
        assert!(search_pages(&conn, "不存在").unwrap().is_empty());

        // 覆盖写同一页后，FTS 里不能残留旧内容。
        save_page_texts(
            &conn,
            "d1",
            &[PageTextInput {
                page: 0,
                text: "全新的页面文字。".to_string(),
            }],
        )
        .unwrap();
        assert!(search_pages(&conn, "认知科学").unwrap().is_empty());
        assert_eq!(search_pages(&conn, "全新").unwrap().len(), 1);
    }

    #[test]
    fn reindexes_existing_page_texts() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO page_texts (doc_id, page, text, tokens)
             VALUES ('d1', 0, '旧缓存正文', '')",
            [],
        )
        .unwrap();

        reindex_page_tokens(&conn).unwrap();
        let hits = search_pages(&conn, "旧缓存").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("旧缓存正文"));
    }

    #[test]
    fn upgrade_rebuilds_index_before_backfill() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO page_texts (doc_id, page, text, tokens)
             VALUES ('d1', 0, '旧缓存正文', '')",
            [],
        )
        .unwrap();
        // 模拟 0.2.2 的库：内容表已有行，FTS 索引还是空的，迁移标记未写。
        conn.execute(
            "INSERT INTO page_search(page_search) VALUES ('delete-all')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();

        // 修复前：回填的 UPDATE 触发器对空索引执行 delete，报 SQLITE_CORRUPT。
        migrate(&conn).unwrap();
        assert_eq!(search_pages(&conn, "旧缓存").unwrap().len(), 1);
        // 单字查询也要在迁移后立即可用。
        assert_eq!(search_pages(&conn, "缓").unwrap().len(), 1);
    }

    #[test]
    fn upgrade_v1_index_adds_single_char_tokens() {
        let conn = seeded();
        // 模拟 0.3.2 的索引：只有二元组，没有单字。
        conn.execute(
            "INSERT INTO page_texts (doc_id, page, text, tokens)
             VALUES ('d1', 0, '认知科学', '认知 知科 科学')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();

        // 旧索引下单字查询命中不了；迁移后重写 tokens 才能走 FTS。
        migrate(&conn).unwrap();
        assert_eq!(search_pages(&conn, "科").unwrap().len(), 1);
        assert_eq!(search_pages(&conn, "认知科学").unwrap().len(), 1);
        assert_eq!(search_pages(&conn, "认知").unwrap().len(), 1);
    }

    #[test]
    fn upgrade_with_only_empty_pages_keeps_deletes_working() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO page_texts (doc_id, page, text, tokens) VALUES ('d1', 0, '', '')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO page_search(page_search) VALUES ('delete-all')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();

        // 空文本页不会触发回填；索引也必须先重建，否则 DELETE 触发器的 delete 会报损坏。
        migrate(&conn).unwrap();
        remove_document(&conn, "d1", 2).unwrap();
    }

    #[test]
    fn single_char_terms_use_fts_index() {
        let conn = seeded();
        save_page_texts(
            &conn,
            "d1",
            &[
                PageTextInput {
                    page: 0,
                    text: "我的认知".to_string(),
                },
                PageTextInput {
                    page: 1,
                    text: "人与物".to_string(),
                },
            ],
        )
        .unwrap();

        let hits = search_pages(&conn, "我 认知").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].page, 0);

        let hits = search_pages(&conn, "人，物").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].page, 1);
    }

    #[test]
    fn page_index_status_requires_every_page() {
        let conn = seeded();
        conn.execute("UPDATE documents SET page_count = 3 WHERE id = 'd1'", [])
            .unwrap();
        save_page_texts(
            &conn,
            "d1",
            &[PageTextInput {
                page: 0,
                text: "第一页".to_string(),
            }],
        )
        .unwrap();

        let status = page_index_status(&conn).unwrap();
        assert_eq!(status.documents, 1);
        // 只缓存了 1/3 页：不能算作已建好正文索引。
        assert_eq!(status.indexed_documents, 0);
        assert_eq!(status.pages, 3);
        assert_eq!(status.indexed_pages, 1);
    }

    #[test]
    fn page_index_status_counts_documents_and_pages() {
        let conn = seeded();
        save_page_texts(
            &conn,
            "d1",
            &[
                PageTextInput {
                    page: 0,
                    text: "第一页".to_string(),
                },
                PageTextInput {
                    page: 1,
                    text: String::new(),
                },
            ],
        )
        .unwrap();

        let status = page_index_status(&conn).unwrap();
        assert_eq!(status.documents, 1);
        assert_eq!(status.indexed_documents, 1);
        assert_eq!(status.pages, 1);
        assert_eq!(status.indexed_pages, 2);
    }

    #[test]
    fn search_matches_quote_only() {
        let conn = seeded();
        assert_eq!(search_annotations(&conn, "标注的价值").unwrap().len(), 1);

        // 这些词只出现在 anchor 的 JSON 结构里，不是用户能看到的正文。
        for query in ["start", "rects", "pageHash", "0.11753"] {
            assert!(
                search_annotations(&conn, query).unwrap().is_empty(),
                "查询 {query} 不应命中任何标注"
            );
        }
    }

    #[test]
    fn filtered_annotation_search_scopes_to_document_and_limit() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO documents
               (id, name, title, author, page_count, rel_path, size, mtime, added_at)
             VALUES ('d2', 'other.pdf', '', '', 1, 'books/other.pdf', 1, 1, 1)",
            [],
        )
        .unwrap();
        let annotation = Annotation {
            id: "a2".to_string(),
            page: 0,
            anchor: serde_json::json!({ "quote": "标注也在另一篇" }),
            color: "green".to_string(),
            kind: "underline".to_string(),
            body: String::new(),
            tags: Vec::new(),
            created_at: 2,
            updated_at: 2,
            deleted: false,
        };
        upsert_annotation(&conn, "d2", &annotation).unwrap();

        let all = search_annotations_filtered(&conn, "标注", None, 100).unwrap();
        assert_eq!(all.len(), 2);
        let scoped = search_annotations_filtered(&conn, "标注", Some("d1"), 100).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].doc_id, "d1");
        assert_eq!(scoped[0].kind, "highlight");
        assert!(
            search_annotations_filtered(&conn, "标注", Some("missing"), 100)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            search_annotations_filtered(&conn, "标注", None, 1)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn annotation_lookup_exposes_doc_and_hides_tombstones() {
        let conn = seeded();
        let (doc_id, annotation) = get_annotation_with_doc(&conn, "a1").unwrap().unwrap();
        assert_eq!(doc_id, "d1");
        assert_eq!(annotation.id, "a1");
        assert!(get_annotation_in_doc(&conn, "d2", "a1").unwrap().is_none());

        let mut tombstone = annotation;
        tombstone.deleted = true;
        tombstone.updated_at = 2;
        upsert_annotation(&conn, "d1", &tombstone).unwrap();
        assert!(get_annotation_with_doc(&conn, "a1").unwrap().is_none());
        assert!(get_annotation_in_doc(&conn, "d1", "a1").unwrap().is_none());
        assert_eq!(count_annotations(&conn).unwrap(), 0);
    }

    #[test]
    fn page_text_range_and_max_page_are_bounded() {
        let conn = seeded();
        save_page_texts(
            &conn,
            "d1",
            &[
                PageTextInput {
                    page: 0,
                    text: "零".to_string(),
                },
                PageTextInput {
                    page: 2,
                    text: "二".to_string(),
                },
            ],
        )
        .unwrap();

        let rows = page_texts_range(&conn, "d1", 0, 2).unwrap();
        assert_eq!(rows, vec![(0, "零".to_string()), (2, "二".to_string())]);
        assert!(page_texts_range(&conn, "d1", 3, 9).unwrap().is_empty());
        assert_eq!(page_texts_max_page(&conn, "d1").unwrap(), Some(2));
        assert_eq!(page_texts_max_page(&conn, "missing").unwrap(), None);
    }

    #[test]
    fn document_briefs_and_names_avoid_full_rows() {
        let conn = seeded();
        let briefs = list_document_briefs(&conn).unwrap();
        assert_eq!(briefs.len(), 1);
        assert_eq!(briefs[0].id, "d1");
        assert_eq!(briefs[0].kind, "pdf");
        assert!(document_exists(&conn, "d1").unwrap());
        assert!(!document_exists(&conn, "missing").unwrap());

        let names = document_names(&conn, &["d1".to_string(), "missing".to_string()]).unwrap();
        assert_eq!(
            names.get("d1").map(|(name, _)| name.as_str()),
            Some("doc.pdf")
        );
        assert!(!names.contains_key("missing"));
    }

    #[test]
    fn filtered_annotation_list_applies_filters_and_limit() {
        let conn = seeded();
        let second = Annotation {
            id: "a2".to_string(),
            page: 1,
            anchor: serde_json::json!({ "quote": "第二页标注" }),
            color: "green".to_string(),
            kind: "underline".to_string(),
            body: "正文".to_string(),
            tags: Vec::new(),
            created_at: 2,
            updated_at: 2,
            deleted: false,
        };
        upsert_annotation(&conn, "d1", &second).unwrap();

        let mut tombstone = second.clone();
        tombstone.id = "a3".to_string();
        tombstone.deleted = true;
        upsert_annotation(&conn, "d1", &tombstone).unwrap();

        let (items, total) =
            list_annotations_filtered(&conn, "d1", Some(0), Some("highlight"), Some("yellow"), 10)
                .unwrap();
        assert_eq!(total, 1);
        assert_eq!(items[0].id, "a1");

        let (items, total) =
            list_annotations_filtered(&conn, "d1", Some(1), Some("underline"), None, 10).unwrap();
        assert_eq!(total, 1);
        assert_eq!(items[0].id, "a2");

        let (items, total) = list_annotations_filtered(&conn, "d1", None, None, None, 1).unwrap();
        assert_eq!(total, 2);
        assert_eq!(items.len(), 1);
    }
}
