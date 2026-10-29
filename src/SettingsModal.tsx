import type { AiSettingsView } from './types';
import type { AvailableUpdate } from './updater';
import { ShortcutList } from './ShortcutList';
import { IconMoon, IconSun } from './icons';

interface SettingsModalProps {
  desktop: boolean;
  theme: 'light' | 'dark';
  onTheme: (theme: 'light' | 'dark') => void;
  ai: AiSettingsView | null;
  onOpenAi: () => void;
  docOpen: boolean;
  libraryRoot: string;
  libraryBusy: 'scanning' | 'switching' | 'exporting' | null;
  onScanLibrary: () => void;
  onChangeLibrary: () => void;
  onExportMarkdown: () => void;
  version: string;
  update: AvailableUpdate | null;
  checkingUpdate: boolean;
  installingUpdate: boolean;
  onCheckUpdate: () => void;
  onClose: () => void;
}

export function SettingsModal({
  desktop,
  theme,
  onTheme,
  ai,
  onOpenAi,
  docOpen,
  libraryRoot,
  libraryBusy,
  onScanLibrary,
  onChangeLibrary,
  onExportMarkdown,
  version,
  update,
  checkingUpdate,
  installingUpdate,
  onCheckUpdate,
  onClose,
}: SettingsModalProps) {
  const updateNote = installingUpdate
    ? '正在下载并安装，完成后应用会重启。'
    : checkingUpdate
      ? '正在检查更新…'
      : update
        ? `新版本 ${update.version} 可用。`
        : '检查更新只在点击时联网，不会后台轮询。';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2>设置</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3>外观</h3>
          <div className="settings-row">
            <div>
              <strong>主题</strong>
              <span>暖纸色或深色，立即生效并记住选择。</span>
            </div>
            <div className="theme-choice">
              <button
                type="button"
                className={theme === 'light' ? 'active' : ''}
                onClick={() => onTheme('light')}
              >
                <IconSun size={14} />
                浅色
              </button>
              <button
                type="button"
                className={theme === 'dark' ? 'active' : ''}
                onClick={() => onTheme('dark')}
              >
                <IconMoon size={14} />
                深色
              </button>
            </div>
          </div>
        </section>

        {desktop && (
          <section className="settings-section">
            <h3>书库</h3>
            <div className="settings-row">
              <div className="settings-grow">
                <strong>书库位置</strong>
                <span className="settings-path" title={libraryRoot}>
                  {libraryRoot || '读取中…'}
                </span>
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={!!libraryBusy || docOpen}
                  title={docOpen ? '关闭当前文档后可重新扫描' : undefined}
                  onClick={onScanLibrary}
                >
                  {libraryBusy === 'scanning' ? '扫描中…' : '重新扫描'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!!libraryBusy || docOpen}
                  title={docOpen ? '关闭当前文档后可切换书库' : undefined}
                  onClick={onChangeLibrary}
                >
                  {libraryBusy === 'switching' ? '切换中…' : '更换位置'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!!libraryBusy}
                  onClick={onExportMarkdown}
                >
                  {libraryBusy === 'exporting' ? '导出中…' : '导出全部标注'}
                </button>
              </div>
            </div>
            <p className="settings-hint">
              书库目录可以放在坚果云、OneDrive 等同步目录；PDF 与 sidecar 会随目录一起同步。
              {docOpen ? ' 当前有打开的文档，扫描与切换位置暂时不可用。' : ''}
            </p>
          </section>
        )}

        {desktop && (
          <section className="settings-section">
            <h3>AI 阅读助手</h3>
            <div className="settings-row">
              <div>
                <strong>{ai?.ready ? '已启用' : '未启用'}</strong>
                <span>
                  {ai?.ready
                    ? `${ai.provider} · ${ai.model}`
                    : '默认关闭；只有主动解释、提问或总结时才联网。'}
                </span>
              </div>
              <button type="button" className="ghost" onClick={onOpenAi}>
                配置 AI
              </button>
            </div>
          </section>
        )}

        {desktop && (
          <section className="settings-section">
            <h3>更新</h3>
            <div className="settings-row">
              <div>
                <strong>GlossNote {version || '—'}</strong>
                <span>{updateNote}</span>
              </div>
              <button
                type="button"
                className="ghost"
                disabled={checkingUpdate || installingUpdate}
                onClick={onCheckUpdate}
              >
                {installingUpdate
                  ? '安装中…'
                  : checkingUpdate
                    ? '检查中…'
                    : update
                      ? `更新到 ${update.version}`
                      : '检查更新'}
              </button>
            </div>
          </section>
        )}

        <section className="settings-section">
          <h3>快捷键</h3>
          <p className="settings-hint">阅读器中按 <kbd>?</kbd> 也能打开这份列表。</p>
          <ShortcutList />
        </section>

        <section className="settings-section">
          <h3>关于</h3>
          <p className="settings-about">
            本地优先的 PDF 阅读与标注工具。无账号、无遥测；标注写入本地 SQLite，并镜像到书库
            sidecar。许可证 Apache-2.0。
          </p>
        </section>
      </div>
    </div>
  );
}
