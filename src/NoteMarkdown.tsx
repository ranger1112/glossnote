import type { ReactNode } from 'react';
import { Markdown } from './Markdown';
import { parseNoteLink } from './notes';
import type { NoteLinkTargets } from './types';

interface NoteMarkdownProps {
  text: string;
  targets: NoteLinkTargets;
  onOpenDoc: (docId: string, page?: number) => void;
  onFocusAnnotation: (docId: string, annotationId: string) => void;
  onJumpPage: (page: number) => void;
}

/** 只接受自有属性；`[[doc:constructor]]` 不能命中 Object.prototype。 */
function targetOf<T>(map: Record<string, T>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

export function NoteMarkdown({
  text,
  targets,
  onOpenDoc,
  onFocusAnnotation,
  onJumpPage,
}: NoteMarkdownProps) {
  const link = (raw: string): ReactNode | null => {
    const parsed = parseNoteLink(raw);
    if (!parsed) return null;

    if (parsed.kind === 'page') {
      return (
        <button
          type="button"
          className="note-page-chip"
          title={`跳到第 ${parsed.page} 页`}
          onClick={() => onJumpPage(parsed.page - 1)}
        >
          P{parsed.page}
        </button>
      );
    }

    if (parsed.kind === 'doc') {
      const target = targetOf(targets.documents, parsed.id);
      if (!target) return null;
      const label = target.title.trim() || target.name;
      return (
        <button
          type="button"
          className="note-link-chip"
          title={`打开 ${label}`}
          onClick={() => onOpenDoc(parsed.id, parsed.page ? parsed.page - 1 : undefined)}
        >
          {label}
          {parsed.page ? ` · P${parsed.page}` : ''}
        </button>
      );
    }

    const target = targetOf(targets.annotations, parsed.id);
    if (!target) return null;
    const quote =
      target.quote.length > 40 ? `${target.quote.slice(0, 40)}…` : target.quote;
    return (
      <button
        type="button"
        className="note-link-chip"
        title={target.quote || '打开标注'}
        onClick={() => onFocusAnnotation(target.docId, parsed.id)}
      >
        <span className={`color-dot ${target.color}`} />
        {quote || '标注'}
      </button>
    );
  };

  return <Markdown text={text} link={link} />;
}
