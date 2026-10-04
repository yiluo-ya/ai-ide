/**
 * 命令面板（FR-0005；2026-10-03 晚按用户要求收敛）。
 *
 * 只讲**当前打开的项目**自己的事，三块：
 * ① 当前项目：名称 / 路径 / 索引状态 / git 分支与未提交改动（拿不到的行不出现）；
 * ② 项目命令：说一句话 → code agent（只读）读本项目 → 得出**编译 / 后台启动 / 后台停止 /
 *    测试**这些命令（仓库里没有的给建议）→ 每条点一下就能真跑；
 * ③ 后台任务：当前项目**从这里启动**的后台进程（pid / 状态 / 日志 / 停止），没有就不显示。
 *
 * 2026-10-03 晚用户要求（原话：「我需要关注的当前打开的项目状态，如果无法获取，就不做」）：
 * 原来这里显示的是**阅读器自身**的 pid / 端口 / 重启 / 停止 —— 那是跑界面的进程，与当前项目无关
 * （打开的项目一个服务都没起，这里照样是「运行中」），已整块删除；重启 / 停止阅读器改用
 * `POST /api/service/restart|stop`（后端接口仍在）。命令行自己起的项目服务后端拿不到，也不显示。
 *
 * 安全：共享模式（service.manageable=false）下按钮全禁用；执行一律走确认对话框；
 * warn 级命令要在对话框里额外勾选；block 级命令没有运行按钮（后端也会拒）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommandKind,
  CommandPlan,
  CommandRisk,
  CommandRun,
  GitChangesResult,
  IndexStatus,
  ProjectCommand,
  ProjectInfo,
} from '../../shared/types';
import { agentApi } from './agentApi';
import { api } from './api';
import { Dialog } from './Dialog';
import { translate, useI18n } from './i18n';
import './service.css';

const KIND_LABEL: Record<CommandKind, string> = {
  build: 'cmd.kindBuild',
  start: 'cmd.kindStart',
  stop: 'cmd.kindStop',
  test: 'cmd.kindTest',
  other: 'cmd.kindOther',
};

/** 待确认的一次执行（来自卡片或自定义输入）。 */
interface Pending {
  command: string;
  kind: CommandKind;
  background: boolean;
  label: string;
  risk: CommandRisk;
  reason?: string;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return translate('cmd.durationSec', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return translate('cmd.durationMinSec', { m, s: s % 60 });
  return translate('cmd.durationHourMin', { h: Math.floor(m / 60), m: m % 60 });
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 运行时长的粗略展示（运行中：到现在；已结束：总耗时）。 */
function fmtElapsed(run: CommandRun): string {
  const end = run.endedAt ?? Date.now();
  return fmtDuration(Math.max(0, end - run.startedAt));
}

/** 索引状态一句话（拿不到就不显示这一行）；一个源文件都没有的项目如实说。 */
function fmtIndex(status: IndexStatus): string {
  if (status.indexing) return translate('cmd.indexing', { indexed: status.filesIndexed, total: status.filesTotal });
  if (status.filesTotal === 0) return translate('cmd.noSourceFiles');
  return translate('cmd.indexedFiles', { n: status.filesIndexed });
}

/** git 一句话：分支 + 未提交改动数（不是 git 仓库时调用方不显示这一行）。 */
function fmtGit(git: GitChangesResult): string {
  const branch = git.branch ?? translate('cmd.noCommits');
  return git.entries.length === 0
    ? translate('cmd.gitClean', { branch })
    : translate('cmd.gitDirty', { branch, n: git.entries.length });
}

const STATUS_LABEL: Record<CommandRun['status'], string> = {
  running: 'cmd.statusRunning',
  done: 'cmd.statusDone',
  failed: 'cmd.statusFailed',
  stopped: 'cmd.statusStopped',
  lost: 'cmd.statusLost',
};

export function CommandPanel({
  projectId,
  project,
  onOpenSession,
}: {
  projectId: string | null;
  /** 当前项目（名称 / 路径）：面板顶部展示；拿不到就不渲染（2026-10-03 用户要求）。 */
  project?: ProjectInfo | null;
  /** 去 Agent 面板看这次分析的会话（分析过程留在那儿）。 */
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useI18n();

  // ------------------------------------------------ 当前项目状态（2026-10-03 晚用户要求）
  /** 索引状态：单独拉一份（项目快照可能过期），拿不到就不显示这一行。 */
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  /** git 状态：不是仓库（isRepo=false）就不显示这一行。 */
  const [git, setGit] = useState<GitChangesResult | null>(null);
  /**
   * 是否可管理（共享模式 = false，按钮全禁用）。取值来自阅读器自身的服务状态 ——
   * 只用来做这个开关，服务信息本身不再显示（2026-10-03 晚）。
   */
  const [manageable, setManageable] = useState(false);

  useEffect(() => {
    void api
      .serviceStatus()
      .then((s) => setManageable(s.manageable))
      .catch(() => setManageable(false));
  }, []);

  // ------------------------------------------------------------ 项目命令
  const [plan, setPlan] = useState<CommandPlan | null>(null);
  const [prompt, setPrompt] = useState(t('cmd.promptDefault'));
  const [analyzing, setAnalyzing] = useState(false);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [cmdNote, setCmdNote] = useState<string | null>(null);
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [acked, setAcked] = useState(false);
  const [custom, setCustom] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refreshRuns = useCallback(async () => {
    if (!projectId) return;
    try {
      const { runs: list } = await api.commandRuns(projectId);
      setRuns(list);
    } catch {
      /* 状态拉取失败不打扰用户 */
    }
  }, [projectId]);

  useEffect(() => {
    setPlan(null);
    setCmdError(null);
    setCmdNote(null);
    setRuns([]);
    setIndexStatus(null);
    setGit(null);
    if (!projectId) return;
    void api
      .projectCommands(projectId)
      .then(({ plan: saved }) => setPlan(saved))
      .catch((e: unknown) => setCmdError(e instanceof Error ? e.message : String(e)));
    void refreshRuns();
    // 当前项目状态：两次调用各自容错 —— 拿不到的那行就不出现，不占位。
    void api
      .status(projectId)
      .then(setIndexStatus)
      .catch(() => setIndexStatus(null));
    void api
      .gitChanges(projectId)
      .then(setGit)
      .catch(() => setGit(null));
    void agentApi
      .modelConfig()
      .then((config) => {
        const withKey = config.providers.find((p) => p.hasKey && p.models.length > 0);
        setHasModel(Boolean(config.default || withKey));
      })
      .catch(() => setHasModel(false));
  }, [projectId, refreshRuns]);

  // 有后台任务在跑时才轮询（拿状态与日志尾部）
  const hasRunning = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!projectId || !hasRunning) return;
    const timer = window.setInterval(() => void refreshRuns(), 2000);
    return () => window.clearInterval(timer);
  }, [projectId, hasRunning, refreshRuns]);

  /** 每条命令最近一次运行（runs 已按时间倒序）。 */
  const lastRuns = useMemo(() => {
    const map = new Map<string, CommandRun>();
    for (const run of runs) if (!map.has(run.command)) map.set(run.command, run);
    return map;
  }, [runs]);

  const analyze = async () => {
    if (!projectId || analyzing) return;
    setAnalyzing(true);
    setCmdError(null);
    setCmdNote(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { plan: next } = await api.discoverCommands(
        projectId,
        prompt.trim() || t('cmd.promptDefault'),
        controller.signal,
      );
      setPlan(next);
      setCmdNote(t('cmd.analyzeDone', { n: next.commands.length }));
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        setCmdNote(t('cmd.analyzeAborted'));
      } else {
        setCmdError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setAnalyzing(false);
    }
  };

  const refreshPlan = async () => {
    if (!projectId) return;
    try {
      const { plan: saved } = await api.projectCommands(projectId);
      setPlan(saved);
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e));
    }
    void refreshRuns();
  };

  const askRun = (cmd: ProjectCommand) => {
    setAcked(false);
    setPending({
      command: cmd.command,
      kind: cmd.kind,
      background: cmd.background === true,
      label: cmd.label,
      risk: cmd.risk ?? 'none',
      ...(cmd.note ? { reason: cmd.note } : {}),
    });
  };

  const askCustom = async () => {
    const command = custom.trim();
    if (!projectId || !command) return;
    setCmdError(null);
    try {
      const { risk, reason } = await api.commandRisk(projectId, command);
      setAcked(false);
      setPending({
        command,
        kind: 'other',
        background: false,
        label: t('cmd.customLabel'),
        risk,
        ...(reason ? { reason } : {}),
      });
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmRun = async () => {
    if (!pending || !projectId) return;
    const input = { command: pending.command, kind: pending.kind, background: pending.background };
    setPending(null);
    try {
      const { run } = await api.runCommand(projectId, input);
      setRuns((prev) => [run, ...prev]);
      setExpanded((prev) => ({ ...prev, [run.id]: true }));
      setCmdNote(run.background ? t('cmd.startedBackground', { pid: run.pid ?? '?' }) : t('cmd.executed', { code: run.exitCode ?? '?' }));
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopRun = async (run: CommandRun) => {
    if (!projectId) return;
    try {
      const { run: next } = await api.stopCommand(projectId, run.id);
      setRuns((prev) => prev.map((item) => (item.id === next.id ? next : item)));
    } catch (e) {
      setCmdError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 索引状态：以单独拉取为准，退回项目快照；都没有就不显示这一行。 */
  const index = indexStatus ?? project?.status ?? null;

  return (
    <div className="service-panel">
      {/* ------------------------------------------------ 当前项目（2026-10-03 晚用户要求） */}
      {project && (
        <section className="cp-section">
          <div className="cp-head">
            <h3>{t('cmd.currentProject')}</h3>
          </div>
          <dl className="sv-facts">
            <div>
              <dt>{t('cmd.project')}</dt>
              <dd title={project.name}>{project.name}</dd>
            </div>
            <div>
              <dt>{t('cmd.path')}</dt>
              <dd className="sv-path" title={project.root}>
                {project.root}
              </dd>
            </div>
            {index && (
              <div>
                <dt>{t('cmd.index')}</dt>
                <dd>{fmtIndex(index)}</dd>
              </div>
            )}
            {git?.isRepo && (
              <div>
                <dt>git</dt>
                <dd>{fmtGit(git)}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {/* ------------------------------------------------ 项目命令 */}
      <section className="cp-section">
        <div className="cp-head">
          <h3>{t('cmd.projectCommands')}</h3>
          {plan && (
            <button className="btn ghost small" onClick={() => void refreshPlan()} disabled={analyzing}>
              {t('cmd.refresh')}
            </button>
          )}
        </div>

        {!projectId ? (
          <div className="sv-hint">{t('cmd.needProject')}</div>
        ) : (
          <>
            {!manageable && (
              <div className="sv-note">{t('cmd.sharedReadonly')}</div>
            )}
            {hasModel === false && (
              <div className="cp-notice">{t('cmd.noModel')}</div>
            )}

            <div className="cp-input-row">
              <input
                className="cp-input"
                value={prompt}
                placeholder={t('cmd.promptDefault')}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void analyze();
                }}
                disabled={analyzing}
              />
              {analyzing ? (
                <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
                  {t('cmd.stopWaiting')}
                </button>
              ) : (
                <button
                  className="btn"
                  onClick={() => void analyze()}
                  disabled={hasModel === false}
                  title={hasModel === false ? t('cmd.configureModelFirst') : t('cmd.letAgentRead')}
                >
                  {plan ? t('cmd.reanalyze') : t('cmd.analyze')}
                </button>
              )}
            </div>

            {analyzing && (
              <div className="cp-notice">{t('cmd.analyzingNote')}</div>
            )}
            {plan?.summary && (
              <div className="cp-summary">
                {plan.summary}
                <span className="cp-meta"> · {fmtTime(plan.createdAt)}</span>
                {plan.sessionId && onOpenSession && (
                  <button className="cp-link" onClick={() => onOpenSession(plan.sessionId as string)}>
                    {t('cmd.viewAnalysis')}
                  </button>
                )}
              </div>
            )}

            {cmdError && (
              <div className="sv-error" role="alert">
                {cmdError}
              </div>
            )}
            {cmdNote && <div className="sv-note">{cmdNote}</div>}

            {plan && plan.commands.length > 0 && (
              <ul className="cmd-list">
                {plan.commands.map((cmd) => {
                  const run = lastRuns.get(cmd.command);
                  const blocked = cmd.risk === 'block';
                  return (
                    <li className={`cmd-card${cmd.risk === 'warn' ? ' risky' : ''}`} key={cmd.id}>
                      <div className="cmd-card-head">
                        <span className={`cmd-kind k-${cmd.kind}`}>{t(KIND_LABEL[cmd.kind])}</span>
                        <span className="cmd-label" title={cmd.label}>
                          {cmd.label}
                        </span>
                        {cmd.source === 'generated' && <span className="cmd-tag">{t('cmd.suggested')}</span>}
                        <button
                          className="cp-copy"
                          title={t('cmd.copyCommand')}
                          onClick={() => void navigator.clipboard?.writeText(cmd.command).catch(() => undefined)}
                        >
                          {t('cmd.copy')}
                        </button>
                      </div>
                      <code className="cmd-text">{cmd.command}</code>
                      {cmd.note && <div className="cmd-note">{cmd.note}</div>}
                      {cmd.risk === 'warn' && <div className="cmd-risk">{t('cmd.riskWarn')}</div>}
                      {blocked && <div className="cmd-risk">{t('cmd.blocked')}</div>}
                      <div className="cmd-actions">
                        <button
                          className="btn small"
                          disabled={blocked || !manageable}
                          onClick={() => askRun({ ...cmd, background: false })}
                        >
                          {t('cmd.run')}
                        </button>
                        <button
                          className="btn ghost small"
                          disabled={blocked || !manageable}
                          onClick={() => askRun({ ...cmd, background: true })}
                        >
                          {t('cmd.runBackground')}
                        </button>
                      </div>
                      {run && (
                        <RunView
                          run={run}
                          expanded={expanded[run.id] === true}
                          onToggle={() => setExpanded((p) => ({ ...p, [run.id]: !p[run.id] }))}
                          onStop={() => void stopRun(run)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="cp-custom">
              <input
                className="cp-input"
                value={custom}
                placeholder={t('cmd.customPlaceholder')}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void askCustom();
                }}
              />
              <button
                className="btn ghost small"
                disabled={!custom.trim() || !manageable}
                onClick={() => void askCustom()}
              >
                {t('cmd.run')}
              </button>
            </div>

            {hasRunning && (
              <div className="cp-runs">
                <h4>{t('cmd.backgroundTasks')}</h4>
                {runs
                  .filter((run) => run.background && run.status === 'running')
                  .map((run) => (
                    <RunView
                      key={run.id}
                      run={run}
                      compact
                      expanded={expanded[run.id] === true}
                      onToggle={() => setExpanded((p) => ({ ...p, [run.id]: !p[run.id] }))}
                      onStop={() => void stopRun(run)}
                    />
                  ))}
              </div>
            )}
          </>
        )}
      </section>

      {pending && (
        <Dialog title={pending.label} onClose={() => setPending(null)}>
          <div className="cmd-confirm">
            <code className="cmd-text">{pending.command}</code>
            <p className="confirm-text">
              {pending.background ? t('cmd.confirmBackground') : t('cmd.confirmForeground')}
            </p>
            {pending.reason && <p className="cmd-note">{t('cmd.reason', { reason: pending.reason })}</p>}
            {pending.risk === 'block' && (
              <div className="cmd-risk">{t('cmd.confirmBlocked')}</div>
            )}
            {pending.risk === 'warn' && (
              <label className="cmd-ack">
                <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
                {t('cmd.ackRisk', { reason: pending.reason ?? t('cmd.possibleDestructive') })}
              </label>
            )}
          </div>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn"
              disabled={pending.risk === 'block' || (pending.risk === 'warn' && !acked)}
              onClick={() => void confirmRun()}
            >
              {pending.background ? t('cmd.runBackground') : t('cmd.run')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** 一次运行的状态条 + 输出（前台给输出，后台给日志尾部）。 */
function RunView({
  run,
  expanded,
  onToggle,
  onStop,
  compact = false,
}: {
  run: CommandRun;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className={`cmd-run${compact ? ' compact' : ''}`}>
      <div className="cmd-run-head">
        <span className={`cmd-dot s-${run.status}`} />
        <span className="cmd-run-status">{t(STATUS_LABEL[run.status])}</span>
        <span className="cp-meta">
          {run.pid ? `pid ${run.pid} · ` : ''}
          {fmtElapsed(run)}
          {run.exitCode !== undefined && run.exitCode !== null ? t('cmd.exitCode', { code: run.exitCode }) : ''}
        </span>
        {run.status === 'running' && (
          <button className="btn ghost small" onClick={onStop}>
            {t('cmd.stop')}
          </button>
        )}
        <button className="cp-link" onClick={onToggle}>
          {expanded ? t('cmd.collapseOutput') : t('cmd.viewOutput')}
        </button>
      </div>
      {expanded && <pre className="cmd-output">{run.output?.trim() ? run.output : t('cmd.noOutput')}</pre>}
    </div>
  );
}
