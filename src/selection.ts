export interface SelectionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * pdf.js 文本层按字形切分，选区会返回很多互相重叠、高度不一的矩形。
 * 先按垂直重叠归行，再合并同一行的水平区间；间距阈值跟随行高，
 * 高倍缩放下字符间距变大也不会拆成“一个字一个色块”。
 */
export function mergeSelectionRects(boxes: SelectionBox[]): SelectionBox[] {
  if (boxes.length === 0) return [];

  const sorted = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Array<{ top: number; bottom: number; boxes: SelectionBox[] }> = [];
  for (const box of sorted) {
    const line = lines.find((item) => {
      const overlap = Math.min(item.bottom, box.bottom) - Math.max(item.top, box.top);
      return overlap > Math.min(item.bottom - item.top, box.bottom - box.top) * 0.5;
    });
    if (line) {
      line.top = Math.min(line.top, box.top);
      line.bottom = Math.max(line.bottom, box.bottom);
      line.boxes.push(box);
    } else {
      lines.push({ top: box.top, bottom: box.bottom, boxes: [box] });
    }
  }

  const merged: SelectionBox[] = [];
  for (const line of lines) {
    const intervals = line.boxes
      .map((box) => [box.left, box.right] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    // 0.5 行高仍小于常见的分栏间隙；下限 12px 覆盖低倍缩放下的字形缝隙。
    const gapLimit = Math.max(12, (line.bottom - line.top) * 0.5);
    let current = intervals[0];
    for (const interval of intervals.slice(1)) {
      if (interval[0] <= current[1] + gapLimit) {
        current[1] = Math.max(current[1], interval[1]);
      } else {
        merged.push({ left: current[0], right: current[1], top: line.top, bottom: line.bottom });
        current = interval;
      }
    }
    merged.push({ left: current[0], right: current[1], top: line.top, bottom: line.bottom });
  }
  return merged;
}
