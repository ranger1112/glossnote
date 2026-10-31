import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib, type PdfTextItem } from './pdfjs';
import { joinPdfItems } from './pdfText';
import {
  buildAnchor,
  resolveAnchor,
  type Anchor,
  type NormRect,
  type Resolution,
} from './anchoring';
import type { Annotation } from './types';

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  /** 第一页在 scale=1 时的尺寸，用来给尚未渲染的页面占位。 */
  baseSize: { width: number; height: number };
  /** 只渲染当前页附近的页面；整本书一次渲染会占掉数 GB 画布内存。 */
  active: boolean;
  annotations: Annotation[];
  focusId: string | null;
  /** context 是选区前后各一段正文，供 AI 解释使用；不写进锚点。 */
  onSelect: (anchor: Anchor, box: { x: number; y: number }, context: string) => void;
  /** 鼠标停在已标注文字上时上报标注与工具条位置；移开时传 null。 */
  onHover: (
    annotation: Annotation | null,
    box?: { x: number; y: number; below: boolean },
    context?: string,
  ) => void;
  /** 当前正在显示快捷工具的标注 id；滚动收起后同一标注再移动鼠标能重新出现。 */
  hoverId: string | null;
  /** 鼠标仍在标注上时取消 App 侧的延迟收起。 */
  onHoverKeepAlive: () => void;
  /** 页内查找的当前命中；token 变化时滚动到这一行。 */
  searchMatch?: { start: number; end: number; token: number };
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
  /** 同一页文本内的锚点解析缓存：焦点或批注变化会反复重绘，模糊匹配不该重跑。 */
  resolutions: Map<string, Resolution | null>;
}

interface Point {
  node: Text;
  offset: number;
}

/** 下划线/删除线不用高亮底色，改用与标注颜色一致的线条。 */
const MARK_COLORS: Record<Annotation['color'], string> = {
  yellow: '#d9a400',
  green: '#1f9d63',
  blue: '#4b5cc4',
  pink: '#d4578a',
};

/**
 * 文本层里的 span 与 textContent.items 一一对应。按顺序拼出页面纯文本，
 * 同时保留「每个 item 的文本节点 + 它在纯文本中的起点」，后续选区与重放都靠它。
 */
function buildModel(items: PdfTextItem[], divs: HTMLElement[]): PageModel {
  const { text, starts } = joinPdfItems(items);
  const infoList: ItemInfo[] = [];
  const byItem = new Map<number, ItemInfo>();

  items.forEach((item, index) => {
    if (item.str.length === 0) return;

    const div = divs[index];
    const node = div?.firstChild;
    if (!div || !(node instanceof Text)) return;

    div.dataset.itemIndex = String(index);
    const start = starts[index];
    const info = { start, end: start + item.str.length, node };
    infoList.push(info);
    byItem.set(index, info);
  });

  return { text, items: infoList, byItem, resolutions: new Map() };
}

function resolveCached(model: PageModel, anchor: Anchor): Resolution | null {
  const key = `${anchor.pageHash}:${anchor.start}:${anchor.end}:${anchor.quote}`;
  if (model.resolutions.has(key)) return model.resolutions.get(key) ?? null;

  const resolved = resolveAnchor(anchor, model.text);
  model.resolutions.set(key, resolved);
  return resolved;
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

/**
 * pdf.js 的文本项按字形/词切分，相邻矩形常常互相压边。逐块绘制时重叠处会被
 * multiply 两次，看起来像一条条深色接缝。把同一行、横向相接的矩形先合并。
 */
function mergeRects(rects: NormRect[]): NormRect[] {
  if (rects.length < 2) return rects;

  // 归一化坐标下的容差：约 4px（按页面宽度 1000px 估）。pdf.js 的相邻文本项
  // 常有 1–2px 的缝，缝太大会在字间留下未着色的白点。
  const EPS = 0.004;
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: NormRect[][] = [];

  for (const rect of sorted) {
    const line = lines[lines.length - 1];
    if (line) {
      const first = line[0];
      const overlap = Math.min(first.y + first.h, rect.y + rect.h) - Math.max(first.y, rect.y);
      // 高度重合超过一半就算同一行。
      if (overlap > Math.min(first.h, rect.h) * 0.5) {
        line.push(rect);
        continue;
      }
    }
    lines.push([rect]);
  }

  const merged: NormRect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let current = { ...line[0] };
    for (const rect of line.slice(1)) {
      const touches = rect.x <= current.x + current.w + EPS;
      if (touches) {
        const right = Math.max(current.x + current.w, rect.x + rect.w);
        const bottom = Math.max(current.y + current.h, rect.y + rect.h);
        current = {
          x: current.x,
          y: Math.min(current.y, rect.y),
          w: right - current.x,
          h: bottom - Math.min(current.y, rect.y),
        };
      } else {
        merged.push(current);
        current = { ...rect };
      }
    }
    merged.push(current);
  }

  return merged;
}

/** 合并同行相邻矩形，并把坐标收到 5 位小数：锚点是给重放用的，不需要亚像素精度。 */
function compactRects(rects: NormRect[]): NormRect[] {
  return mergeRects(rects).map((rect) => ({
    x: Math.round(rect.x * 100000) / 100000,
    y: Math.round(rect.y * 100000) / 100000,
    w: Math.round(rect.w * 100000) / 100000,
    h: Math.round(rect.h * 100000) / 100000,
  }));
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

  const raw = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .map((rect) => ({
      x: (rect.left - pageRect.left) / pageRect.width,
      y: (rect.top - pageRect.top) / pageRect.height,
      w: rect.width / pageRect.width,
      h: rect.height / pageRect.height,
    }));

  return compactRects(raw);
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

export const PdfPage = memo(function PdfPage({
  pdf,
  pageIndex,
  scale,
  baseSize,
  active,
  annotations,
  focusId,
  onSelect,
  onHover,
  hoverId,
  onHoverKeepAlive,
  searchMatch,
}: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<PageModel | null>(null);
  // pdf.js 会按页缓存 PDFPageProxy 及其图像数据；释放 canvas 之外还得让它 cleanup。
  const pageProxyRef = useRef<PDFPageProxy | null>(null);

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const searchRef = useRef(searchMatch);
  searchRef.current = searchMatch;
  const lastSearchToken = useRef(0);
  // 悬停命中检测用归一化矩形，避免每个 mousemove 都读一遍 DOM 布局。
  const hitRectsRef = useRef<{ id: string; rect: NormRect }[]>([]);
  const contextsRef = useRef(new Map<string, string>());
  const hoverIdRef = useRef<string | null>(null);

  const [size, setSize] = useState(baseSize);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const paintHighlights = useCallback(() => {
    const pageElement = pageRef.current;
    const layer = highlightRef.current;
    const model = modelRef.current;
    if (!pageElement || !layer || !model) return;

    layer.replaceChildren();
    hitRectsRef.current = [];
    contextsRef.current.clear();
    const pageRect = pageElement.getBoundingClientRect();
    if (pageRect.width === 0 || pageRect.height === 0) return;

    for (const annotation of annotationsRef.current) {
      const resolved = resolveCached(model, annotation.anchor);
      if (!resolved) continue;

      const computed = rectsForRange(model, resolved.start, resolved.end, pageElement);
      // 旧标注存的是逐字形矩形，绘制前同样合并，避免历史高亮出现接缝。
      const rects = computed.length > 0 ? computed : mergeRects(annotation.anchor.rects);

      // 悬停后 AI 解释复用页面正文里更宽的上下文，而不是锚点自带的 24 字。
      const CONTEXT_CHARS = 400;
      contextsRef.current.set(
        annotation.id,
        [
          model.text.slice(Math.max(0, resolved.start - CONTEXT_CHARS), resolved.start).trim(),
          model.text.slice(resolved.end, Math.min(model.text.length, resolved.end + CONTEXT_CHARS)).trim(),
        ]
          .filter(Boolean)
          .join('\n…\n'),
      );

      const lineKind =
        annotation.kind === 'underline' || annotation.kind === 'strikethrough';

      for (const rect of rects) {
        const element = document.createElement('div');
        element.className = [
          'highlight',
          `highlight-${annotation.color}`,
          lineKind ? `kind-${annotation.kind}` : '',
          annotation.id === focusRef.current ? 'focused' : '',
          resolved.kind === 'estimated' ? 'uncertain' : '',
        ]
          .filter(Boolean)
          .join(' ');
        if (lineKind) {
          element.style.setProperty('--mark-color', MARK_COLORS[annotation.color]);
        }
        element.style.left = `${rect.x * pageRect.width}px`;
        element.style.top = `${rect.y * pageRect.height}px`;
        element.style.width = `${rect.w * pageRect.width}px`;
        element.style.height = `${rect.h * pageRect.height}px`;
        layer.append(element);
        hitRectsRef.current.push({ id: annotation.id, rect });
      }
    }

    const search = searchRef.current;
    if (!search) return;

    const hits = rectsForRange(model, search.start, search.end, pageElement);
    for (const rect of hits) {
      const element = document.createElement('div');
      element.className = 'search-hit';
      element.style.left = `${rect.x * pageRect.width}px`;
      element.style.top = `${rect.y * pageRect.height}px`;
      element.style.width = `${rect.w * pageRect.width}px`;
      element.style.height = `${rect.h * pageRect.height}px`;
      layer.append(element);
    }

    // 同一个 token 只滚动一次，避免批注变化时反复把页面拽回命中处。
    if (hits.length > 0 && lastSearchToken.current !== search.token) {
      lastSearchToken.current = search.token;
      const target = pageRect.top + (hits[0].y + hits[0].h / 2) * pageRect.height;
      const viewer = pageElement.closest<HTMLElement>('.viewer');
      if (viewer) {
        const viewerRect = viewer.getBoundingClientRect();
        const delta = target - (viewerRect.top + viewerRect.height / 2);
        viewer.scrollTo({ top: Math.max(0, viewer.scrollTop + delta), behavior: 'instant' });
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

    if (!active) {
      // 离屏页只保留占位高度；否则一本 500 页的书会同时占住数 GB 画布。
      canvas.width = 1;
      canvas.height = 1;
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
      textElement.replaceChildren();
      textElement.style.removeProperty('width');
      textElement.style.removeProperty('height');
      highlightRef.current?.replaceChildren();
      modelRef.current = null;
      hitRectsRef.current = [];
      contextsRef.current.clear();
      hoverIdRef.current = null;
      // 只清 canvas 不够：页对象的操作符表和图像数据还在 pdf.js 的缓存里，
      // 一本 500 页的书从头翻到尾会一直涨内存。
      pageProxyRef.current?.cleanup();
      pageProxyRef.current = null;
      return;
    }

    const run = async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1);
        if (cancelled) return;
        pageProxyRef.current = page;

        const viewport = page.getViewport({ scale });
        // 正常缩放用设备像素比；高倍或超大页面则压低画布像素数，避免再次 OOM。
        const deviceRatio = Math.min(window.devicePixelRatio || 1, 3);
        const pixelRatio = Math.min(
          deviceRatio,
          Math.sqrt(16_000_000 / Math.max(1, viewport.width * viewport.height)),
        );

        // 首页尺寸只是占位估计；本页实际尺寸不同时再修正占位。
        const baseWidth = viewport.width / scale;
        const baseHeight = viewport.height / scale;
        setSize((current) =>
          Math.abs(current.width - baseWidth) < 0.5 && Math.abs(current.height - baseHeight) < 0.5
            ? current
            : { width: baseWidth, height: baseHeight },
        );

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
      canvas.width = 1;
      canvas.height = 1;
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
      textElement.replaceChildren();
      textElement.style.removeProperty('width');
      textElement.style.removeProperty('height');
      highlightRef.current?.replaceChildren();
      modelRef.current = null;
      hitRectsRef.current = [];
      contextsRef.current.clear();
      if (hoverIdRef.current !== null) {
        hoverIdRef.current = null;
        onHover(null);
      }
    };
  }, [active, pdf, pageIndex, scale, paintHighlights, onHover]);

  // 组件卸载（关闭文档、切换文档）时同样释放页对象。
  useEffect(
    () => () => {
      pageProxyRef.current?.cleanup();
      pageProxyRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (ready) paintHighlights();
  }, [ready, annotations, focusId, searchMatch, paintHighlights]);

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

      // 逐字形矩形合并成每行一条再入库：138 个矩形会变成 4 个，sidecar 小一个数量级。
      const rects = compactRects(
        Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
          .map((rect) => ({
            x: (rect.left - pageRect.left) / pageRect.width,
            y: (rect.top - pageRect.top) / pageRect.height,
            w: rect.width / pageRect.width,
            h: rect.height / pageRect.height,
          })),
      );
      if (rects.length === 0) return;

      const anchor = buildAnchor(pageIndex, model.text, start, end, rects);
      if (!anchor) return;

      // AI 解释需要比锚点宽得多的上下文；锚点本身仍只存前后 24 字。
      const CONTEXT_CHARS = 400;
      const context = [
        model.text.slice(Math.max(0, start - CONTEXT_CHARS), start).trim(),
        model.text.slice(end, Math.min(model.text.length, end + CONTEXT_CHARS)).trim(),
      ]
        .filter(Boolean)
        .join('\n…\n');

      const box = range.getBoundingClientRect();
      onSelect(anchor, { x: box.left + box.width / 2, y: box.top }, context);
    }, 0);
  }, [pageIndex, onSelect]);

  /** 鼠标悬停在标注上时上报位置；只在命中的标注变化时通知，避免每帧触发 React。 */
  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.buttons !== 0) return;
      const pageElement = pageRef.current;
      if (!pageElement) return;

      const pageRect = pageElement.getBoundingClientRect();
      if (pageRect.width === 0 || pageRect.height === 0) return;

      const x = (event.clientX - pageRect.left) / pageRect.width;
      const y = (event.clientY - pageRect.top) / pageRect.height;
      const hit = hitRectsRef.current.find(
        ({ rect }) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h,
      );

      if (hit) onHoverKeepAlive();
      const id = hit?.id ?? null;
      if (id === hoverIdRef.current && id === hoverId) return;
      hoverIdRef.current = id;

      if (!hit) {
        onHover(null);
        return;
      }
      const annotation = annotationsRef.current.find((item) => item.id === hit.id);
      if (!annotation) {
        hoverIdRef.current = null;
        onHover(null);
        return;
      }

      const top = pageRect.top + hit.rect.y * pageRect.height;
      onHover(
        annotation,
        {
          x: pageRect.left + (hit.rect.x + hit.rect.w / 2) * pageRect.width,
          y: top,
          below: top < 96,
        },
        contextsRef.current.get(annotation.id) ?? '',
      );
    },
    [hoverId, onHover, onHoverKeepAlive],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverIdRef.current === null) return;
    hoverIdRef.current = null;
    onHover(null);
  }, [onHover]);

  return (
    <div
      className="pdf-page"
      data-page-index={pageIndex}
      ref={pageRef}
      style={{ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div ref={highlightRef} className="highlight-layer" />
      <div ref={textRef} className="text-layer" />
      <span className="page-number">{pageIndex + 1}</span>
      {error && <span className="page-error">{error}</span>}
    </div>
  );
});
