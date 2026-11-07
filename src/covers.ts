import type { DocKind } from './document';

export interface TextCoverSource {
  kind?: DocKind;
  name: string;
  title?: string;
  author?: string;
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
