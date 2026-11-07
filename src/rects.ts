import type { NormRect } from './anchoring';

/**
 * pdf.js 的文本项按字形/词切分，相邻矩形常常互相压边。逐块绘制时重叠处会被
 * multiply 两次，看起来像一条条深色接缝。把同一行、横向相接的矩形先合并。
 */
export function mergeRects(rects: NormRect[]): NormRect[] {
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
export function compactRects(rects: NormRect[]): NormRect[] {
  return mergeRects(rects).map((rect) => ({
    x: Math.round(rect.x * 100000) / 100000,
    y: Math.round(rect.y * 100000) / 100000,
    w: Math.round(rect.w * 100000) / 100000,
    h: Math.round(rect.h * 100000) / 100000,
  }));
}

/** 把 DOM Range 的屏幕矩形归一化到页面容器；PDF 与流式文档共用。 */
export function rectsFromRange(range: Range, pageElement: HTMLElement): NormRect[] {
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
