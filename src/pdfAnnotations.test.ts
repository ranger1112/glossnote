import { describe, expect, it } from 'vitest';
import {
  boxesFromQuadPoints,
  colorFromRgb,
  itemBox,
  kindFromSubtype,
  normalizedRectsFromBoxes,
  textRangeForBoxes,
  type Box,
} from './pdfAnnotations';
import { joinPdfItems, type TextItemLike } from './pdfText';

const viewport = {
  width: 1000,
  height: 2000,
  convertToViewportPoint: (x: number, y: number) => [x, 2000 - y],
};

const items: TextItemLike[] = [
  { str: 'Alpha', hasEOL: false, transform: [10, 0, 0, 10, 10, 100], width: 50, height: 10 },
  { str: 'Beta', hasEOL: false, transform: [10, 0, 0, 10, 80, 100], width: 40, height: 10 },
  { str: 'Gamma', hasEOL: true, transform: [10, 0, 0, 10, 10, 70], width: 50, height: 10 },
];

describe('PDF 自带标注', () => {
  it('把任意 RGB 映射到最接近的一种标注色', () => {
    expect(colorFromRgb([255, 238, 88])).toBe('yellow');
    expect(colorFromRgb([0, 220, 120])).toBe('green');
    expect(colorFromRgb([80, 120, 255])).toBe('blue');
    expect(colorFromRgb([255, 80, 170])).toBe('pink');
    expect(colorFromRgb(null)).toBe('yellow');
  });

  it('识别支持的原生标注类型', () => {
    expect(kindFromSubtype('Highlight')).toBe('highlight');
    expect(kindFromSubtype('Underline')).toBe('underline');
    expect(kindFromSubtype('StrikeOut')).toBe('strikethrough');
    expect(kindFromSubtype('Square')).toBeNull();
    expect(kindFromSubtype(undefined)).toBeNull();
  });

  it('按 QuadPoints 每 8 个数拆成一行，缺失时退回外框', () => {
    const boxes = boxesFromQuadPoints(
      [0, 10, 50, 10, 0, 0, 50, 0, 100, 10, 150, 10, 100, 0, 150, 0],
      undefined,
    );
    expect(boxes).toEqual([
      { x1: 0, y1: 0, x2: 50, y2: 10 },
      { x1: 100, y1: 0, x2: 150, y2: 10 },
    ]);
    expect(boxesFromQuadPoints(null, [50, 60, 70, 80])).toEqual([
      { x1: 50, y1: 60, x2: 70, y2: 80 },
    ]);
  });

  it('把 PDF 坐标换算成自上而下的归一化矩形', () => {
    const rects = normalizedRectsFromBoxes(
      [{ x1: 100, y1: 1500, x2: 200, y2: 1600 }],
      viewport,
    );
    expect(rects).toEqual([{ x: 0.1, y: 0.2, w: 0.1, h: 0.05 }]);
  });

  it('用文字项几何找出被覆盖的字符区间', () => {
    const { text, starts } = joinPdfItems(items);
    expect(text).toBe('AlphaBeta Gamma\n');

    const lineOne: Box = { x1: 0, y1: 95, x2: 130, y2: 112 };
    expect(textRangeForBoxes(items, starts, [lineOne], text)).toEqual({ start: 0, end: 9 });

    const onlyBeta: Box = { x1: 75, y1: 95, x2: 125, y2: 112 };
    expect(textRangeForBoxes(items, starts, [onlyBeta], text)).toEqual({ start: 5, end: 9 });

    const lineTwo: Box = { x1: 0, y1: 68, x2: 80, y2: 82 };
    expect(textRangeForBoxes(items, starts, [lineTwo], text)).toEqual({ start: 10, end: 15 });

    const between: Box = { x1: 0, y1: 85, x2: 130, y2: 93 };
    expect(textRangeForBoxes(items, starts, [between], text)).toBeNull();
  });

  it('文本项外框覆盖基线到字高，并容出下缘', () => {
    expect(itemBox(items[0])).toEqual({ x1: 10, y1: 98.5, x2: 60, y2: 110 });
    expect(itemBox({ ...items[0], width: 0 })).toBeNull();
  });
});
