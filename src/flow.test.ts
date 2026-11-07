import { describe, expect, it } from 'vitest';
import { normalizeDocKind } from './document';
import { buildTextDocument } from './flow';

describe('buildTextDocument', () => {
  it('splits long text at newline boundaries without losing characters', () => {
    const text = Array.from({ length: 1200 }, (_, index) => `第${index}行`).join('\n');
    const doc = buildTextDocument(text);

    expect(doc.kind).toBe('txt');
    expect(doc.units.length).toBeGreaterThan(1);
    expect(doc.units.map((unit) => unit.text).join('')).toBe(text);
    for (const unit of doc.units) {
      expect(unit.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it('normalizes CRLF and keeps an empty document readable', () => {
    const doc = buildTextDocument('a\r\nb\r\n');
    expect(doc.units.map((unit) => unit.text).join('')).toBe('a\nb\n');
    expect(buildTextDocument('').units).toHaveLength(1);
  });

  it('hard-splits a single very long paragraph', () => {
    const doc = buildTextDocument('x'.repeat(9000));
    expect(doc.units).toHaveLength(3);
  });
});

describe('normalizeDocKind', () => {
  it('keeps known formats and falls back to pdf', () => {
    expect(normalizeDocKind('txt')).toBe('txt');
    expect(normalizeDocKind('epub')).toBe('epub');
    expect(normalizeDocKind(undefined)).toBe('pdf');
    expect(normalizeDocKind('docx')).toBe('pdf');
  });
});
