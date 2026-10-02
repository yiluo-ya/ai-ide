/** 顶栏：项目选择 / 打开本机目录 / 索引进度 / 常驻隐私角标 / 设置与帮助。 */
import { useEffect, useState } from 'react';
import type { IndexStatus, ProjectInfo } from './api';
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
  onOpenPrivacy: () => void;
  /** 后端提供索引报告端点时才传（P9 出口）；拿不到就隐藏入口，不报错。 */
  onOpenReport?: () => void;
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
  onOpenPrivacy,
  onOpenReport,
}: Props) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [showOpen, setShowOpen] = useState(false);
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
          <div className="hint-row">
            只读打开：不会写入、不会修改该目录里的任何文件。最近打开过的目录会留在下拉框里。
          </div>
        </div>
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

      {project && onOpenReport && (
        <button className="btn ghost" onClick={onOpenReport} title={t('topbar.indexReportTitle')}>
          {t('topbar.indexReport')}
        </button>
      )}

      {/* P17：常驻隐私承诺（点击可追证），不打扰阅读 */}
      <button className="privacy-badge" onClick={onOpenPrivacy} title={t('topbar.privacy')}>
        <span className="privacy-dot" aria-hidden="true" />
        <span className="privacy-text">{t('topbar.privacyBadge')}</span>
      </button>

      {deepLink && (
        <button className="btn ghost" title={deepLink} onClick={() => void navigator.clipboard.writeText(deepLink)}>
          {t('topbar.copyLink')}
        </button>
      )}

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
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> {t('topbar.shortcutPrivacy')}
            </li>
            <li>
              <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>I</kbd> {t('topbar.shortcutReport')}
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}
