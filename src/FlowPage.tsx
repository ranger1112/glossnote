import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { Anchor, NormRect, Resolution } from './anchoring';
import type { AnchorStrategy } from './document';
import type { FlowUnit } from './flow';
import { rectsFromRange } from './rects';
import type { Annotation } from './types';

/** 流式文档的基准版心宽度；实际宽度按缩放比例放大。 */
export const FLOW_PAGE_WIDTH = 720;
const BASE_FONT_SIZE = 16;

interface FlowPageProps {
  unit: FlowUnit;
  pageIndex: number;
  scale: number;
  anchorStrategy: AnchorStrategy;
  annotations: Annotation[];
  focusId: string | null;
  onSelect: (anchor: Anchor, box: { x: number; y: number }, context: string) => void;
  onHover: (
    annotation: Annotation | null,
    box?: { x: number; y: number; below: boolean },
    context?: string,
  ) => void;
  hoverId: string | null;
  onHoverKeepAlive: () => void;
  searchMatch?: { start: number; end: number; token: number };
}

interface TextNodeInfo {
  node: Text;
  start: number;
  end: number;
}

interface FlowModel {
  text: string;
  nodes: TextNodeInfo[];
  resolutions: Map<string, Resolution | null>;
}

interface Point {
  node: Text;
  offset: number;
}

function buildModel(root: HTMLElement): FlowModel {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: TextNodeInfo[] = [];
  let text = '';
  let current = walker.nextNode();

  while (current) {
    const node = current as Text;
    if (node.data.length > 0) {
      nodes.push({ node, start: text.length, end: text.length + node.data.length });
      text += node.data;
    }
    current = walker.nextNode();
  }

  return { text, nodes, resolutions: new Map() };
}

function pointAt(model: FlowModel, offset: number): Point | null {
  if (model.nodes.length === 0) return null;

  let low = 0;
  let high = model.nodes.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (model.nodes[middle].start <= offset) low = middle;
    else high = middle - 1;
  }

  const info = model.nodes[low];
  return {
    node: info.node,
    offset: Math.max(0, Math.min(info.node.length, offset - info.start)),
  };
}

function rangeFor(model: FlowModel, start: number, end: number): Range | null {
  const startPoint = pointAt(model, start);
  const endPoint = pointAt(model, end);
  if (!startPoint || !endPoint) return null;

  const range = document.createRange();
  try {
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
  } catch {
    return null;
  }
  return range;
}

function resolveCached(
  strategy: AnchorStrategy,
  model: FlowModel,
  anchor: Anchor,
): Resolution | null {
  const key = `${anchor.pageHash}:${anchor.start}:${anchor.end}:${anchor.quote}`;
  if (model.resolutions.has(key)) return model.resolutions.get(key) ?? null;

  const resolved = strategy.resolve(anchor, model.text);
  model.resolutions.set(key, resolved);
  return resolved;
}

/**
 * 把 DOM 里的点换算成整页纯文本偏移。用 Range 计算而不是逐个文本节点累加，
 * 这样文本节点、元素节点、跨段选区都能统一处理。
 */
function offsetFromPoint(
  root: HTMLElement,
  model: FlowModel,
  container: Node,
  offset: number,
): number | null {
  if (!root.contains(container)) return null;

  const range = document.createRange();
  try {
    range.setStart(root, 0);
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  return Math.max(0, Math.min(model.text.length, range.toString().length));
}

export const FlowPage = memo(function FlowPage({
  unit,
  pageIndex,
  scale,
  anchorStrategy,
  annotations,
  focusId,
  onSelect,
  onHover,
  hoverId,
  onHoverKeepAlive,
  searchMatch,
}: FlowPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<FlowModel | null>(null);
  const lastSearchToken = useRef(0);
  const hitRectsRef = useRef<{ id: string; rect: NormRect }[]>([]);
  const contextsRef = useRef(new Map<string, string>());
  const hoverIdRef = useRef<string | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointRef = useRef<{ x: number; y: number } | null>(null);
  const longPressFiredAtRef = useRef(0);

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const searchRef = useRef(searchMatch);
  searchRef.current = searchMatch;

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
      const resolved = resolveCached(anchorStrategy, model, annotation.anchor);
      if (!resolved) continue;

      const range = rangeFor(model, resolved.start, resolved.end);
      const computed = range ? rectsFromRange(range, pageElement) : [];
      const rects = computed.length > 0 ? computed : annotation.anchor.rects;

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
          element.style.setProperty(
            '--mark-color',
            { yellow: '#d9a400', green: '#1f9d63', blue: '#4b5cc4', pink: '#d4578a' }[
              annotation.color
            ],
          );
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

    const searchRange = rangeFor(model, search.start, search.end);
    const hits = searchRange ? rectsFromRange(searchRange, pageElement) : [];
    for (const rect of hits) {
      const element = document.createElement('div');
      element.className = 'search-hit';
      element.style.left = `${rect.x * pageRect.width}px`;
      element.style.top = `${rect.y * pageRect.height}px`;
      element.style.width = `${rect.w * pageRect.width}px`;
      element.style.height = `${rect.h * pageRect.height}px`;
      layer.append(element);
    }

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
  }, [anchorStrategy]);

  // 文本或缩放变化后重建索引；paintHighlights 同时负责把旧高亮按新布局重画。
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    modelRef.current = buildModel(root);
    paintHighlights();
  }, [unit.text, scale, paintHighlights]);

  useEffect(() => {
    if (modelRef.current) paintHighlights();
  }, [annotations, focusId, searchMatch, paintHighlights]);

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    },
    [],
  );

  const handleMouseUp = useCallback(() => {
    if (Date.now() - longPressFiredAtRef.current < 1200) return;

    window.setTimeout(() => {
      if (Date.now() - longPressFiredAtRef.current < 1200) return;
      const selection = window.getSelection();
      const pageElement = pageRef.current;
      const content = contentRef.current;
      const model = modelRef.current;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      if (!pageElement || !content || !model) return;

      const range = selection.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) return;
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return;

      const start = offsetFromPoint(content, model, range.startContainer, range.startOffset);
      const end = offsetFromPoint(content, model, range.endContainer, range.endOffset);
      if (start === null || end === null || end <= start) return;

      const rects = rectsFromRange(range, pageElement);
      if (rects.length === 0) return;

      const anchor = anchorStrategy.build(pageIndex, model.text, start, end, rects);
      if (!anchor) return;

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
  }, [pageIndex, onSelect, anchorStrategy]);

  const hitAt = useCallback((clientX: number, clientY: number) => {
    const pageElement = pageRef.current;
    if (!pageElement) return null;

    const pageRect = pageElement.getBoundingClientRect();
    if (pageRect.width === 0 || pageRect.height === 0) return null;

    const x = (clientX - pageRect.left) / pageRect.width;
    const y = (clientY - pageRect.top) / pageRect.height;
    const hit = hitRectsRef.current.find(
      ({ rect }) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h,
    );
    if (!hit) return null;

    const annotation = annotationsRef.current.find((item) => item.id === hit.id);
    if (!annotation) return null;

    const top = pageRect.top + hit.rect.y * pageRect.height;
    return {
      annotation,
      box: {
        x: pageRect.left + (hit.rect.x + hit.rect.w / 2) * pageRect.width,
        y: top,
        below: top < 96,
      },
      context: contextsRef.current.get(annotation.id) ?? '',
    };
  }, []);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.buttons !== 0) return;

      const hit = hitAt(event.clientX, event.clientY);
      if (hit) onHoverKeepAlive();
      const id = hit?.annotation.id ?? null;
      if (id === hoverIdRef.current && id === hoverId) return;
      hoverIdRef.current = id;

      if (!hit) {
        onHover(null);
        return;
      }
      onHover(hit.annotation, hit.box, hit.context);
    },
    [hitAt, hoverId, onHover, onHoverKeepAlive],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverIdRef.current === null) return;
    hoverIdRef.current = null;
    onHover(null);
  }, [onHover]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPointRef.current = null;
  }, []);

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      clearLongPress();
      if (event.touches.length !== 1) return;

      const touch = event.touches[0];
      longPressPointRef.current = { x: touch.clientX, y: touch.clientY };
      longPressTimerRef.current = window.setTimeout(() => {
        const point = longPressPointRef.current;
        if (!point) return;

        const hit = hitAt(point.x, point.y);
        if (!hit) return;

        longPressFiredAtRef.current = Date.now();
        hoverIdRef.current = hit.annotation.id;
        window.getSelection()?.removeAllRanges();
        onHover(hit.annotation, hit.box, hit.context);
      }, 480);
    },
    [clearLongPress, hitAt, onHover],
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const point = longPressPointRef.current;
      if (!point || longPressTimerRef.current === null) return;
      if (event.touches.length !== 1) {
        clearLongPress();
        return;
      }

      const touch = event.touches[0];
      if (Math.hypot(touch.clientX - point.x, touch.clientY - point.y) > 8) {
        clearLongPress();
      }
    },
    [clearLongPress],
  );

  const handleTouchEnd = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() - longPressFiredAtRef.current < 1200) event.preventDefault();
  }, []);

  return (
    <div
      className="flow-page"
      data-page-index={pageIndex}
      ref={pageRef}
      style={{ width: Math.round(FLOW_PAGE_WIDTH * scale) }}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={handleContextMenu}
    >
      <div
        ref={contentRef}
        className="flow-content"
        style={{ fontSize: `${BASE_FONT_SIZE * scale}px` }}
      >
        <div className="flow-text">{unit.text}</div>
      </div>
      <div ref={highlightRef} className="highlight-layer" />
      <span className="page-number">{pageIndex + 1}</span>
    </div>
  );
});
