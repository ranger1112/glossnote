import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildAnchor, type Anchor, type NormRect } from './anchoring';
import { joinPdfItems, type TextItemLike } from './pdfText';
import type { Annotation, AnnotationKind, HighlightColor } from './types';

/** PDF 用户空间里的轴对齐矩形，坐标原点在左下角。 */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** pdf.js `getAnnotations()` 里与本功能有关的字段。 */
interface PdfAnnotationLike {
  subtype?: string;
  rect?: number[];
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  contents?: string;
  contentsObj?: { str?: string };
  hidden?: boolean;
  noView?: boolean;
}

interface ViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

export interface NativeMark {
  kind: AnnotationKind;
  color: HighlightColor;
  contents: string;
  /** 用于文字命中检测的 PDF 坐标矩形 */
  pdfBoxes: Box[];
  /** 用于锚点兜底的归一化矩形 */
  rects: NormRect[];
}

export interface NativePage {
  page: number;
  marks: NativeMark[];
}

export interface NativeScan {
  pages: NativePage[];
  total: number;
  annotatedPages: number;
  byKind: Record<'highlight' | 'underline' | 'strikethrough', number>;
}

export interface ImportedDraft {
  page: number;
  anchor: Anchor;
  color: HighlightColor;
  kind: AnnotationKind;
  body: string;
  tags: string[];
}

const KIND_BY_SUBTYPE: Record<string, AnnotationKind> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikethrough',
};

/** GlossNote 的四种高亮色，用来把 PDF 里任意 RGB 映射到最近的一档。 */
const GLOSS_COLORS: { key: HighlightColor; rgb: [number, number, number] }[] = [
  { key: 'yellow', rgb: [255, 224, 102] },
  { key: 'green', rgb: [167, 243, 201] },
  { key: 'blue', rgb: [184, 212, 255] },
  { key: 'pink', rgb: [255, 196, 225] },
];

export function kindFromSubtype(subtype: string | undefined): AnnotationKind | null {
  return subtype ? (KIND_BY_SUBTYPE[subtype] ?? null) : null;
}

export function colorFromRgb(rgb: ArrayLike<number> | null | undefined): HighlightColor {
  if (!rgb || rgb.length < 3) return 'yellow';
  const [r, g, b] = [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
  if (![r, g, b].every(Number.isFinite)) return 'yellow';

  let best: HighlightColor = 'yellow';
  let bestDistance = Infinity;
  for (const color of GLOSS_COLORS) {
    const distance =
      (r - color.rgb[0]) ** 2 + (g - color.rgb[1]) ** 2 + (b - color.rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color.key;
    }
  }
  return best;
}

/** QuadPoints 每 8 个数是一行；缺失时退回注解外框。 */
export function boxesFromQuadPoints(
  quadPoints: ArrayLike<number> | null | undefined,
  rect: number[] | undefined,
): Box[] {
  const boxes: Box[] = [];
  if (quadPoints && quadPoints.length >= 8) {
    for (let i = 0; i + 8 <= quadPoints.length; i += 8) {
      const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]];
      const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]];
      const box = {
        x1: Math.min(...xs),
        y1: Math.min(...ys),
        x2: Math.max(...xs),
        y2: Math.max(...ys),
      };
      if (box.x2 > box.x1 && box.y2 > box.y1) boxes.push(box);
    }
  }

  if (boxes.length === 0 && rect && rect.length >= 4) {
    const box = {
      x1: Math.min(rect[0], rect[2]),
      y1: Math.min(rect[1], rect[3]),
      x2: Math.max(rect[0], rect[2]),
      y2: Math.max(rect[1], rect[3]),
    };
    if (box.x2 > box.x1 && box.y2 > box.y1) boxes.push(box);
  }

  return boxes;
}

/** 把 PDF 坐标矩形换成相对页面宽高的归一化矩形，供锚点兜底使用。 */
export function normalizedRectsFromBoxes(boxes: Box[], viewport: ViewportLike): NormRect[] {
  if (viewport.width <= 0 || viewport.height <= 0) return [];

  const rects: NormRect[] = [];
  for (const box of boxes) {
    const points = [
      viewport.convertToViewportPoint(box.x1, box.y1),
      viewport.convertToViewportPoint(box.x2, box.y1),
      viewport.convertToViewportPoint(box.x1, box.y2),
      viewport.convertToViewportPoint(box.x2, box.y2),
    ];
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const x = Math.max(0, Math.min(...xs) / viewport.width);
    const y = Math.max(0, Math.min(...ys) / viewport.height);
    const w = Math.min(1, Math.max(...xs) / viewport.width) - x;
    const h = Math.min(1, Math.max(...ys) / viewport.height) - y;
    if (w <= 0 || h <= 0) continue;
    rects.push({
      x: Math.round(x * 100000) / 100000,
      y: Math.round(y * 100000) / 100000,
      w: Math.round(w * 100000) / 100000,
      h: Math.round(h * 100000) / 100000,
    });
  }
  return rects;
}

/** 文本项的 PDF 坐标框。书页是水平排版，直接用基线、宽度与字高。 */
export function itemBox(item: TextItemLike): Box | null {
  if (item.transform.length < 6 || item.width <= 0 || item.height <= 0) return null;
  const x = item.transform[4];
  const baseline = item.transform[5];
  return {
    x1: x,
    // 夸大到基线下一点，覆盖下缘；四边形的下边通常略低于基线。
    y1: baseline - item.height * 0.15,
    x2: x + item.width,
    y2: baseline + item.height,
  };
}

function intersects(box: Box, other: Box): boolean {
  const width = Math.min(box.x2, other.x2) - Math.max(box.x1, other.x1);
  if (width <= 0) return false;
  const height = Math.min(box.y2, other.y2) - Math.max(box.y1, other.y1);
  if (height <= 0) return false;
  const minHeight = Math.min(box.y2 - box.y1, other.y2 - other.y1);
  return height >= minHeight * 0.3;
}

function trimRange(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}

/**
 * 找出被原生标注覆盖的文本项，返回页面纯文本里的字符区间。
 * 文本项按行切分，所以一个四边形通常会命中整行；区间再按空白裁边。
 */
export function textRangeForBoxes(
  items: TextItemLike[],
  starts: number[],
  boxes: Box[],
  text: string,
): { start: number; end: number } | null {
  if (boxes.length === 0) return null;

  let start = Infinity;
  let end = -Infinity;
  items.forEach((item, index) => {
    if (!item.str || item.str.length === 0) return;
    const box = itemBox(item);
    if (!box) return;
    if (!boxes.some((quad) => intersects(box, quad))) return;

    const itemStart = starts[index];
    const itemEnd = itemStart + item.str.length;
    if (itemStart < start) start = itemStart;
    if (itemEnd > end) end = itemEnd;
  });

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return trimRange(text, start, end);
}

export function annotationKey(page: number, quote: string): string {
  return `${page}|${quote.replace(/\s+/g, '')}`;
}

function markFromAnnotation(
  annotation: PdfAnnotationLike,
  viewport: ViewportLike,
): NativeMark | null {
  if (annotation.hidden || annotation.noView) return null;
  const kind = kindFromSubtype(annotation.subtype);
  if (!kind) return null;

  const pdfBoxes = boxesFromQuadPoints(annotation.quadPoints, annotation.rect);
  if (pdfBoxes.length === 0) return null;
  const rects = normalizedRectsFromBoxes(pdfBoxes, viewport);
  if (rects.length === 0) return null;

  const contents = (annotation.contentsObj?.str ?? annotation.contents ?? '').trim();
  return {
    kind,
    color: colorFromRgb(annotation.color),
    contents,
    pdfBoxes,
    rects,
  };
}

/** 扫描整份 PDF，只取高亮、下划线与删除线；不读取文字内容。 */
export async function scanNativeAnnotations(
  pdf: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<NativeScan> {
  const pages: NativePage[] = [];
  const byKind: NativeScan['byKind'] = { highlight: 0, underline: 0, strikethrough: 0 };
  let total = 0;

  for (let index = 0; index < pdf.numPages; index += 1) {
    const page = await pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const raw = (await page.getAnnotations()) as PdfAnnotationLike[];
    const marks: NativeMark[] = [];

    for (const annotation of raw) {
      const mark = markFromAnnotation(annotation, viewport);
      if (!mark) continue;
      marks.push(mark);
      total += 1;
      byKind[mark.kind as keyof NativeScan['byKind']] += 1;
    }

    if (marks.length > 0) pages.push({ page: index, marks });
    if (index === 0 || index === pdf.numPages - 1 || (index + 1) % 25 === 0) {
      onProgress?.(index + 1, pdf.numPages);
    }
  }

  return { pages, total, annotatedPages: pages.length, byKind };
}

/**
 * 把扫描结果落到文本锚点上。只读取含原生标注的页；已有相同文字标注的页会跳过，
 * 所以重复导入或导入后再点一次不会产生副本。
 */
export async function buildImportedAnnotations(
  pdf: PDFDocumentProxy,
  pages: NativePage[],
  existingKeys: Set<string>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ drafts: ImportedDraft[]; skipped: number }> {
  const drafts: ImportedDraft[] = [];
  let skipped = 0;

  for (let index = 0; index < pages.length; index += 1) {
    const { page, marks } = pages[index];
    const proxy = await pdf.getPage(page + 1);
    const content = await proxy.getTextContent();
    const items = (content.items as unknown[]).filter(
      (item): item is TextItemLike =>
        typeof (item as TextItemLike).str === 'string' &&
        Array.isArray((item as TextItemLike).transform),
    );
    const { text, starts } = joinPdfItems(items);

    if (!text) {
      skipped += marks.length;
    } else {
      for (const mark of marks) {
        const range = textRangeForBoxes(items, starts, mark.pdfBoxes, text);
        if (!range) {
          skipped += 1;
          continue;
        }
        const anchor = buildAnchor(page, text, range.start, range.end, mark.rects);
        if (!anchor) {
          skipped += 1;
          continue;
        }
        const key = annotationKey(page, anchor.quote);
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }
        existingKeys.add(key);
        drafts.push({
          page,
          anchor,
          color: mark.color,
          kind: mark.kind,
          body: mark.contents,
          tags: [],
        });
      }
    }

    onProgress?.(index + 1, pages.length);
  }

  return { drafts, skipped };
}

/** 把导入草稿补成完整标注；时间戳保持同一批次的顺序。 */
export function draftsToAnnotations(
  drafts: ImportedDraft[],
  now = Date.now(),
): Annotation[] {
  return drafts.map((draft, index) => ({
    id: crypto.randomUUID(),
    page: draft.page,
    anchor: draft.anchor,
    color: draft.color,
    kind: draft.kind,
    body: draft.body,
    tags: draft.tags,
    createdAt: now + index,
    updatedAt: now + index,
  }));
}
