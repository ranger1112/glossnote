import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNoteLink, parseNoteLinks, readNote, saveNote } from './notes';

class MemoryStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('note links', () => {
  it('parses supported link forms', () => {
    expect(parseNoteLink('[[page:12]]')).toEqual({ kind: 'page', page: 12 });
    expect(parseNoteLink('[[annotation:ann-1]]')).toEqual({
      kind: 'annotation',
      id: 'ann-1',
    });
    expect(parseNoteLink('[[doc:abc_123]]')).toEqual({ kind: 'doc', id: 'abc_123' });
    expect(parseNoteLink('[[doc:abc#page=3]]')).toEqual({
      kind: 'doc',
      id: 'abc',
      page: 3,
    });
  });

  it('rejects malformed or unsafe links', () => {
    for (const raw of [
      '[[page:0]]',
      '[[page:-1]]',
      '[[page:1x]]',
      '[[annotation:]]',
      '[[annotation:../x]]',
      '[[doc:../x]]',
      '[[doc:abc#page=0]]',
      '[[unknown:1]]',
      '[[page:12]] trailing',
    ]) {
      expect(parseNoteLink(raw)).toBeNull();
    }
  });

  it('collects multiple links with source offsets', () => {
    const text = '开头 [[page:2]]，再看 [[annotation:a1]]。';
    const tokens = parseNoteLinks(text);
    expect(tokens.map((token) => token.link)).toEqual([
      { kind: 'page', page: 2 },
      { kind: 'annotation', id: 'a1' },
    ]);
    expect(tokens[0].start).toBe(text.indexOf('[[page:2]]'));
    expect(tokens[1].end).toBe(text.indexOf('[[annotation:a1]]') + '[[annotation:a1]]'.length);
  });
});

describe('browser note store', () => {
  it('round-trips a note and computes revisions', async () => {
    const before = await readNote('doc1');
    expect(before).toEqual({ text: '', updatedAt: 0, revision: '' });

    const saved = await saveNote('doc1', '第一行\n第二行', '');
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    expect(saved.note.text).toBe('第一行\n第二行');
    expect(saved.note.revision).toMatch(/^[0-9a-f]{64}$/);

    expect(await readNote('doc1')).toEqual(saved.note);
  });

  it('returns conflict for a stale revision', async () => {
    const first = await saveNote('doc1', '第一版', '');
    if (first.status !== 'saved') throw new Error('expected saved');

    const second = await saveNote('doc1', '第二版', '');
    expect(second.status).toBe('conflict');
    if (second.status !== 'conflict') return;
    expect(second.current.text).toBe('第一版');

    const retry = await saveNote('doc1', '第二版', second.current.revision);
    expect(retry.status).toBe('saved');
  });

  it('removes the record when the note becomes empty', async () => {
    const first = await saveNote('doc1', '内容', '');
    if (first.status !== 'saved') throw new Error('expected saved');

    const cleared = await saveNote('doc1', '  \n', first.note.revision);
    expect(cleared.status).toBe('saved');
    if (cleared.status !== 'saved') return;
    expect(cleared.note.revision).toBe('');
    expect(localStorage.getItem('glossnote:note:doc1')).toBeNull();
  });

  it('rejects text over 2 MB', async () => {
    await expect(saveNote('doc1', 'a'.repeat(2 * 1024 * 1024 + 1), '')).rejects.toThrow(
      /2 MB/,
    );
  });
});
