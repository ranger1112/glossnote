import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib, type PdfTextItem } from './pdfjs';
import { buildAnchor, resolveAnchor, type Anchor, type NormRect } from './anchoring';
import type { Annotation } from './types';

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  annotations: Annotation[];
  focusId: string | null;
  onSelect: (anchor: Anchor, box: { x: number; y: number }) => void;
}

interface ItemInfo {
  start: number;
  end: number;
  node: Text;
}

interface PageModel {
  text: string;
  items: ItemInfo[];
  byItem: Map<number, ItemInfo>;
}

interface Point {
  node: Text;
  offset: number;
}

/** 同一个文本行内，两个 item 之间是否有视觉上的空格。 */
function needsSpace(previous: PdfTextItem, next: PdfTextItem): boolean {
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
 * 文本层里的 span 与 textContent.items 一一对应。按顺序拼出页面纯文本，
 * 同时保留「每个 item 的文本节点 + 它在纯文本中的起点」，后续选区与重放都靠它。
 */
function buildModel(items: PdfTextItem[], divs: HTMLElement[]): PageModel {
  let text = '';
  const infoList: ItemInfo[] = [];
  const byItem = new Map<number, ItemInfo>();
  let previous: PdfTextItem | null = null;

  items.forEach((item, index) => {
    if (item.str.length > 0) {
      const start = text.length;
      text += item.str;

      const div = divs[index];
      const node = div?.firstChild;
      if (div && node instanceof Text) {
        div.dataset.itemIndex = String(index);
        const info = { start, end: text.length, node };
        infoList.push(info);
        byItem.set(index, info);
      }

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

  return { text, items: infoList, byItem };
}

function pointAt(model: PageModel, offset: number): Point | null {
  if (model.items.length === 0) return null;

  let low = 0;
  let high = model.items.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (model.items[middle].start <= offset) low = middle;
    else high = middle - 1;
  }

  const info = model.items[low];
  return {
    node: info.node,
    offset: Math.max(0, Math.min(info.node.length, offset - info.start)),
  };
}

function rectsForRange(
  model: PageModel,
  start: number,
  end: number,
  pageElement: HTMLElement,
): NormRect[] {
  const startPoint = pointAt(model, start);
  const endPoint = pointAt(model, end);
  if (!startPoint || !endPoint) return [];

  const range = document.createRange();
  try {
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
  } catch {
    return [];
  }

  const pageRect = pageElement.getBoundingClientRect();
  if (pageRect.width === 0 || pageRect.height === 0) return [];

  return Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .map((rect) => ({
      x: (rect.left - pageRect.left) / pageRect.width,
      y: (rect.top - pageRect.top) / pageRect.height,
      w: rect.width / pageRect.width,
      h: rect.height / pageRect.height,
    }));
}

function offsetFromDom(node: Node, offset: number, model: PageModel): number | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const span = element?.closest<HTMLElement>('[data-item-index]');
  if (!span) return null;

  const index = Number(span.dataset.itemIndex);
  const info = model.byItem.get(index);
  if (!info) return null;

  return info.start + Math.max(0, Math.min(offset, info.node.length));
}

export function PdfPage({
  pdf,
  pageIndex,
  scale,
  annotations,
  focusId,
  onSelect,
}: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<PageModel | null>(null);

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const paintHighlights = useCallback(() => {
    const pageElement = pageRef.current;
    const layer = highlightRef.current;
    const model = modelRef.current;
    if (!pageElement || !layer || !model) return;

    layer.replaceChildren();
    const pageRect = pageElement.getBoundingClientRect();
    if (pageRect.width === 0 || pageRect.height === 0) return;

    for (const annotation of annotationsRef.current) {
      const resolved = resolveAnchor(annotation.anchor, model.text);
      if (!resolved) continue;

      const computed = rectsForRange(model, resolved.start, resolved.end, pageElement);
      const rects = computed.length > 0 ? computed : annotation.anchor.rects;

      for (const rect of rects) {
        const element = document.createElement('div');
        element.className = [
          'highlight',
          `highlight-${annotation.color}`,
          annotation.id === focusRef.current ? 'focused' : '',
          resolved.kind === 'estimated' ? 'uncertain' : '',
        ]
          .filter(Boolean)
          .join(' ');
        element.style.left = `${rect.x * pageRect.width}px`;
        element.style.top = `${rect.y * pageRect.height}px`;
        element.style.width = `${rect.w * pageRect.width}px`;
        element.style.height = `${rect.h * pageRect.height}px`;
        layer.append(element);
      }
    }
  }, []);

  useEffect(() => {
    const pageElement = pageRef.current;
    const canvas = canvasRef.current;
    const textElement = textRef.current;
    if (!pageElement || !canvas || !textElement) return;

    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    let textLayer: { cancel: () => void } | null = null;

    setReady(false);
    setError('');

    const run = async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1);
        if (cancelled) return;

        const viewport = page.getViewport({ scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);

        pageElement.style.width = `${viewport.width}px`;
        pageElement.style.height = `${viewport.height}px`;

        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const task = page.render({
          canvas,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        renderTask = task;
        await task.promise;
        if (cancelled) return;

        textElement.replaceChildren();
        textElement.style.setProperty('--total-scale-factor', String(scale));
        textElement.style.setProperty('--scale-round-x', '1px');
        textElement.style.setProperty('--scale-round-y', '1px');

        const textContent = await page.getTextContent();
        if (cancelled) return;

        const layer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textElement,
          viewport,
        });
        textLayer = layer;
        await layer.render();
        if (cancelled) return;

        const items = (textContent.items as unknown[]).filter(
          (item): item is PdfTextItem => typeof (item as PdfTextItem).str === 'string',
        );
        modelRef.current = buildModel(items, layer.textDivs);
        setReady(true);
        paintHighlights();
      } catch (cause) {
        if (!cancelled) {
          console.error('渲染页面失败', cause);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, pageIndex, scale, paintHighlights]);

  useEffect(() => {
    if (ready) paintHighlights();
  }, [ready, annotations, focusId, paintHighlights]);

  const handleMouseUp = useCallback(() => {
    // 等浏览器完成本次选区的收尾，再读取 range。
    window.setTimeout(() => {
      const selection = window.getSelection();
      const pageElement = pageRef.current;
      const model = modelRef.current;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      if (!pageElement || !model) return;

      const range = selection.getRangeAt(0);
      if (!pageElement.contains(range.commonAncestorContainer)) return;

      const startParent =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as Element);
      const endParent =
        range.endContainer.nodeType === Node.TEXT_NODE
          ? range.endContainer.parentElement
          : (range.endContainer as Element);
      if (startParent?.closest('.pdf-page') !== pageElement) return;
      if (endParent?.closest('.pdf-page') !== pageElement) return;

      const start = offsetFromDom(range.startContainer, range.startOffset, model);
      const end = offsetFromDom(range.endContainer, range.endOffset, model);
      if (start === null || end === null || end <= start) return;

      const pageRect = pageElement.getBoundingClientRect();
      if (pageRect.width === 0 || pageRect.height === 0) return;

      const rects = Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
        .map((rect) => ({
          x: (rect.left - pageRect.left) / pageRect.width,
          y: (rect.top - pageRect.top) / pageRect.height,
          w: rect.width / pageRect.width,
          h: rect.height / pageRect.height,
        }));
      if (rects.length === 0) return;

      const anchor = buildAnchor(pageIndex, model.text, start, end, rects);
      if (!anchor) return;

      const box = range.getBoundingClientRect();
      onSelect(anchor, { x: box.left + box.width / 2, y: box.top });
    }, 0);
  }, [pageIndex, onSelect]);

  return (
    <div
      className="pdf-page"
      data-page-index={pageIndex}
      ref={pageRef}
      onMouseUp={handleMouseUp}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div ref={highlightRef} className="highlight-layer" />
      <div ref={textRef} className="text-layer" />
      <span className="page-number">{pageIndex + 1}</span>
      {error && <span className="page-error">{error}</span>}
    </div>
  );
}
