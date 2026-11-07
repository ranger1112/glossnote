import type JSZip from 'jszip';
import { buildFlowFromHtml, type FlowDocument, type FlowUnit } from './flow';
import type { OutlineEntry } from './outline';

interface ManifestItem {
  href: string;
  mediaType: string;
}

const DC_NS = 'http://purl.org/dc/elements/1.1/';
/** 单张图片与整本书的内联预算：EPUB 图片转成 data URL 后会占内存。 */
const MAX_SINGLE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
/** 解压后文本预算：防止 zip bomb 把内存打满。 */
const MAX_CHAPTER_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_CONTAINER_BYTES = 1024 * 1024;
const MAX_OPF_BYTES = 4 * 1024 * 1024;

function parseXml(text: string, type: DOMParserSupportedType): Document {
  return new DOMParser().parseFromString(text, type);
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index + 1) : '';
}

/** 把 EPUB 内部的相对 href 解析成 zip 里的完整路径。 */
function resolvePath(baseDir: string, href: string): string {
  // EPUB 的 href 偶尔也带查询串；先按原始 URL 去掉，再解码文件名。
  const clean = href.split('#')[0].split('?')[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // 保留原样：少数 EPUB 的 href 不是合法 URL 编码。
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return decoded;

  const stack: string[] = [];
  for (const part of (baseDir + decoded).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function metadataText(opf: Document, name: string): string {
  const direct = opf.getElementsByTagName(`dc:${name}`)[0]?.textContent;
  const namespaced = opf.getElementsByTagNameNS(DC_NS, name)[0]?.textContent;
  return (direct ?? namespaced ?? '').trim();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
}

/** JSZip 在中央目录里记录了未压缩大小；类型定义没公开，只能读私有字段。 */
function declaredBytes(file: JSZip.JSZipObject): number | null {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null;
}

/** 解压前先按中央目录大小拦一道，解压后再兜底；避免 zip bomb 撑爆内存。 */
async function readZipText(
  file: JSZip.JSZipObject,
  maxBytes: number,
  label: string,
): Promise<string> {
  const declared = declaredBytes(file);
  if (declared !== null && declared > maxBytes) {
    throw new Error(`${label}解压后过大`);
  }
  const text = await file.async('string');
  if (text.length > maxBytes) throw new Error(`${label}解压后过大`);
  return text;
}

/**
 * EPUB 的图片在 zip 内部，直接渲染会 404；转成 data URL 内联。
 * 超出单张或整本预算的图片去掉 src，保留 alt 文本。
 */
async function inlineImages(
  root: Element,
  zip: JSZip,
  chapterDir: string,
  mediaByPath: Map<string, string>,
  budget: { bytes: number },
): Promise<void> {
  for (const image of Array.from(root.querySelectorAll('img[src]'))) {
    const src = image.getAttribute('src');
    if (!src || /^(https?:|data:)/i.test(src)) continue;

    const path = resolvePath(chapterDir, src);
    const file = zip.file(path);
    if (!file) {
      image.removeAttribute('src');
      continue;
    }

    const limit = Math.min(MAX_SINGLE_IMAGE_BYTES, budget.bytes);
    const declared = declaredBytes(file);
    if (declared !== null && declared > limit) {
      image.removeAttribute('src');
      continue;
    }

    try {
      const bytes = await file.async('uint8array');
      if (bytes.byteLength > limit) {
        image.removeAttribute('src');
        continue;
      }
      budget.bytes -= bytes.byteLength;

      const mediaType = mediaByPath.get(path) ?? 'image/jpeg';
      image.setAttribute('src', `data:${mediaType};base64,${bytesToBase64(bytes)}`);
    } catch (error) {
      // 单张图片损坏不应该让整本书打不开。
      console.warn('跳过无法读取的 EPUB 图片', src, error);
      image.removeAttribute('src');
    }
  }
}

/**
 * 解析 EPUB：container.xml → OPF → spine 顺序读取章节。
 * 每个 spine 项按 HTML 分页模型拆成若干 unit，标题继续生成目录。
 */
export async function buildEpubDocument(
  data: ArrayBuffer | Uint8Array,
): Promise<FlowDocument> {
  // 按需加载解压库，PDF / TXT 用户不必为 EPUB 付首屏体积。
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(data);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const container = parseXml(
    await readZipText(containerFile, MAX_CONTAINER_BYTES, 'container.xml '),
    'application/xml',
  );
  const rootfile = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfile) throw new Error('不是有效的 EPUB：找不到 OPF 文件');

  const opfFile = zip.file(rootfile);
  if (!opfFile) throw new Error('不是有效的 EPUB：OPF 文件缺失');
  const opf = parseXml(await readZipText(opfFile, MAX_OPF_BYTES, 'OPF '), 'application/xml');
  const opfDir = dirOf(rootfile);

  const manifest = new Map<string, ManifestItem>();
  for (const item of Array.from(opf.getElementsByTagName('item'))) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      mediaType: item.getAttribute('media-type') ?? '',
    });
  }

  const mediaByPath = new Map<string, string>();
  for (const item of manifest.values()) {
    mediaByPath.set(resolvePath(opfDir, item.href), item.mediaType);
  }

  const spine = Array.from(opf.getElementsByTagName('itemref'))
    .map((ref) => manifest.get(ref.getAttribute('idref') ?? ''))
    .filter((item): item is ManifestItem => Boolean(item))
    // 少数 EPUB 省略 media-type，按扩展名兜底。
    .filter(
      (item) => /xhtml|html/i.test(item.mediaType) || /\.x?html?$/i.test(item.href),
    );

  if (spine.length === 0) throw new Error('不是有效的 EPUB：目录为空');

  const units: FlowUnit[] = [];
  const outline: OutlineEntry[] = [];
  const budget = { bytes: MAX_INLINE_IMAGE_BYTES };
  let totalText = 0;

  for (const item of spine) {
    const path = resolvePath(opfDir, item.href);
    const file = zip.file(path);
    if (!file) continue;

    let source: string;
    try {
      source = await readZipText(file, MAX_CHAPTER_BYTES, `章节 ${item.href} `);
    } catch (error) {
      // 单章损坏或过大时跳过，避免整本书打不开。
      console.warn('跳过无法读取的 EPUB 章节', item.href, error);
      continue;
    }
    totalText += source.length;
    if (totalText > MAX_TOTAL_TEXT_BYTES) {
      throw new Error('EPUB 解压后文本过大，已停止打开');
    }

    // XHTML 也按 text/html 解析：比 XML 模式更能容忍现实里的不规范文件。
    const document = parseXml(source, 'text/html');
    const body = document.body;
    if (!body) continue;

    await inlineImages(body, zip, dirOf(path), mediaByPath, budget);

    const chapter = buildFlowFromHtml(body.innerHTML, 'epub');
    const offset = units.length;
    units.push(...chapter.units);
    for (const entry of chapter.outline) {
      outline.push({
        ...entry,
        id: `outline-${outline.length}`,
        page: entry.page + offset,
      });
    }
  }

  if (units.length === 0) throw new Error('不是有效的 EPUB：没有可读章节');

  return {
    kind: 'epub',
    units,
    outline,
    title: metadataText(opf, 'title') || undefined,
    author: metadataText(opf, 'creator') || undefined,
  };
}
