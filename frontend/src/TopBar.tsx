/**
 * 顶栏：项目选择 / 添加项目 / 索引状态。
 *
 * 2026-10-15 用户要求（需求 3 / 4）：原先挤在右侧的三类入口各自归位 ——
 * - 「模型」「设置」「快捷键」→ 左下活动栏底部（竖排图标，见 App.tsx 的 left-rail）；
 * - 「复制文件链接」「移除」「项目根路径显示」→ 文件树顶部的根目录行（见 FileTree.tsx）。
 * 顶栏只留「跟项目有关」的事：切项目 / 加项目 / 重建索引 / 索引进度，
 * 最右端额外放「最大化 / 还原」两个窗口按钮（需求 5，等价浏览器 F11 全屏）。
 */
import { useEffect, useState } from 'react';
import type { IndexStatus, ProjectInfo } from './api';
import { FolderBrowser } from './FolderBrowser';
import { useI18n } from './i18n';

interface Props {
  projects: ProjectInfo[];
  project: ProjectInfo | null;
  status: IndexStatus | null;
  onSelect: (id: string) => void;
  onOpenFolder: (root: string) => void;
  /** 2026-10-15：移除项目仍留在顶栏（用户要求：不该放到文件里）；复制与目录显示去了文件树根行。 */
  onForget: (id: string) => void;
  onReindex: () => void;
}

export function TopBar({ projects, project, status, onSelect, onOpenFolder, onForget, onReindex }: Props) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [showOpen, setShowOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const progress = Math.round((status?.progress ?? 0) * 100);
  /** 2026-10-15 需求 5：是否处于全屏（两个按钮按它禁用无效的那个）。 */
  const [fullscreen, setFullscreen] = useState(false);

  // 全屏状态跟随浏览器（用户按 F11 / Esc 退出时按钮要跟着变）
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // 浮层 Esc 关闭（P25 无障碍）
  useEffect(() => {
    if (!showOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showOpen]);

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
              placeholder={t('welcome.pathPlaceholder')}
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

      {/* 2026-10-15 需求 5：顶栏最右边的两个按钮 —— 最大化 / 还原（等价浏览器 F11 全屏）。 */}
      <div className="window-controls">
        <button
          type="button"
          className="topbar-icon-btn"
          disabled={fullscreen}
          title={t('app.maximize')}
          aria-label={t('app.maximize')}
          onClick={() => void document.documentElement.requestFullscreen().catch(() => {})}
        >
          {/* 四角向外（最大化 = 进全屏） */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3" />
          </svg>
        </button>
        <button
          type="button"
          className="topbar-icon-btn"
          disabled={!fullscreen}
          title={t('app.restore')}
          aria-label={t('app.restore')}
          onClick={() => void document.exitFullscreen().catch(() => {})}
        >
          {/* 四角向内（还原 = 退全屏） */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 3v4a2 2 0 0 1-2 2H3M21 9h-4a2 2 0 0 1-2-2V3M3 15h4a2 2 0 0 1 2 2v4M15 21v-4a2 2 0 0 1 2-2h4" />
          </svg>
        </button>
      </div>
    </header>
  );
}
