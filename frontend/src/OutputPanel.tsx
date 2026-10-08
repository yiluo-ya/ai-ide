/**
 * 底部「输出」面板（VS Code 布局迁移，2026-10-08）。
 *
 * 展示当前项目命令运行历史 + 输出（跑测试 / 编译的结果就在这看）。
 * 数据源复用 `GET /api/projects/:id/commands/runs`（后端已有，零改动）。
 * 后台任务只报 pid 与状态（输出走日志文件，这里不贴全量日志）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandRun } from '../../shared/types';
import { api } from './api';
import { useI18n } from './i18n';

const STATUS_LABEL: Record<CommandRun['status'], string> = {
  running: 'cmd.statusRunning',
  done: 'cmd.statusDone',
  failed: 'cmd.statusFailed',
  stopped: 'cmd.statusStopped',
  lost: 'cmd.statusLost',
};

function fmtTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function OutputPanel({ projectId }: { projectId: string | null }) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [filter, setFilter] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const { runs: list } = await api.commandRuns(projectId);
      setRuns(list);
    } catch {
      /* 状态拉取失败不打扰用户 */
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setRuns([]);
      return;
    }
    void refresh();
  }, [projectId, refresh]);

  // 有后台任务在跑时才轮询
  const hasRunning = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!projectId || !hasRunning) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [projectId, hasRunning, refresh]);

  const shown = filter
    ? runs.filter((r) => r.command.toLowerCase().includes(filter.toLowerCase()))
    : runs;

  if (!projectId) {
    return <div className="panel-empty">{t('app.noProject')}</div>;
  }

  return (
    <div className="output-panel">
      <div className="output-toolbar">
        <input
          className="text-input"
          placeholder={t('app.outputFilter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('');
          }}
        />
        <button className="btn ghost small" onClick={() => void refresh()} title={t('app.outputRefresh')}>
          {t('app.outputRefresh')}
        </button>
      </div>
      <div className="output-body" ref={bodyRef}>
        {shown.length === 0 ? (
          <div className="panel-empty">{t('app.outputEmpty')}</div>
        ) : (
          shown.map((run) => (
            <div key={run.id} className={`output-run status-${run.status}`}>
              <div className="output-run-head">
                <span className={`output-status s-${run.status}`}>{t(STATUS_LABEL[run.status])}</span>
                <code className="output-cmd" title={run.command}>
                  {run.command}
                </code>
                {run.exitCode != null && run.status !== 'running' && (
                  <span className="output-exit">exit {run.exitCode}</span>
                )}
                <span className="spacer" />
                <span className="output-time">{fmtTime(run.startedAt)}</span>
              </div>
              {run.background ? (
                <div className="output-meta">
                  {run.pid != null && `${t('app.outputPid', { pid: run.pid })} · `}
                  {run.logPath ?? t('app.outputBackgroundLog')}
                </div>
              ) : (
                run.output != null &&
                run.output.trim() !== '' && <pre className="output-text">{run.output}</pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}