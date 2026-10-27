export interface PickedPdf {
  path: string;
  name: string;
  size: number;
  sha256: string;
  /** asset protocol 地址，交给 pdf.js 直接按 URL 加载 */
  url: string;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 桌面端：原生对话框选文件 → Rust 计算哈希 → 返回 asset URL。
 * 文件字节不经过 IPC；pdf.js 直接从 asset protocol 取。
 */
export async function pickPdf(): Promise<PickedPdf | null> {
  if (!isTauri()) return null;

  const [{ open }, { invoke, convertFileSrc }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/core'),
  ]);

  const selected = await open({
    multiple: false,
    directory: false,
    title: '打开 PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (typeof selected !== 'string') return null;

  const meta = await invoke<{ path: string; name: string; size: number; sha256: string }>(
    'read_pdf_meta',
    { path: selected },
  );

  return { ...meta, url: convertFileSrc(meta.path) };
}
