use crate::settings::write_atomic;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// 单篇笔记上限；读取与写入都检查，避免把超大文件塞进 UI/MCP。
pub const NOTE_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub text: String,
    pub updated_at: i64,
    /// 文件不存在时为 ""；存在时为 UTF-8 内容的 sha256 小写十六进制。
    pub revision: String,
}

impl NoteFile {
    fn empty() -> Self {
        Self {
            text: String::new(),
            updated_at: 0,
            revision: String::new(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum NoteSaveOutcome {
    Saved { note: NoteFile },
    Conflict { current: NoteFile },
}

#[derive(Clone, Debug)]
pub struct NoteScanHit {
    pub doc_id: String,
    pub snippet: String,
    pub position: usize,
}

pub(crate) fn valid_doc_id(doc_id: &str) -> bool {
    (1..=128).contains(&doc_id.len())
        && doc_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn note_path(root: &Path, doc_id: &str) -> Result<PathBuf, String> {
    if !valid_doc_id(doc_id) {
        return Err("文档 id 不合法".to_string());
    }
    Ok(root
        .join(".glossnote")
        .join("notes")
        .join(format!("{doc_id}.md")))
}

pub fn read_note(root: &Path, doc_id: &str) -> Result<NoteFile, String> {
    let path = note_path(root, doc_id)?;
    if !path.exists() {
        return Ok(NoteFile::empty());
    }

    let metadata = fs::metadata(&path).map_err(|error| format!("读取笔记信息失败：{error}"))?;
    if metadata.len() > NOTE_MAX_BYTES {
        return Err(format!(
            "笔记超过 {} MB，无法读取",
            NOTE_MAX_BYTES / 1024 / 1024
        ));
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取笔记失败：{error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "笔记不是 UTF-8 编码".to_string())?;
    Ok(NoteFile {
        // 外部留下的空文件按「没有笔记」处理，避免空文件挡住第一次保存。
        revision: if text.is_empty() {
            String::new()
        } else {
            sha256_hex(text.as_bytes())
        },
        updated_at: mtime_ms(&metadata),
        text,
    })
}

pub fn save_note(
    root: &Path,
    doc_id: &str,
    text: &str,
    expected_revision: &str,
) -> Result<NoteSaveOutcome, String> {
    let path = note_path(root, doc_id)?;
    let current = match read_note(root, doc_id) {
        Ok(note) => note,
        // 文件存在但超过 2 MB 或不是 UTF-8：客户端本来就没拿到 revision。
        // 允许用当前可见内容覆盖或清空，否则这条笔记永远无法恢复。
        Err(_) if expected_revision.is_empty() => NoteFile::empty(),
        Err(error) => return Err(error),
    };
    if current.revision != expected_revision {
        return Ok(NoteSaveOutcome::Conflict { current });
    }

    if text.len() as u64 > NOTE_MAX_BYTES {
        return Err(format!(
            "笔记超过 {} MB，无法保存",
            NOTE_MAX_BYTES / 1024 / 1024
        ));
    }

    if text.trim().is_empty() {
        if path.exists() {
            fs::remove_file(&path).map_err(|error| format!("删除空笔记失败：{error}"))?;
        }
        return Ok(NoteSaveOutcome::Saved {
            note: NoteFile {
                text: String::new(),
                updated_at: now_ms(),
                revision: String::new(),
            },
        });
    }

    write_atomic(&path, text.as_bytes()).map_err(|error| format!("保存笔记失败：{error}"))?;
    Ok(NoteSaveOutcome::Saved {
        note: read_note(root, doc_id)?,
    })
}

/// 书库搜索用的轻量扫描：大小写不敏感子串匹配，跳过超大/非 UTF-8 文件。
pub fn scan_notes(root: &Path, query: &str, limit: usize) -> Result<Vec<NoteScanHit>, String> {
    let term = query.trim();
    if term.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let directory = root.join(".glossnote").join("notes");
    let Ok(entries) = fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };

    let needle = term.to_lowercase();
    let mut hits = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let Some(doc_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !valid_doc_id(doc_id) {
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > NOTE_MAX_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if !text.to_lowercase().contains(&needle) {
            continue;
        }

        // 中文大小写不变，精确匹配总能拿到正确偏移；只有 Unicode 大小写
        // 改写导致偏移不可靠时，片段退回从文件开头截取。
        let byte_position = text.find(term);
        // 对外统一用 UTF-16 code unit，与浏览器 indexOf 的语义一致。
        let position = byte_position
            .map(|offset| text[..offset].encode_utf16().count())
            .unwrap_or(0);
        hits.push(NoteScanHit {
            doc_id: doc_id.to_string(),
            snippet: snippet_around(&text, byte_position.unwrap_or(0)),
            position,
        });
        if hits.len() >= limit {
            break;
        }
    }

    hits.sort_by(|left, right| left.doc_id.cmp(&right.doc_id));
    Ok(hits)
}

fn snippet_around(text: &str, position: usize) -> String {
    let start_char = text[..position.min(text.len())]
        .chars()
        .count()
        .saturating_sub(60);
    text.chars()
        .skip(start_char)
        .take(160)
        .collect::<String>()
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glossnote-notes-{label}-{}", process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".glossnote").join("notes")).unwrap();
        dir
    }

    #[test]
    fn reads_absent_note_as_empty() {
        let root = temp_dir("absent");
        let note = read_note(&root, "doc1").unwrap();
        assert_eq!(note.text, "");
        assert_eq!(note.revision, "");
        assert_eq!(note.updated_at, 0);
    }

    #[test]
    fn empty_external_file_is_treated_as_no_note() {
        let root = temp_dir("empty-file");
        fs::write(note_path(&root, "doc1").unwrap(), "").unwrap();
        let note = read_note(&root, "doc1").unwrap();
        assert_eq!(note.text, "");
        assert_eq!(note.revision, "");
    }

    #[test]
    fn saves_and_reloads_note() {
        let root = temp_dir("roundtrip");
        let saved = save_note(&root, "doc1", "第一行\n第二行", "").unwrap();
        let NoteSaveOutcome::Saved { note } = saved else {
            panic!("expected saved");
        };
        assert_eq!(note.text, "第一行\n第二行");
        assert!(!note.revision.is_empty());
        assert_eq!(read_note(&root, "doc1").unwrap(), note);
        assert_eq!(
            fs::read_to_string(note_path(&root, "doc1").unwrap()).unwrap(),
            "第一行\n第二行"
        );
    }

    #[test]
    fn stale_revision_returns_conflict() {
        let root = temp_dir("conflict");
        save_note(&root, "doc1", "第一版", "").unwrap();
        let conflict = save_note(&root, "doc1", "第二版", "").unwrap();
        let NoteSaveOutcome::Conflict { current } = conflict else {
            panic!("expected conflict");
        };
        assert_eq!(current.text, "第一版");
        assert_eq!(read_note(&root, "doc1").unwrap().text, "第一版");
    }

    #[test]
    fn empty_note_removes_file() {
        let root = temp_dir("empty");
        let NoteSaveOutcome::Saved { note } = save_note(&root, "doc1", "内容", "").unwrap()
        else {
            panic!("expected saved");
        };
        let removed = save_note(&root, "doc1", "  \n", &note.revision).unwrap();
        let NoteSaveOutcome::Saved { note } = removed else {
            panic!("expected saved");
        };
        assert_eq!(note.revision, "");
        assert!(!note_path(&root, "doc1").unwrap().exists());
    }

    #[test]
    fn rejects_oversized_note() {
        let root = temp_dir("oversized");
        let text = "a".repeat(NOTE_MAX_BYTES as usize + 1);
        let error = save_note(&root, "doc1", &text, "").unwrap_err();
        assert!(error.contains("MB"));
    }

    #[test]
    fn replaces_unreadable_existing_note() {
        let root = temp_dir("unreadable");
        let path = note_path(&root, "doc1").unwrap();
        fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();

        let saved = save_note(&root, "doc1", "恢复内容", "").unwrap();
        let NoteSaveOutcome::Saved { note } = saved else {
            panic!("expected saved");
        };
        assert_eq!(note.text, "恢复内容");
        assert_eq!(read_note(&root, "doc1").unwrap().text, "恢复内容");
    }

    #[test]
    fn clears_oversized_existing_note() {
        let root = temp_dir("oversized-clear");
        let path = note_path(&root, "doc1").unwrap();
        fs::write(&path, vec![b'x'; NOTE_MAX_BYTES as usize + 1]).unwrap();

        let cleared = save_note(&root, "doc1", "  \n", "").unwrap();
        let NoteSaveOutcome::Saved { note } = cleared else {
            panic!("expected saved");
        };
        assert_eq!(note.revision, "");
        assert!(!path.exists());
    }

    #[test]
    fn unreadable_note_with_stale_revision_stays_put() {
        let root = temp_dir("unreadable-stale");
        let path = note_path(&root, "doc1").unwrap();
        fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();

        assert!(save_note(&root, "doc1", "新内容", "stale").is_err());
        assert!(path.exists());
    }

    #[test]
    fn rejects_invalid_doc_id() {
        let root = temp_dir("invalid");
        assert!(note_path(&root, "../escape").is_err());
        assert!(note_path(&root, "a/b").is_err());
        assert!(note_path(&root, "").is_err());
    }

    #[test]
    fn note_hit_position_uses_utf16_code_units() {
        let root = temp_dir("utf16");
        save_note(&root, "doc1", "😀 hello", "").unwrap();

        let hits = scan_notes(&root, "hello", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].position, 3);
    }

    #[test]
    fn scans_notes_case_insensitively_and_skips_large_files() {
        let root = temp_dir("scan");
        save_note(&root, "doc1", "Hello GlossNote 世界", "").unwrap();
        save_note(&root, "doc2", "another note", "").unwrap();
        fs::write(
            note_path(&root, "doc3").unwrap(),
            "x".repeat(NOTE_MAX_BYTES as usize + 1),
        )
        .unwrap();

        let hits = scan_notes(&root, "hello", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].doc_id, "doc1");
        assert!(hits[0].snippet.contains("Hello"));

        let hits = scan_notes(&root, "世界", 10).unwrap();
        assert_eq!(hits.len(), 1);

        let hits = scan_notes(&root, "missing", 10).unwrap();
        assert!(hits.is_empty());
    }
}
