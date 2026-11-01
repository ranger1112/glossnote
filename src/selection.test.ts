import { describe, expect, it } from 'vitest';
import { mergeSelectionRects } from './selection';

describe('mergeSelectionRects', () => {
  it('把同一行高度不同的重叠字形矩形合并成一个色带', () => {
    const merged = mergeSelectionRects([
      { left: 72, top: 245, right: 89, bottom: 268 },
      { left: 91, top: 245, right: 108, bottom: 268 },
      { left: 111, top: 245, right: 225, bottom: 268 },
      { left: 91, top: 249, right: 108, bottom: 264 },
      { left: 111, top: 249, right: 208, bottom: 264 },
    ]);
    expect(merged).toEqual([{ left: 72, top: 245, right: 225, bottom: 268 }]);
  });

  it('不同行保持分开', () => {
    const merged = mergeSelectionRects([
      { left: 10, top: 245, right: 100, bottom: 268 },
      { left: 10, top: 273, right: 120, bottom: 296 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].top).toBe(245);
    expect(merged[1].top).toBe(273);
  });

  it('高倍缩放时按行高放宽字距阈值', () => {
    const merged = mergeSelectionRects([
      { left: 0, top: 100, right: 60, bottom: 183 },
      { left: 95, top: 100, right: 155, bottom: 183 },
      { left: 190, top: 100, right: 250, bottom: 183 },
    ]);
    expect(merged).toEqual([{ left: 0, top: 100, right: 250, bottom: 183 }]);
  });

  it('分栏等大间隙不会被连成一片', () => {
    const merged = mergeSelectionRects([
      { left: 0, top: 100, right: 100, bottom: 123 },
      { left: 180, top: 100, right: 280, bottom: 123 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('空选区返回空数组', () => {
    expect(mergeSelectionRects([])).toEqual([]);
  });
});
