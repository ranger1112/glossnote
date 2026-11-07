import { Readability } from '@mozilla/readability';
import type { OutlineEntry } from './outline';

/** 流式文档（TXT / HTML / EPUB）的统一分页模型。 */
export type FlowKind = 'txt' | 'html' | 'epub';

export interface FlowUnit {
  /** 纯文本；锚定、页内查找与正文索引都以它为准。 */
  text: string;
  /** HTML / EPUB 单元的内容；TXT 单元没有。 */
  html?: string;
}

export interface FlowDocument {
  kind: FlowKind;
  units: FlowUnit[];
  /** 从 HTML 标题提取的大纲；TXT 为空。 */
  outline: OutlineEntry[];
  title?: string;
  author?: string;
}

/** 每页目标字符数：太小 DOM 多，太大跳页粒度粗。 */
const TXT_UNIT_CHARS = 4000;
const HTML_UNIT_CHARS = 3500;

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
  return { kind: 'txt', units, outline: [] };
}

/** 这些标签直接删掉：脚本、样式、嵌入对象与表单控件都不该进入阅读区。 */
const BLOCKED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'FRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'BASE',
  'FORM',
  'INPUT',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
  'VIDEO',
  'AUDIO',
  'CANVAS',
  'NOSCRIPT',
]);

/** 只对通用容器继续下钻；列表、表格、引用块保持整体，避免拆坏结构。 */
const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BODY']);

function sanitizeFragment(root: Element): void {
  for (const element of Array.from(root.querySelectorAll('*'))) {
    // SVG 里的标签名是小写（script/style），统一成大写再判断。
    if (BLOCKED_TAGS.has(element.tagName.toUpperCase())) {
      element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style' || name === 'srcset') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^(javascript|vbscript|data:text\/html)/i.test(value)
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      // 本地优先：不主动加载远程图片，避免打开文档时联网。
      if ((name === 'src' || name === 'poster') && /^(https?:)?\/\//i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

/**
 * 把 HTML 正文拆成阅读页：通用容器按累计文本量下钻，再按目标字数分组。
 * 标题同时写入大纲，目录面板可以直接跳转。
 */
export function buildFlowFromHtml(
  html: string,
  kind: FlowKind,
  title?: string,
  author?: string,
): FlowDocument {
  const container = document.createElement('div');
  container.innerHTML = html;
  sanitizeFragment(container);

  const blocks: Node[] = [];
  const collect = (node: Node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
    const length = node.textContent?.length ?? 0;
    if (element && CONTAINER_TAGS.has(element.tagName.toUpperCase()) && length > HTML_UNIT_CHARS) {
      for (const child of Array.from(element.childNodes)) collect(child);
      return;
    }
    blocks.push(node);
  };
  for (const node of Array.from(container.childNodes)) collect(node);

  const units: FlowUnit[] = [];
  const outline: OutlineEntry[] = [];
  let group: Node[] = [];
  let groupLength = 0;

  const flush = () => {
    if (group.length === 0) return;

    const holder = document.createElement('div');
    for (const node of group) holder.append(node.cloneNode(true));
    const unitHtml = holder.innerHTML;

    // 用同一份 HTML 再解析一次得到纯文本，保证与 FlowPage 渲染后的 textContent 一致。
    const measure = document.createElement('div');
    measure.innerHTML = unitHtml;
    const unitIndex = units.length;
    units.push({ text: measure.textContent ?? '', html: unitHtml });

    for (const heading of Array.from(measure.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
      const text = heading.textContent?.trim();
      if (!text) continue;
      const depth = Math.max(0, Math.min(5, Number(heading.tagName[1]) - 1));
      outline.push({ id: `outline-${outline.length}`, title: text, page: unitIndex, depth });
    }

    group = [];
    groupLength = 0;
  };

  for (const node of blocks) {
    const length = node.textContent?.length ?? 0;
    if (group.length > 0 && groupLength + length > HTML_UNIT_CHARS) flush();
    group.push(node);
    groupLength += length;
  }
  flush();

  if (units.length === 0) units.push({ text: '', html: '' });
  return { kind, units, outline, title, author };
}

/**
 * 用 Readability 提取正文；提取失败时退回整个 body。
 * 导入的是本地 HTML 文件，文件本身已是冻存快照，原网页改版不会影响标注。
 */
export function buildHtmlDocument(source: string): FlowDocument {
  const parsed = new DOMParser().parseFromString(source, 'text/html');

  let article: ReturnType<Readability['parse']> = null;
  try {
    article = new Readability(parsed).parse();
  } catch {
    article = null;
  }

  if (article?.content) {
    return buildFlowFromHtml(
      article.content,
      'html',
      article.title?.trim() || undefined,
      article.byline?.trim() || undefined,
    );
  }

  // Readability 会改写传入的 document，兜底路径重新解析一次。
  const fallback = new DOMParser().parseFromString(source, 'text/html');
  const body = fallback.body;
  sanitizeFragment(body);
  return buildFlowFromHtml(
    body.innerHTML,
    'html',
    fallback.title?.trim() || undefined,
    undefined,
  );
}
