export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 桌面端：原生对话框选文件，返回绝对路径；导入由 Rust 完成。 */
export async function pickDocumentPath(): Promise<string | null> {
  if (!isTauri()) return null;

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    directory: false,
    title: '打开文档',
    // HTML / EPUB 阅读器落地后再把扩展名加进来。
    filters: [{ name: '文档', extensions: ['pdf', 'txt'] }],
  });

  return typeof selected === 'string' ? selected : null;
}

/** 桌面端：选择目录，用于切换书库位置。 */
export async function pickDirectory(title = '选择书库目录'): Promise<string | null> {
  if (!isTauri()) return null;

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    directory: true,
    multiple: false,
    title,
  });

  return typeof selected === 'string' ? selected : null;
}

/** 桌面端：选择带标注 PDF 的导出位置。 */
export async function pickPdfSavePath(
  defaultName = 'glossnote-annotated.pdf',
): Promise<string | null> {
  if (!isTauri()) return null;

  const { save } = await import('@tauri-apps/plugin-dialog');
  const selected = await save({
    title: '导出带标注的 PDF',
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  if (typeof selected !== 'string') return null;
  return /\.pdf$/i.test(selected) ? selected : `${selected}.pdf`;
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
