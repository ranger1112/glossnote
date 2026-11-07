/** 流式文档（TXT / HTML / EPUB）的统一分页模型。 */
export type FlowKind = 'txt' | 'html' | 'epub';

export interface FlowUnit {
  /** 纯文本；锚定、页内查找与正文索引都以它为准。 */
  text: string;
}

export interface FlowDocument {
  kind: FlowKind;
  units: FlowUnit[];
}

/** 每页目标字符数：太小 DOM 多，太大跳页粒度粗。 */
const TXT_UNIT_CHARS = 4000;

/**
 * TXT 按换行边界切页，尽量不把段落拆开。
 * 渲染时整页放在一个 pre-wrap 容器里，textContent 与 unit.text 完全一致，
 * 选区偏移可以直接当作锚点偏移。
 */
export function buildTextDocument(text: string): FlowDocument {
  const normalized = text.replace(/\r\n?/g, '\n');
  const units: FlowUnit[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + TXT_UNIT_CHARS);
    if (end < normalized.length) {
      const newline = normalized.lastIndexOf('\n', end);
      if (newline > start + TXT_UNIT_CHARS / 2) end = newline + 1;
    }
    units.push({ text: normalized.slice(start, end) });
    start = end;
  }

  if (units.length === 0) units.push({ text: '' });
  return { kind: 'txt', units };
}
