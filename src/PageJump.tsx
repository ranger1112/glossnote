import { useRef, useState } from 'react';

interface PageJumpProps {
  /** 0 基当前页。 */
  currentPage: number;
  pageCount: number;
  onJump: (page: number) => void;
}

/** 侧栏页码：平时显示「x / y」，点开后输入页码回车即可跳转。 */
export function PageJump({ currentPage, pageCount, onJump }: PageJumpProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelRef = useRef(false);

  const startEditing = () => {
    cancelRef.current = false;
    setDraft(String(currentPage + 1));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    if (cancelRef.current) return;
    const value = Number.parseInt(draft, 10);
    if (Number.isFinite(value) && value >= 1 && value <= pageCount) {
      onJump(value - 1);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="page-jump"
        title="跳到指定页"
        aria-label={`第 ${currentPage + 1} 页，共 ${pageCount} 页，点击跳转`}
        onClick={startEditing}
      >
        {currentPage + 1} / {pageCount}
      </button>
    );
  }

  return (
    <form
      className="page-jump editing"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        autoFocus
        type="number"
        min={1}
        max={pageCount}
        value={draft}
        aria-label="跳到页码"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            cancelRef.current = true;
            setEditing(false);
          }
        }}
      />
      <span>/ {pageCount}</span>
    </form>
  );
}
