#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::PathBuf,
};

/// 前端只需要文档身份与显示信息；PDF 字节由 asset protocol 交给 pdf.js，
/// 不经过 IPC，避免几十 MB 的数据被序列化成数字数组。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfMeta {
    path: String,
    name: String,
    size: u64,
    sha256: String,
}

#[tauri::command]
fn read_pdf_meta(path: String) -> Result<PdfMeta, String> {
    let path = PathBuf::from(path);
    let metadata = std::fs::metadata(&path).map_err(|error| format!("读取文件信息失败：{error}"))?;

    if !metadata.is_file() {
        return Err("所选路径不是文件".to_string());
    }
    if metadata.len() > 200 * 1024 * 1024 {
        return Err("文件超过 200 MB，请先压缩或拆分后再导入".to_string());
    }

    let mut file = File::open(&path).map_err(|error| format!("打开 PDF 失败：{error}"))?;
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

    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf")
        .to_string();

    Ok(PdfMeta {
        path: path.to_string_lossy().into_owned(),
        name,
        size: metadata.len(),
        sha256,
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_pdf_meta])
        .run(tauri::generate_context!())
        .expect("GlossNote 启动失败");
}
