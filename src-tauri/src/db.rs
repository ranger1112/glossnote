use crate::models::{Annotation, Card, CardRef, CardView, Chunk, DocumentRow, SearchHit};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::{Path, PathBuf};

const DOCUMENT_SELECT: &str = "SELECT d.id, d.name, d.title, d.author, d.page_count, d.rel_path, d.size, d.mtime, d.added_at, d.last_opened_at, d.cover, d.last_page, (SELECT COUNT(*) FROM annotations a WHERE a.doc_id = d.id AND a.deleted = 0) FROM documents d";

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
    let conn = Connection::open_in_memory().map_err(|error| format!("创建临时索引失败：{error}"))?;
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
          title TEXT NOT NULL DEFAULT '',
          author TEXT NOT NULL DEFAULT '',
          page_count INTEGER NOT NULL DEFAULT 0,
          rel_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL DEFAULT 0,
          cover TEXT NOT NULL DEFAULT '',
          last_page INTEGER NOT NULL DEFAULT 0,
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

        CREATE VIRTUAL TABLE IF NOT EXISTS annotation_fts USING fts5(
          annotation_id UNINDEXED,
          doc_id UNINDEXED,
          quote,
          body
        );

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
        "#,
    )
    .map_err(|error| format!("初始化数据库失败：{error}"))?;

    // 0.3 的库没有 cover / last_page，升级时补列。
    ensure_column(conn, "documents", "cover", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "documents", "last_page", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(
        conn,
        "documents",
        "text_indexed_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
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
        annotation_count: row.get::<_, i64>(12)? as usize,
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

pub fn find_by_rel_path(conn: &Connection, rel_path: &str) -> Result<Option<DocumentRow>, String> {
    conn.query_row(
        &format!("{DOCUMENT_SELECT} WHERE d.rel_path = ?1"),
        params![rel_path],
        row_to_document,
    )
    .optional()
    .map_err(|error| format!("查询文档路径失败：{error}"))
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

pub fn upsert_document(conn: &Connection, document: &DocumentRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO documents
           (id, name, title, author, page_count, rel_path, size, mtime, added_at, last_opened_at, cover, last_page)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           title = excluded.title,
           author = excluded.author,
           page_count = excluded.page_count,
           rel_path = excluded.rel_path,
           size = excluded.size,
           mtime = excluded.mtime,
           cover = excluded.cover,
           last_page = excluded.last_page",
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
        ],
    )
    .map_err(|error| format!("写入文档失败：{error}"))?;
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

pub fn set_cover(conn: &Connection, id: &str, cover: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE documents SET cover = ?1 WHERE id = ?2",
        params![cover, id],
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
    let anchor_text: String = row.get(2)?;
    let tags_text: String = row.get(6)?;
    Ok(Annotation {
        id: row.get(0)?,
        page: row.get::<_, i64>(1)? as u32,
        anchor: serde_json::from_str(&anchor_text).unwrap_or(serde_json::Value::Null),
        color: row.get(3)?,
        kind: row.get(4)?,
        body: row.get(5)?,
        tags: serde_json::from_str(&tags_text).unwrap_or_default(),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted: row.get::<_, i64>(9)? != 0,
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

    conn.execute(
        "DELETE FROM annotation_fts WHERE annotation_id = ?1",
        params![annotation.id],
    )
    .map_err(|error| format!("更新搜索索引失败：{error}"))?;

    if !annotation.deleted {
        let quote = annotation
            .anchor
            .get("quote")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        conn.execute(
            "INSERT INTO annotation_fts (annotation_id, doc_id, quote, body)
             VALUES (?1, ?2, ?3, ?4)",
            params![annotation.id, doc_id, quote, annotation.body],
        )
        .map_err(|error| format!("写入搜索索引失败：{error}"))?;
    }

    Ok(())
}

pub fn search_annotations(conn: &Connection, query: &str) -> Result<Vec<SearchHit>, String> {
    let term = query.trim();
    if term.is_empty() {
        return Ok(Vec::new());
    }

    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");

    let mut statement = conn
        .prepare(
            "SELECT a.id, a.doc_id, d.name, a.page, a.anchor, a.body, a.color, a.tags
             FROM annotations a
             JOIN documents d ON d.id = a.doc_id
             WHERE a.deleted = 0 AND (
               -- 只搜引文本身：整段 anchor JSON 里还有坐标和 pageHash，
               -- 直接 LIKE 会让 start、pageHash 这类查询命中所有标注。
               COALESCE(json_extract(a.anchor, '$.quote'), '') LIKE ?1 ESCAPE '\\'
               OR a.body LIKE ?1 ESCAPE '\\'
               OR a.tags LIKE ?1 ESCAPE '\\'
               OR d.name LIKE ?1 ESCAPE '\\'
               OR d.title LIKE ?1 ESCAPE '\\'
             )
             ORDER BY a.updated_at DESC
             LIMIT 100",
        )
        .map_err(|error| format!("准备搜索失败：{error}"))?;

    let rows = statement
        .query_map(params![pattern], |row| {
            let anchor_text: String = row.get(4)?;
            let tags_text: String = row.get(7)?;
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
                tags: serde_json::from_str(&tags_text).unwrap_or_default(),
            })
        })
        .map_err(|error| format!("搜索失败：{error}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取搜索结果失败：{error}"))
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

/// 切换书库时清空索引；书库目录里的 PDF 与 sidecar 不受影响。
pub fn clear_library(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM annotation_fts;
         DELETE FROM cards;
         DELETE FROM chunks;
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
    conn.execute("DELETE FROM annotation_fts WHERE doc_id = ?1", params![id])
        .map_err(|error| format!("清理搜索索引失败：{error}"))?;
    conn.execute("DELETE FROM chunks WHERE doc_id = ?1", params![id])
        .map_err(|error| format!("清理全文索引失败：{error}"))?;
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
}
