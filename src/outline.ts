import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface OutlineEntry {
  id: string;
  title: string;
  /** 0 基页码。 */
  page: number;
  /** 目录层级，0 是顶层。 */
  depth: number;
}

type OutlineNodes = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>;

async function destPage(
  pdf: PDFDocumentProxy,
  dest: OutlineNodes[number]['dest'],
): Promise<number | null> {
  try {
    const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;

    const ref = resolved[0];
    if (typeof ref === 'number') return Math.max(0, ref);
    if (ref && typeof ref === 'object') {
      const index = await pdf.getPageIndex(
        ref as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      );
      return Math.max(0, index);
    }
    return null;
  } catch {
    return null;
  }
}

/** 把 pdf.js 的目录树拍平成按顺序排列的条目；没有目录时返回空数组。 */
export async function loadOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  let outline: OutlineNodes | null = null;
  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!outline) return [];

  const entries: OutlineEntry[] = [];
  let counter = 0;

  const walk = async (nodes: OutlineNodes, depth: number) => {
    for (const node of nodes) {
      if (entries.length >= 2000) return;
      const page = await destPage(pdf, node.dest);
      if (page !== null) {
        entries.push({
          id: `outline-${counter}`,
          title: node.title.trim() || `第 ${page + 1} 页`,
          page,
          depth,
        });
        counter += 1;
      }
      if (node.items?.length) {
        await walk(node.items, depth + 1);
      }
    }
  };

  await walk(outline, 0);
  return entries;
}
