use crate::models::{Annotation, DocumentRow, SearchHit};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

const DOCUMENT_SELECT: &str = "SELECT d.id, d.name, d.title, d.author, d.page_count, d.rel_path, d.size, d.mtime, d.added_at, d.last_opened_at, d.cover, d.last_page, (SELECT COUNT(*) FROM annotations a WHERE a.doc_id = d.id AND a.deleted = 0) FROM documents d";

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("设置 WAL 失败：{error}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("设置同步模式失败：{error}"))?;
    migrate(&conn)?;
    Ok(conn)
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
          last_page INTEGER NOT NULL DEFAULT 0
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
        "#,
    )
    .map_err(|error| format!("初始化数据库失败：{error}"))?;

    // 0.3 的库没有 cover / last_page，升级时补列。
    ensure_column(conn, "documents", "cover", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "documents", "last_page", "INTEGER NOT NULL DEFAULT 0")?;
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
               a.anchor LIKE ?1 ESCAPE '\\'
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

/// 切换书库时清空索引；书库目录里的 PDF 与 sidecar 不受影响。
pub fn clear_library(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM annotation_fts;
         DELETE FROM annotations;
         DELETE FROM documents;",
    )
    .map_err(|error| format!("清空书库索引失败：{error}"))
}

pub fn remove_document(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM annotation_fts WHERE doc_id = ?1", params![id])
        .map_err(|error| format!("清理搜索索引失败：{error}"))?;
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
