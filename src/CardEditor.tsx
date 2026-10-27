import { useEffect, useMemo, useState } from 'react';
import type { CardView } from './types';

export interface CardDraft {
  title: string;
  body: string;
  links: string[];
}

interface CardEditorProps {
  heading: string;
  initial: CardDraft;
  cards: CardView[];
  excludeId?: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: CardDraft) => void;
}

export function CardEditor({
  heading,
  initial,
  cards,
  excludeId,
  saving,
  onCancel,
  onSave,
}: CardEditorProps) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [links, setLinks] = useState(initial.links);
  const [picker, setPicker] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const options = useMemo(
    () =>
      cards.filter(
        (view) =>
          !view.card.deleted && view.card.id !== excludeId && !links.includes(view.card.id),
      ),
    [cards, excludeId, links],
  );

  const titleOf = (id: string) =>
    cards.find((view) => view.card.id === id)?.card.title ?? '已删除的卡片';

  const addLink = () => {
    if (!picker) return;
    setLinks((current) => (current.includes(picker) ? current : [...current, picker]));
    setPicker('');
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="card-editor"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || saving) return;
          onSave({ title: title.trim(), body: body.trim(), links });
        }}
      >
        <header className="modal-head">
          <h2>{heading}</h2>
          <button type="button" className="icon-button" title="关闭" onClick={onCancel}>
            ×
          </button>
        </header>

        <label className="field">
          <span>标题</span>
          <input
            value={title}
            autoFocus
            placeholder="这张卡片要记住什么？"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="field">
          <span>内容</span>
          <textarea
            value={body}
            rows={7}
            placeholder="写下答案、理解或自己的话…"
            onChange={(event) => setBody(event.target.value)}
          />
        </label>

        <div className="field">
          <span>链接卡片</span>
          <div className="linked-cards">
            {links.length === 0 && <span className="muted">还没有链接</span>}
            {links.map((id) => (
              <span className="tag" key={id}>
                {titleOf(id)}
                <button
                  type="button"
                  title="移除链接"
                  onClick={() => setLinks((current) => current.filter((item) => item !== id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="link-picker">
            <select value={picker} onChange={(event) => setPicker(event.target.value)}>
              <option value="">选择一张卡片…</option>
              {options.map((view) => (
                <option key={view.card.id} value={view.card.id}>
                  {view.card.title}
                </option>
              ))}
            </select>
            <button type="button" className="ghost" disabled={!picker} onClick={addLink}>
              添加链接
            </button>
          </div>
        </div>

        <footer className="modal-foot">
          <span className="modal-spacer" />
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary" disabled={!title.trim() || saving}>
            {saving ? '保存中…' : '保存卡片'}
          </button>
        </footer>
      </form>
    </div>
  );
}
