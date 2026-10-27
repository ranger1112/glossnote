import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfTextItem } from './pdfjs';

export interface TextItemLike {
  str: string;
  hasEOL: boolean;
  transform: number[];
  width: number;
  height: number;
}

/** 同一文本行内，两个 item 之间是否有视觉上的空格。 */
function needsSpace(previous: TextItemLike, next: TextItemLike): boolean {
  if (previous.str.endsWith(' ') || next.str.startsWith(' ')) return false;

  const previousEnd = previous.transform[4] + previous.width;
  const nextStart = next.transform[4];
  const sameLine =
    Math.abs(previous.transform[5] - next.transform[5]) <
    Math.max(previous.height, next.height) * 0.5;
  if (!sameLine) return false;

  return nextStart - previousEnd > Math.max(1, Math.min(previous.height, next.height) * 0.12);
}

/**
 * 按 pdf.js 的 item 顺序拼出页面纯文本，并返回每个 item 的起始偏移。
 * 阅读器的锚定与 AI 全文索引共用这一份拼接规则。
 */
export function joinPdfItems(items: TextItemLike[]): { text: string; starts: number[] } {
  let text = '';
  const starts: number[] = [];
  let previous: TextItemLike | null = null;

  items.forEach((item) => {
    starts.push(text.length);
    if (item.str.length > 0) {
      text += item.str;
      if (item.hasEOL) {
        text += '\n';
      } else if (previous && needsSpace(previous, item)) {
        text += ' ';
      }
    } else if (item.hasEOL) {
      text += '\n';
    }

    previous = item;
  });

  return { text, starts };
}

export interface PageText {
  page: number;
  text: string;
}

/** 顺序提取整份 PDF 的文字；扫描件会得到空页。 */
export async function extractDocumentText(
  pdf: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<PageText[]> {
  const pages: PageText[] = [];

  for (let index = 0; index < pdf.numPages; index += 1) {
    const page = await pdf.getPage(index + 1);
    const content = await page.getTextContent();
    const items = (content.items as unknown[]).filter(
      (item): item is PdfTextItem => typeof (item as PdfTextItem).str === 'string',
    );
    pages.push({ page: index, text: joinPdfItems(items).text });
    onProgress?.(index + 1, pdf.numPages);
  }

  return pages;
}
