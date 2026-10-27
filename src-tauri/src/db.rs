use crate::models::{Annotation, DocumentRow};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

const DOCUMENT_COLUMNS: &str =
    "id, name, title, author, page_count, rel_path, size, mtime, added_at, last_opened_at";

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
          last_opened_at INTEGER NOT NULL DEFAULT 0
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
    .map_err(|error| format!("初始化数据库失败：{error}"))
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
    })
}

pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<DocumentRow>, String> {
    conn.query_row(
        &format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE id = ?1"),
        params![id],
        row_to_document,
    )
    .optional()
    .map_err(|error| format!("查询文档失败：{error}"))
}

pub fn find_by_rel_path(conn: &Connection, rel_path: &str) -> Result<Option<DocumentRow>, String> {
    conn.query_row(
        &format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE rel_path = ?1"),
        params![rel_path],
        row_to_document,
    )
    .optional()
    .map_err(|error| format!("查询文档路径失败：{error}"))
}

pub fn list_documents(conn: &Connection) -> Result<Vec<DocumentRow>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {DOCUMENT_COLUMNS} FROM documents ORDER BY last_opened_at DESC, added_at DESC"
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
           (id, name, title, author, page_count, rel_path, size, mtime, added_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           title = excluded.title,
           author = excluded.author,
           page_count = excluded.page_count,
           rel_path = excluded.rel_path,
           size = excluded.size,
           mtime = excluded.mtime",
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

pub fn list_annotations(conn: &Connection, doc_id: &str) -> Result<Vec<Annotation>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted
             FROM annotations WHERE doc_id = ?1 ORDER BY page ASC, created_at ASC",
        )
        .map_err(|error| format!("准备标注查询失败：{error}"))?;

    let rows = statement
        .query_map(params![doc_id], |row| {
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
        })
        .map_err(|error| format!("查询标注失败：{error}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取标注失败：{error}"))
}

pub fn get_annotation(conn: &Connection, id: &str) -> Result<Option<Annotation>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, page, anchor, color, kind, body, tags, created_at, updated_at, deleted
             FROM annotations WHERE id = ?1",
        )
        .map_err(|error| format!("准备标注查询失败：{error}"))?;

    statement
        .query_row(params![id], |row| {
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
        })
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
