import { extractHtmlArticle, sanitizeHtml } from './flow';
import { resolveRelativePath } from './paths';

/** 与 Rust 侧的图片上限保持一致；前后端都拦一道，避免坏页面把 IPC 撑爆。 */
const MAX_IMAGES = 100;
/** 本地冻存不走 Rust，同样限制单张与总量，避免快照过大。 */
const MAX_LOCAL_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_LOCAL_HTML_BYTES = 20 * 1024 * 1024;
/** 与 Rust 侧 MAX_SNAPSHOT_BYTES 保持一致；提前拦截，避免下载完图片才被后端拒绝。 */
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;

export type AssetFetcher = (urls: string[]) => Promise<Map<string, string>>;

export interface WebSnapshot {
  html: string;
  title?: string;
  author?: string;
  /** 成功内联的图片数（含原本就是 data: 的图片）。 */
  images: number;
  /** 下载失败、超限或被跳过的图片数。 */
  failed: number;
}

export interface SnapshotOptions {
  /** 在 Readability 之前处理文档；本地 HTML 用它把相对图片换成 asset 地址。 */
  prepare?: (document: Document) => void;
  /** 自定义图片地址解析；返回 null 表示丢弃这张图。 */
  resolveImage?: (src: string) => string | null;
}

/**
 * 把 Readability 提取出的正文做成单文件快照：
 * 图片先按最终 URL 解析、去重、下载成 data URL，再做统一清理。
 */
export async function buildWebSnapshot(
  source: string,
  finalUrl: string,
  fetchAssets: AssetFetcher,
  options: SnapshotOptions = {},
): Promise<WebSnapshot> {
  const article = await extractHtmlArticle(source, finalUrl || undefined, options.prepare);
  const container = document.createElement('div');
  container.innerHTML = article.html;

  const plan: Array<{ image: HTMLImageElement; url?: string; inline: boolean }> = [];
  const urls = new Set<string>();

  for (const image of Array.from(container.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const raw = image.getAttribute('src')?.trim();
    if (!raw) continue;

    if (/^data:/i.test(raw)) {
      plan.push({ image, inline: true });
      continue;
    }

    if (options.resolveImage) {
      const key = options.resolveImage(raw);
      plan.push({ image, url: key ?? undefined, inline: false });
      if (key) urls.add(key);
      continue;
    }

    let absolute: string;
    try {
      absolute = new URL(raw, finalUrl).href;
    } catch {
      plan.push({ image, inline: false });
      continue;
    }
    if (!/^https?:/i.test(absolute)) {
      plan.push({ image, inline: false });
      continue;
    }

    urls.add(absolute);
    plan.push({ image, url: absolute, inline: false });
  }

  const requested = Array.from(urls).slice(0, MAX_IMAGES);
  const assets = requested.length > 0 ? await fetchAssets(requested) : new Map<string, string>();

  let images = 0;
  let failed = 0;
  for (const entry of plan) {
    if (entry.inline) {
      images += 1;
      continue;
    }

    const dataUrl = entry.url ? assets.get(entry.url) : undefined;
    if (dataUrl) {
      entry.image.setAttribute('src', dataUrl);
      images += 1;
    } else {
      // 超过数量上限、下载失败或被拒绝的图片直接移除，快照里不留远程地址。
      entry.image.removeAttribute('src');
      failed += 1;
    }
  }

  const html = sanitizeHtml(container.innerHTML);
  if (new TextEncoder().encode(html).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('网页内容超过 24 MB，无法保存为快照');
  }

  return {
    html,
    title: article.title,
    author: article.author,
    images,
    failed,
  };
}

export interface LocalSnapshotOptions {
  /** 把本地文件路径转成 WebView 可读取的 asset 地址。 */
  toAssetUrl: (path: string) => string;
  /** 测试注入；默认用全局 fetch。 */
  fetchAsset?: (url: string) => Promise<Blob | null>;
}

function imageMimeFromUrl(url: string): string | null {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // asset: 或已经编码的路径按字符串取扩展名。
  }
  const extension = path.split('#')[0].split('?')[0].split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'ico':
      return 'image/x-icon';
    default:
      return null;
  }
}

function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  const typed = blob.type === mime ? blob : new Blob([blob], { type: mime });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(typed);
  });
}

async function fetchLocalAssets(
  urls: string[],
  fetchAsset: (url: string) => Promise<Blob | null>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let total = 0;

  for (const url of urls) {
    let blob: Blob | null = null;
    try {
      blob = await fetchAsset(url);
    } catch {
      // 单张图片失败不阻断整篇导入。
    }
    if (!blob) continue;

    const declared = blob.type.split(';')[0].trim().toLowerCase();
    const mime = declared
      ? declared.startsWith('image/')
        ? declared
        : declared === 'application/octet-stream'
          ? imageMimeFromUrl(url)
          : null
      : imageMimeFromUrl(url);
    // SVG 可能引用外部资源；快照只收常见位图。
    if (!mime || mime === 'image/svg+xml') continue;
    if (blob.size <= 0 || blob.size > MAX_LOCAL_IMAGE_BYTES) continue;
    if (total + blob.size > MAX_LOCAL_TOTAL_BYTES) continue;

    try {
      result.set(url, await blobToDataUrl(blob, mime));
      total += blob.size;
    } catch {
      // FileReader 失败时只丢这一张。
    }
  }
  return result;
}

/** 读取本地 HTML：先按 UTF-8 严格解码，失败再回退 GB18030。 */
export async function readLocalHtml(
  htmlPath: string,
  toAssetUrl: (path: string) => string,
): Promise<string> {
  const response = await fetch(toAssetUrl(htmlPath));
  if (!response.ok) throw new Error(`读取 HTML 失败：HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_LOCAL_HTML_BYTES) {
    throw new Error('HTML 超过 20 MB，请先拆分后再导入');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_LOCAL_HTML_BYTES) {
    throw new Error('HTML 超过 20 MB，请先拆分后再导入');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

/**
 * 本地 HTML 的单文件快照：相对图片按源文件目录解析成 asset 地址，
 * 读取后内联成 data URL；远程图片不抓取，避免导入时联网。
 */
export async function buildLocalHtmlSnapshot(
  source: string,
  htmlPath: string,
  options: LocalSnapshotOptions,
): Promise<WebSnapshot> {
  const assetUrls = new Set<string>();
  const toAsset = (src: string): string => {
    const url = options.toAssetUrl(resolveRelativePath(htmlPath, src));
    assetUrls.add(url);
    try {
      // Readability 可能把 URL 重新序列化；两种写法都记下来。
      assetUrls.add(new URL(url).href);
    } catch {
      // asset: 等非标准 URL 保持原样。
    }
    return url;
  };

  const resolveImage = (src: string): string | null => {
    if (assetUrls.has(src)) return src;
    try {
      if (assetUrls.has(new URL(src).href)) return src;
    } catch {
      // 相对地址继续走下面的解析。
    }
    // 绝对地址（http、file、data 等）或协议相对地址一律不抓；data 已在前面保留。
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return null;
    return toAsset(src);
  };

  const fetchAsset =
    options.fetchAsset ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) return null;
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_LOCAL_IMAGE_BYTES) return null;
      return response.blob();
    });

  return buildWebSnapshot(
    source,
    '',
    (urls) => fetchLocalAssets(urls, fetchAsset),
    {
      prepare: (document) => {
        for (const image of Array.from(document.querySelectorAll('img[src]'))) {
          const raw = image.getAttribute('src')?.trim();
          if (!raw || /^data:/i.test(raw)) continue;
          const resolved = resolveImage(raw);
          if (resolved) image.setAttribute('src', resolved);
        }
      },
      resolveImage,
    },
  );
}
