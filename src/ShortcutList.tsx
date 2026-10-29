const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['Ctrl', 'F'], label: '页内查找' },
  { keys: ['Ctrl', 'Z'], label: '撤销标注操作' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: '重做标注操作' },
  { keys: ['PageDown', 'Space'], label: '向下翻一屏' },
  { keys: ['PageUp', 'Shift', 'Space'], label: '向上翻一屏' },
  { keys: ['Home', 'End'], label: '第一页 / 最后一页' },
  { keys: ['Ctrl', '+', '−'], label: '放大 / 缩小' },
  { keys: ['Ctrl', '0'], label: '适应宽度' },
  { keys: ['Esc'], label: '关闭浮层、清除选区' },
  { keys: ['?'], label: '打开快捷键列表' },
];

/** 快捷键的唯一数据源：阅读器浮层与设置页共用。 */
export function ShortcutList() {
  return (
    <dl className="shortcut-list">
      {SHORTCUTS.map((item) => (
        <div key={item.label}>
          <dt>
            {item.keys.map((key, index) => (
              <span key={key}>
                {index > 0 && <span className="shortcut-sep">/</span>}
                <kbd>{key}</kbd>
              </span>
            ))}
          </dt>
          <dd>{item.label}</dd>
        </div>
      ))}
    </dl>
  );
}
