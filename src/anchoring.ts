/**
 * 标注锚定：把「选中了哪段文字」表示成一组可重放的坐标与文本选择器。
 *
 * 设计参照 W3C Web Annotation 的回退链：
 *   1. 页文本哈希一致 → 字符偏移仍然有效（exact）
 *   2. 原文仍能找到 → 用前后文消歧后重新定位（relocated）
 *   3. 原文被轻微改动 → 在页内做滑窗相似度匹配（relocated）
 *   4. 以上都失败 → 按原偏移比例估算位置（estimated）
 */

export interface NormRect {
  /** 相对页面宽高的归一化坐标，0~1，与缩放无关 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Anchor {
  /** 0 起始的页码 */
  page: number;
  /** 页面纯文本的哈希 */
  pageHash: string;
  /** 建锚时的页面文本长度，用于比例回退 */
  pageLength: number;
  /** 页面纯文本中的字符区间 [start, end) */
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** 建锚时的矩形，作为渲染与兜底依据 */
  rects: NormRect[];
}

export type ResolutionKind = 'exact' | 'relocated' | 'estimated';

export interface Resolution {
  start: number;
  end: number;
  kind: ResolutionKind;
}

const CONTEXT = 24;

/** FNV-1a 32 位，足够做页级指纹，不需要加密强度。 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildAnchor(
  page: number,
  pageText: string,
  start: number,
  end: number,
  rects: NormRect[],
): Anchor | null {
  if (start < 0 || end <= start || end > pageText.length) return null;

  const quote = pageText.slice(start, end);
  if (!quote.trim()) return null;

  return {
    page,
    pageHash: hashText(pageText),
    pageLength: pageText.length,
    start,
    end,
    quote,
    prefix: pageText.slice(Math.max(0, start - CONTEXT), start),
    suffix: pageText.slice(end, Math.min(pageText.length, end + CONTEXT)),
    rects,
  };
}

function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;

  let index = haystack.indexOf(needle);
  while (index !== -1) {
    hits.push(index);
    index = haystack.indexOf(needle, index + 1);
  }
  return hits;
}

function commonSuffixLength(left: string, right: string): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function commonPrefixLength(left: string, right: string): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

/** 字符二元组的 Dice 系数，用来容忍个别字词被改动。 */
function bigramSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const grams = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const remaining = grams.get(gram) ?? 0;
    if (remaining > 0) {
      hits += 1;
      grams.set(gram, remaining - 1);
    }
  }

  return (2 * hits) / (left.length + right.length - 2);
}

function searchFuzzy(pageText: string, quote: string): number {
  const length = quote.length;
  if (length < 4 || pageText.length < length) return -1;

  // 过长的选区做全页扫描代价高，截取前 240 字作为种子即可。
  const seed = quote.slice(0, 240);
  const seedLength = seed.length;
  let bestIndex = -1;
  let bestScore = 0;

  for (let i = 0; i <= pageText.length - seedLength; i += 1) {
    const score = bigramSimilarity(pageText.slice(i, i + seedLength), seed);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestScore >= 0.6 ? bestIndex : -1;
}

export function resolveAnchor(anchor: Anchor, pageText: string): Resolution | null {
  if (
    hashText(pageText) === anchor.pageHash &&
    pageText.slice(anchor.start, anchor.end) === anchor.quote
  ) {
    return { start: anchor.start, end: anchor.end, kind: 'exact' };
  }

  if (!anchor.quote) return null;

  const hits = findAll(pageText, anchor.quote);
  if (hits.length > 0) {
    let best = hits[0];
    let bestScore = -Infinity;

    for (const index of hits) {
      const before = pageText.slice(Math.max(0, index - anchor.prefix.length), index);
      const after = pageText.slice(
        index + anchor.quote.length,
        index + anchor.quote.length + anchor.suffix.length,
      );
      const score = commonSuffixLength(before, anchor.prefix) + commonPrefixLength(after, anchor.suffix);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }

    return { start: best, end: best + anchor.quote.length, kind: 'relocated' };
  }

  const fuzzyIndex = searchFuzzy(pageText, anchor.quote);
  if (fuzzyIndex >= 0) {
    return {
      start: fuzzyIndex,
      end: Math.min(pageText.length, fuzzyIndex + anchor.quote.length),
      kind: 'relocated',
    };
  }

  if (anchor.pageLength > 0 && pageText.length > 0) {
    const ratio = pageText.length / anchor.pageLength;
    const start = Math.min(pageText.length - 1, Math.max(0, Math.round(anchor.start * ratio)));
    const end = Math.min(pageText.length, Math.max(start + 1, Math.round(anchor.end * ratio)));
    return { start, end, kind: 'estimated' };
  }

  return null;
}
