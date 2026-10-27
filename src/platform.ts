export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 桌面端：原生对话框选文件，返回绝对路径；导入由 Rust 完成。 */
export async function pickPdfPath(): Promise<string | null> {
  if (!isTauri()) return null;

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    title: '打开 PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  return typeof selected === 'string' ? selected : null;
}

/** 桌面端：选择 Markdown 导出位置。 */
export async function pickMarkdownPath(): Promise<string | null> {
  if (!isTauri()) return null;

  const { save } = await import('@tauri-apps/plugin-dialog');
  const selected = await save({
    title: '导出 Markdown',
    defaultPath: 'glossnote-export.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });

  return typeof selected === 'string' ? selected : null;
}
