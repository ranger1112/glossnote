import {
  buildAnchor,
  resolveAnchor,
  type Anchor,
  type AnchorLocator,
  type NormRect,
  type Resolution,
} from './anchoring';

/** 阅读器支持的文档格式；内部把页面/章节统一叫 unit。 */
export type DocKind = 'pdf' | 'txt' | 'html' | 'epub';

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  pdf: 'PDF',
  txt: 'TXT',
  html: 'HTML',
  epub: 'EPUB',
};

/**
 * 统一文档模型：PDF 页、TXT 分页、HTML 章节、EPUB spine 都映射成一个 unit。
 * 书签、阅读进度与标注的 page 字段都指向 unit 序号，上层 UI 不感知格式。
 */
export interface ReaderDocument {
  id: string;
  kind: DocKind;
  name: string;
  unitCount: number;
}

/**
 * 锚定策略：不同格式对「位置」的表达不同，上层只认 unit + 文本区间 + 归一化矩形。
 * PDF/TXT/HTML 共用文本偏移策略；EPUB 之后会增加 CFI 作为首选定位，仍以文本回退。
 */
export interface AnchorStrategy {
  build(
    unit: number,
    unitText: string,
    start: number,
    end: number,
    rects: NormRect[],
    locator?: AnchorLocator,
  ): Anchor | null;
  resolve(anchor: Anchor, unitText: string): Resolution | null;
}

export const textAnchorStrategy: AnchorStrategy = {
  build: buildAnchor,
  resolve: resolveAnchor,
};

/** 未知格式按 PDF 处理：旧数据库与旧 sidecar 都缺 kind 字段。 */
export function normalizeDocKind(value: string | null | undefined): DocKind {
  return value === 'txt' || value === 'html' || value === 'epub' ? value : 'pdf';
}
