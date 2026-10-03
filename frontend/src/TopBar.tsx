/** 顶栏：项目选择 / 添加项目 / 索引进度 / 模型与设置 / 帮助。 */
import { useEffect, useState } from 'react';
import type { IndexStatus, ProjectInfo } from './api';
import { FolderBrowser } from './FolderBrowser';
import { useI18n } from './i18n';

interface Props {
  projects: ProjectInfo[];
  project: ProjectInfo | null;
  status: IndexStatus | null;
  openFile: string | null;
  onSelect: (id: string) => void;
  onOpenFolder: (root: string) => void;
  onForget: (id: string) => void;
  onReindex: () => void;
  onOpenSettings: () => void;
  /** 模型配置入口（与设置平级，2026-10-03 用户要求）。 */
  onOpenModel: () => void;
}

export function TopBar({
  projects,
  project,
  status,
  openFile,
  onSelect,
  onOpenFolder,
  onForget,
  onReindex,
  onOpenSettings,
  onOpenModel,
}: Props) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [showOpen, setShowOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const deepLink =
    project && openFile
      ? `${window.location.origin}/?project=${project.id}&file=${encodeURIComponent(openFile)}`
      : null;

  const progress = Math.round((status?.progress ?? 0) * 100);

  // 浮层统一 Esc 关闭（P25 无障碍）
  useEffect(() => {
    if (!showHelp && !showOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowHelp(false);
        setShowOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showHelp, showOpen]);

  return (
    <header className="topbar">
      <span className="brand">{t('app.title')}</span>

      <select
        className="project-select"
        value={project?.id ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        title={t('topbar.switchProject')}
        aria-label={t('topbar.switchProject')}
      >
        {projects.length === 0 && <option value="">{t('topbar.noProjects')}</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <button
        className="btn"
        onClick={() => setShowOpen((v) => !v)}
        aria-expanded={showOpen}
        aria-haspopup="dialog"
      >
        {t('topbar.openFolder')}
      </button>

      {showOpen && (
        <div className="open-folder" role="dialog" aria-label={t('topbar.openFolder')}>
          {/* 2026-10-03 用户要求：去掉输入框下面那行提示；路径可手输（回车直接添加），
              末尾放文件夹图标，点它弹目录选择窗（不再在弹层里内嵌一列目录） */}
          <div className="open-folder-row">
            <input
              className="text-input"
              autoFocus
              aria-label={t('topbar.openFolder')}
              placeholder="D:/code/my-project（本机绝对路径）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && input.trim()) {
                  onOpenFolder(input.trim());
                  setInput('');
                  setShowOpen(false);
                }
                if (e.key === 'Escape') setShowOpen(false);
              }}
            />
            <button
              className="icon-btn"
              title={t('folderBrowser.browse')}
              aria-label={t('folderBrowser.browse')}
              onClick={() => {
                setShowOpen(false);
                setBrowseOpen(true);
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h4.4l1.7 2h8.5A1.7 1.7 0 0 1 21 9.2v7.6A1.7 1.7 0 0 1 19.3 18.5H4.7A1.7 1.7 0 0 1 3 16.8V7.2Z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {browseOpen && (
        <FolderBrowser
          initialPath={input}
          onClose={() => setBrowseOpen(false)}
          onPick={(root) => {
            setInput('');
            setBrowseOpen(false);
            onOpenFolder(root);
          }}
        />
      )}

      {project && (
        <>
          <button className="btn ghost" onClick={onReindex} title={t('topbar.reindexTitle')}>
            {t('topbar.reindex')}
          </button>
          <button className="btn ghost" onClick={() => onForget(project.id)} title={t('topbar.removeTitle')}>
            {t('topbar.remove')}
          </button>
        </>
      )}

      <span className="spacer" />

      {project && (
        <span className="project-root" title={project.root}>
          {project.root}
        </span>
      )}

      {status?.indexing ? (
        <span className="indexing">
          {t('topbar.indexing', {
            percent: progress,
            indexed: status.filesIndexed,
            total: status.filesTotal,
          })}
          <span className="progress">
            <span className="progress-bar" style={{ width: `${progress}%` }} />
          </span>
        </span>
      ) : (
        status?.indexedAt && (
          <span
            className="indexed-ok"
            title={t('topbar.indexedTitle', { at: new Date(status.indexedAt).toLocaleString() })}
          >
            {t('topbar.indexed', { n: status.filesIndexed })}
          </span>
        )
      )}

      {deepLink && (
        <button className="btn ghost" title={deepLink} onClick={() => void navigator.clipboard.writeText(deepLink)}>
          {t('topbar.copyLink')}
        </button>
      )}

      <button className="btn ghost" onClick={onOpenModel} title={t('topbar.modelTitle')}>
        {t('topbar.model')}
      </button>

      <button className="btn ghost" onClick={onOpenSettings} title={t('topbar.settings')}>
        {t('topbar.settings')}
      </button>

      <button
        className="btn ghost"
        onClick={() => setShowHelp((v) => !v)}
        title={t('topbar.help')}
        aria-expanded={showHelp}
        aria-haspopup="dialog"
        aria-label={t('topbar.help')}
      >
        ?
      </button>

      {showHelp && (
        <div className="help-popover" role="dialog" aria-label={t('topbar.help')}>
          <div className="help-title">{t('topbar.helpTitle')}</div>
          <ul>
            <li>
              <kbd>F12</kbd> / <kbd>Ctrl</kbd>+<kbd>F12</kbd> 跳到定义（也支持 Ctrl/Cmd+Click、右键菜单）
            </li>
            <li>
              <kbd>Shift</kbd>+<kbd>F12</kbd> 查找引用
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>P</kbd> 文件搜索
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>T</kbd> 符号搜索
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> 全项目搜索
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> 文件大纲
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>1..9</kbd> 切侧栏面板（按侧栏里的顺序）
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>0</kbd> 批注面板
            </li>
            <li>
              <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> 后退 / 前进
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>G</kbd> 跳到行
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>F</kbd> 当前文件内搜索
            </li>
          </ul>
          <div className="help-title legend-title">{t('topbar.legendTitle')}</div>
          <ul className="legend">
            <li>
              <span className="swatch swatch-project">name</span>
              {t('topbar.legendProject')}
            </li>
            <li>
              <span className="swatch swatch-local">local_var</span>
              {t('topbar.legendLocal')}
            </li>
            <li>
              <span className="swatch swatch-external">os.path</span>
              {t('topbar.legendExternal')}
            </li>
          </ul>
          <div className="help-title legend-title">{t('topbar.helpSectionMore')}</div>
          <ul>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>,</kbd> {t('topbar.shortcutSettings')}
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}
