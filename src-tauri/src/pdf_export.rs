//! 把 GlossNote 的标注写进一份新的 PDF。
//!
//! 使用 PDF 原生的标注类型（Highlight / Underline / StrikeOut / Text），
//! 由阅读器负责透明度和外观；不需要嵌入字体，中文批注放在 /Contents 里。

use crate::models::Annotation;
use lopdf::{dictionary, Document, Object, ObjectId, StringFormat};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    process,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn append_annotations(
    input: &Path,
    output: &Path,
    annotations: &[Annotation],
) -> Result<usize, String> {
    if input == output {
        return Err("请另存为新的 PDF，不要覆盖原文件".to_string());
    }

    let mut doc = Document::load(input).map_err(|error| format!("读取 PDF 失败：{error}"))?;
    let pages = doc.get_pages();
    let mut by_page: BTreeMap<u32, Vec<&Annotation>> = BTreeMap::new();
    for annotation in annotations.iter().filter(|item| !item.deleted) {
        by_page.entry(annotation.page).or_default().push(annotation);
    }

    let mut written = 0;
    for (page_index, items) in by_page {
        let Some(page_id) = pages.get(&(page_index + 1)).copied() else {
            continue;
        };
        let (x0, y0, x1, y1) = page_box(&doc, page_id)?;
        let width = x1 - x0;
        let height = y1 - y0;
        if width <= 0.0 || height <= 0.0 {
            continue;
        }

        for annotation in items {
            let Some(rects) = anchor_rects(annotation) else {
                continue;
            };
            if rects.is_empty() {
                continue;
            }

            let color = color_rgb(&annotation.color);
            let (quad_points, bounds) = quad_points(&rects, x0, y1, width, height);
            let subtype = match annotation.kind.as_str() {
                "underline" => "Underline",
                "strikethrough" => "StrikeOut",
                _ => "Highlight",
            };

            let mark_id = doc.add_object(dictionary! {
                "Type" => "Annot",
                "Subtype" => subtype,
                "Rect" => bounds,
                "QuadPoints" => quad_points,
                "C" => color_array(color),
                "CA" => 0.45f32,
                "F" => 4_i32,
                "Contents" => pdf_text(annotation.anchor_quote()),
                "T" => pdf_literal("GlossNote"),
            });
            push_annotation(&mut doc, page_id, mark_id)?;
            written += 1;

            if !annotation.body.trim().is_empty() {
                let [r, g, b] = color;
                let text_id = doc.add_object(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Text",
                    "Rect" => text_icon_rect(&rects, x0, y1, width, height),
                    "Contents" => pdf_text(&note_text(annotation)),
                    "T" => pdf_literal("GlossNote"),
                    "C" => Object::Array(vec![r.into(), g.into(), b.into()]),
                    "F" => 4_i32,
                    "Name" => "Comment",
                    "Open" => false,
                });
                push_annotation(&mut doc, page_id, text_id)?;
            }
        }
    }

    write_pdf(&mut doc, output)?;
    Ok(written)
}

/// 页面可见区域（CropBox，缺省 MediaBox）。属性可能继承自 Pages 节点。
fn page_box(doc: &Document, page_id: ObjectId) -> Result<(f32, f32, f32, f32), String> {
    let value = inherited(doc, page_id, b"CropBox")
        .or_else(|| inherited(doc, page_id, b"MediaBox"))
        .ok_or_else(|| "页面缺少 CropBox / MediaBox".to_string())?;
    let array = value
        .as_array()
        .map_err(|_| "页面边界不是数组".to_string())?;
    if array.len() < 4 {
        return Err("页面边界不完整".to_string());
    }
    Ok((
        number(&array[0]),
        number(&array[1]),
        number(&array[2]),
        number(&array[3]),
    ))
}

fn inherited<'a>(doc: &'a Document, mut id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    for _ in 0..16 {
        let dictionary = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dictionary.get(key) {
            return Some(value);
        }
        match dictionary.get(b"Parent") {
            Ok(Object::Reference(parent)) => id = *parent,
            _ => return None,
        }
    }
    None
}

fn number(value: &Object) -> f32 {
    match value {
        Object::Integer(value) => *value as f32,
        Object::Real(value) => *value,
        _ => 0.0,
    }
}

#[derive(Clone, Copy)]
struct Rect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

fn anchor_rects(annotation: &Annotation) -> Option<Vec<Rect>> {
    let values = annotation.anchor.get("rects")?.as_array()?;
    let rects: Vec<Rect> = values
        .iter()
        .filter_map(|value| {
            Some(Rect {
                x: value.get("x")?.as_f64()? as f32,
                y: value.get("y")?.as_f64()? as f32,
                w: value.get("w")?.as_f64()? as f32,
                h: value.get("h")?.as_f64()? as f32,
            })
        })
        .collect();
    (!rects.is_empty()).then_some(rects)
}

fn quad_points(rects: &[Rect], x0: f32, y1: f32, width: f32, height: f32) -> (Object, Object) {
    let mut points = Vec::with_capacity(rects.len() * 8);
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;

    for rect in rects {
        let left = x0 + rect.x * width;
        let right = x0 + (rect.x + rect.w) * width;
        let top = y1 - rect.y * height;
        let bottom = y1 - (rect.y + rect.h) * height;
        // PDF 的 QuadPoints 顺序：左上、右上、左下、右下。
        points.extend([left, top, right, top, left, bottom, right, bottom]);
        min_x = min_x.min(left);
        min_y = min_y.min(bottom);
        max_x = max_x.max(right);
        max_y = max_y.max(top);
    }

    let array = points.into_iter().map(Object::Real).collect();
    (
        Object::Array(array),
        Object::Array(vec![min_x.into(), min_y.into(), max_x.into(), max_y.into()]),
    )
}

fn text_icon_rect(rects: &[Rect], x0: f32, y1: f32, width: f32, height: f32) -> Object {
    let rect = rects[0];
    let right = x0 + (rect.x + rect.w) * width;
    let top = y1 - rect.y * height;
    Object::Array(vec![
        (right - 18.0).into(),
        (top - 18.0).into(),
        right.into(),
        top.into(),
    ])
}

fn color_rgb(color: &str) -> [f32; 3] {
    match color {
        "green" => [0.65, 0.95, 0.79],
        "blue" => [0.72, 0.83, 1.0],
        "pink" => [1.0, 0.77, 0.88],
        _ => [1.0, 0.88, 0.4],
    }
}

fn color_array([r, g, b]: [f32; 3]) -> Object {
    Object::Array(vec![r.into(), g.into(), b.into()])
}

fn note_text(annotation: &Annotation) -> String {
    let mut text = annotation.body.trim().to_string();
    if !annotation.tags.is_empty() {
        text.push_str("\n\n");
        text.push_str(
            &annotation
                .tags
                .iter()
                .map(|tag| format!("#{tag}"))
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    text
}

/// PDF 文本字符串用 UTF-16BE + BOM，中文不依赖阅读器字体。
fn pdf_text(text: &str) -> Object {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

fn pdf_literal(text: &str) -> Object {
    Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
}

fn push_annotation(
    doc: &mut Document,
    page_id: ObjectId,
    annot_id: ObjectId,
) -> Result<(), String> {
    let existing = doc
        .get_dictionary(page_id)
        .ok()
        .and_then(|page| page.get(b"Annots").ok())
        .cloned();

    match existing {
        Some(Object::Reference(array_id)) => {
            doc.get_object_mut(array_id)
                .and_then(Object::as_array_mut)
                .map_err(|error| format!("写入页面标注失败：{error}"))?
                .push(Object::Reference(annot_id));
        }
        Some(Object::Array(mut array)) => {
            array.push(Object::Reference(annot_id));
            doc.get_object_mut(page_id)
                .and_then(Object::as_dict_mut)
                .map_err(|error| format!("写入页面标注失败：{error}"))?
                .set("Annots", Object::Array(array));
        }
        _ => {
            doc.get_object_mut(page_id)
                .and_then(Object::as_dict_mut)
                .map_err(|error| format!("写入页面标注失败：{error}"))?
                .set("Annots", Object::Array(vec![Object::Reference(annot_id)]));
        }
    }
    Ok(())
}

fn write_pdf(doc: &mut Document, output: &Path) -> Result<(), String> {
    let directory = output.parent().ok_or_else(|| "导出路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建导出目录失败：{error}"))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let temp = output.with_extension(format!("pdf.tmp-{}-{stamp}", process::id()));
    let file = doc
        .save(&temp)
        .map_err(|error| format!("写入导出 PDF 失败：{error}"))?;
    drop(file);

    if let Err(error) = fs::rename(&temp, output) {
        let _ = fs::remove_file(output);
        fs::rename(&temp, output).map_err(|_| format!("保存导出 PDF 失败：{error}"))?;
    }
    Ok(())
}

impl Annotation {
    fn anchor_quote(&self) -> &str {
        self.anchor
            .get("quote")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Annotation;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glossnote-export-{label}-{}", process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn annotation(kind: &str, body: &str) -> Annotation {
        Annotation {
            id: format!("a-{kind}"),
            page: 0,
            anchor: serde_json::json!({
                "quote": "Anchoring is the heart of annotation.",
                "start": 0,
                "end": 10,
                "rects": [
                    { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.02 },
                    { "x": 0.1, "y": 0.24, "w": 0.2, "h": 0.02 }
                ]
            }),
            color: "yellow".to_string(),
            kind: kind.to_string(),
            body: body.to_string(),
            tags: vec!["test".to_string()],
            created_at: 0,
            updated_at: 0,
            deleted: false,
        }
    }

    #[test]
    fn exports_marks_and_notes_without_touching_source() {
        let dir = temp_dir("marks");
        let input = dir.join("input.pdf");
        let output = dir.join("output.pdf");
        let sample = include_bytes!("../../public/sample.pdf");
        fs::write(&input, sample).unwrap();

        let written = append_annotations(
            &input,
            &output,
            &[
                annotation("highlight", "这是一条批注"),
                annotation("underline", ""),
                annotation("strikethrough", ""),
            ],
        )
        .unwrap();
        assert_eq!(written, 3);
        assert_eq!(
            fs::read(&input).unwrap(),
            sample.to_vec(),
            "原文件不应被改动"
        );

        let doc = Document::load(&output).unwrap();
        let pages = doc.get_pages();
        assert_eq!(pages.len(), 2);
        let annots = doc.get_page_annotations(*pages.get(&1).unwrap()).unwrap();
        let subtypes: Vec<String> = annots
            .iter()
            .map(|dict| {
                String::from_utf8_lossy(dict.get(b"Subtype").unwrap().as_name().unwrap())
                    .into_owned()
            })
            .collect();
        assert_eq!(
            subtypes
                .iter()
                .filter(|value| *value == "Highlight")
                .count(),
            1
        );
        assert_eq!(
            subtypes
                .iter()
                .filter(|value| *value == "Underline")
                .count(),
            1
        );
        assert_eq!(
            subtypes
                .iter()
                .filter(|value| *value == "StrikeOut")
                .count(),
            1
        );
        // 只有第一条有正文，因此多一个便签。
        assert_eq!(subtypes.iter().filter(|value| *value == "Text").count(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_overwrite_source() {
        let dir = temp_dir("same-path");
        let path = dir.join("same.pdf");
        fs::write(&path, include_bytes!("../../public/sample.pdf")).unwrap();
        assert!(append_annotations(&path, &path, &[]).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
