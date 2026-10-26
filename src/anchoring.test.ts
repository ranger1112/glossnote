import { describe, expect, it } from 'vitest';
import { buildAnchor, hashText, resolveAnchor } from './anchoring';

const PAGE =
  '阅读不是把文字从纸上搬到脑子里，而是把问题带回自己的生活。' +
  '标注的价值不在数量，而在于它能否在几周之后把你送回当初的现场。' +
  '所以锚定必须足够稳：换字号、换窗口、重新打开，都要落在同一行字上。';

function anchorAround(quote: string, page = PAGE) {
  const start = page.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  const anchor = buildAnchor(0, page, start, start + quote.length, [
    { x: 0.1, y: 0.2, w: 0.3, h: 0.02 },
  ]);
  expect(anchor).not.toBeNull();
  return anchor!;
}

describe('buildAnchor', () => {
  it('拒绝空选区与越界区间', () => {
    expect(buildAnchor(0, PAGE, 5, 5, [])).toBeNull();
    expect(buildAnchor(0, PAGE, -1, 5, [])).toBeNull();
    expect(buildAnchor(0, PAGE, 0, PAGE.length + 1, [])).toBeNull();
  });

  it('记录原文、前后文与页哈希', () => {
    const anchor = anchorAround('标注的价值');
    expect(anchor.quote).toBe('标注的价值');
    expect(anchor.prefix.endsWith('自己的生活。')).toBe(true);
    expect(anchor.suffix.startsWith('不在数量')).toBe(true);
    expect(anchor.pageHash).toBe(hashText(PAGE));
    expect(anchor.pageLength).toBe(PAGE.length);
  });
});

describe('resolveAnchor', () => {
  it('页面未变时精确命中', () => {
    const anchor = anchorAround('标注的价值');
    const resolved = resolveAnchor(anchor, PAGE);
    expect(resolved).toEqual({ start: anchor.start, end: anchor.end, kind: 'exact' });
  });

  it('页面在前面插入内容后重新定位', () => {
    const anchor = anchorAround('标注的价值');
    const shifted = '新增的序言。' + PAGE;
    const resolved = resolveAnchor(anchor, shifted);
    expect(resolved?.kind).toBe('relocated');
    expect(shifted.slice(resolved!.start, resolved!.end)).toBe('标注的价值');
    expect(resolved!.start).toBe(anchor.start + 6);
  });

  it('同一句话出现多次时用前后文消歧', () => {
    const original = '甲。标注的价值。乙。标注的价值。丙。';
    const start = original.lastIndexOf('标注的价值');
    const anchor = buildAnchor(0, original, start, start + 5, [])!;

    const shifted = '新增内容。' + original;
    const resolved = resolveAnchor(anchor, shifted);
    expect(resolved?.kind).toBe('relocated');
    expect(resolved!.start).toBe(start + 5);
    expect(shifted.slice(resolved!.start, resolved!.end)).toBe('标注的价值');
  });

  it('原文被改了一个字时仍能按相似度找回', () => {
    const anchor = anchorAround('标注的价值不在数量');
    const altered = PAGE.replace('标注的价值不在数量', '标注的意义不在数量');
    const resolved = resolveAnchor(anchor, altered);
    expect(resolved?.kind).toBe('relocated');
    expect(altered.slice(resolved!.start, resolved!.end)).toBe('标注的意义不在数量');
  });

  it('页面完全换掉时按比例估算而不是丢失', () => {
    const anchor = anchorAround('标注的价值');
    const other = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.repeat(2);
    const resolved = resolveAnchor(anchor, other);
    expect(resolved?.kind).toBe('estimated');
    expect(resolved!.start).toBeGreaterThanOrEqual(0);
    expect(resolved!.end).toBeLessThanOrEqual(other.length);
  });
});
