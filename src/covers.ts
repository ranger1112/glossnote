import type { DocKind } from './document';

/** 原生封面先做尺寸预检，避免超大图片在 WebView 里按原尺寸解码。 */
const MAX_COVER_EDGE = 8192;
const MAX_COVER_PIXELS = 16_000_000;

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function readI32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  );
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return null;
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** 只解析常见封面的尺寸头；无法识别的格式返回 null，交给浏览器解码。 */
export function coverImageSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) };
  }
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return {
      width: Math.abs(readI32LE(bytes, 18)),
      height: Math.abs(readI32LE(bytes, 22)),
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(bytes);
  }
  return null;
}

export interface TextCoverSource {
  kind?: DocKind;
  name: string;
  title?: string;
  author?: string;
}

/** 把 EPUB 原生封面缩放并转成 JPEG，统一书库封面的存储格式。 */
export async function makeImageCover(
  bytes: Uint8Array,
  mime: string,
): Promise<Uint8Array | null> {
  const type = mime.toLowerCase();
  if (!type.startsWith('image/') || type === 'image/svg+xml') return null;

  const size = coverImageSize(bytes);
  if (
    size &&
    (size.width <= 0 ||
      size.height <= 0 ||
      size.width > MAX_COVER_EDGE ||
      size.height > MAX_COVER_EDGE ||
      size.width * size.height > MAX_COVER_PIXELS)
  ) {
    return null;
  }

  // 复制到独立的 ArrayBuffer，避免 SharedArrayBuffer 形态不符合 BlobPart。
  const copy = bytes.slice();
  const url = URL.createObjectURL(new Blob([copy.buffer], { type }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('封面图片无法解码'));
      element.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) return null;

    // 限制最大边，避免超大插图在书库封面里浪费内存。
    const scale = Math.min(480 / image.naturalWidth, 640 / image.naturalHeight, 1);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.86);
    });
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 流式文档没有可渲染的首页，用标题/作者画一张 320×440 的封面。 */
export async function makeTextCover(doc: TextCoverSource): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 440;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const gradient = context.createLinearGradient(0, 0, 320, 440);
  gradient.addColorStop(0, '#263238');
  gradient.addColorStop(1, '#4b5563');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 320, 440);

  context.fillStyle = 'rgba(255,255,255,0.7)';
  context.font = '600 13px sans-serif';
  context.fillText((doc.kind ?? 'pdf').toUpperCase(), 28, 48);

  const title = (doc.title || doc.name.replace(/\.[^.]+$/, '') || '未命名').trim();
  context.fillStyle = '#ffffff';
  context.font = '700 28px sans-serif';
  const maxWidth = 264;
  let line = '';
  let y = 130;
  for (const char of Array.from(title)) {
    const next = line + char;
    if (context.measureText(next).width > maxWidth && line) {
      context.fillText(line, 28, y);
      line = char;
      y += 38;
      if (y > 300) {
        line += '…';
        break;
      }
    } else {
      line = next;
    }
  }
  if (line) context.fillText(line, 28, y);

  if (doc.author) {
    context.fillStyle = 'rgba(255,255,255,0.72)';
    context.font = '15px sans-serif';
    context.fillText(doc.author, 28, 380);
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.85);
  });
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
