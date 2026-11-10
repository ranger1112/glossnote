import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoteMarkdown } from './NoteMarkdown';
import type { NoteLinkTargets } from './types';

const targets: NoteLinkTargets = {
  annotations: {
    a1: {
      docId: 'doc-a',
      page: 4,
      quote: '一段被引用的原文',
      color: 'yellow',
      kind: 'highlight',
    },
  },
  documents: {
    'doc-b': {
      title: '目标文档',
      name: 'target.pdf',
      pageCount: 20,
      kind: 'pdf',
    },
  },
};

function render(text: string): string {
  return renderToStaticMarkup(
    <NoteMarkdown
      text={text}
      targets={targets}
      onOpenDoc={() => undefined}
      onFocusAnnotation={() => undefined}
      onJumpPage={() => undefined}
    />,
  );
}

describe('NoteMarkdown', () => {
  it('renders page and annotation links as chips', () => {
    const html = render('先看 [[page:3]]，再看 [[annotation:a1]]。');
    expect(html).toContain('note-page-chip');
    expect(html).toContain('P3');
    expect(html).toContain('note-link-chip');
    expect(html).toContain('一段被引用的原文');
    expect(html).not.toContain('[[page:3]]');
  });

  it('renders document links with page labels', () => {
    const html = render('参见 [[doc:doc-b#page=12]]。');
    expect(html).toContain('目标文档');
    expect(html).toContain('P12');
  });

  it('keeps unknown targets as raw text', () => {
    const html = render('未知 [[doc:missing]] 与 [[annotation:missing]]。');
    expect(html).toContain('[[doc:missing]]');
    expect(html).toContain('[[annotation:missing]]');
    expect(html).not.toContain('note-link-chip');
  });

  it('does not resolve prototype names as link targets', () => {
    const html = render('[[doc:constructor]] 与 [[annotation:__proto__]]');
    expect(html).toContain('[[doc:constructor]]');
    expect(html).toContain('[[annotation:__proto__]]');
    expect(html).not.toContain('note-link-chip');
  });

  it('does not link inside code spans', () => {
    const html = render('`[[page:3]]`');
    expect(html).toContain('[[page:3]]');
    expect(html).not.toContain('note-page-chip');
  });
});
