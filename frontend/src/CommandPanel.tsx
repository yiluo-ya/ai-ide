/**
 * 命令面板（FR-0005，2026-10-03 用户要求）：命令管理 —— 项目命令 + 阅读器服务。
 *
 * 上半「项目命令」：说一句话 → 让 code agent（只读）读本项目 → 得出**编译 / 后台启动 /
 * 后台停止 / 测试**这些命令（仓库里没有的给建议）→ 每条点一下就能真跑。
 * 下半「服务」：原功能（阅读器后端自己的状态 / 重启 / 停止）。
 *
 * 安全：共享模式（status.manageable=false）下按钮全禁用；执行一律走确认对话框；
 * warn 级命令要在对话框里额外勾选；block 级命令没有运行按钮（后端也会拒）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommandKind,
  CommandPlan,
  CommandRisk,
  CommandRun,
  ProjectCommand,
  ServiceStatus,
} from '../../shared/types';
import { agentApi } from './agentApi';
import { api } from './api';
import { Dialog } from './Dialog';
import './service.css';

const KIND_LABEL: Record<CommandKind, string> = {
  build: '编译',
  start: '启动',
  stop: '停止',
  test: '测试',
  other: '其他',
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
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
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

const STATUS_LABEL: Record<CommandRun['status'], string> = {
  running: '运行中',
  done: '成功',
  failed: '失败',
  stopped: '已停止',
  lost: '已失联',
};

export function CommandPanel({
  projectId,
  onOpenSession,
}: {
  projectId: string | null;
  /** 去 Agent 面板看这次分析的会话（分析过程留在那儿）。 */
  onOpenSession?: (sessionId: string) => void;
}) {
  // ------------------------------------------------------------ 阅读器服务
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [svError, setSvError] = useState<string | null>(null);
  const [svBusy, setSvBusy] = useState(false);
  const [svConfirm, setSvConfirm] = useState<'restart' | 'stop' | null>(null);
  const [svNote, setSvNote] = useState<string | null>(null);

  const loadStatus = async () => {
    try {
      setStatus(await api.serviceStatus());
      setSvError(null);
    } catch (e) {
      setSvError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => {
      setStatus((s) => (s ? { ...s, uptimeMs: Date.now() - s.startedAt } : s));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const runService = async (kind: 'restart' | 'stop') => {
    setSvConfirm(null);
    setSvBusy(true);
    setSvNote(null);
    try {
      const res = kind === 'restart' ? await api.serviceRestart() : await api.serviceStop();
      setSvNote(res.note ?? '已执行');
    } catch (e) {
      setSvError(e instanceof Error ? e.message : String(e));
    } finally {
      setSvBusy(false);
    }
  };

  const manageable = status?.manageable ?? false;

  // ------------------------------------------------------------ 项目命令
  const [plan, setPlan] = useState<CommandPlan | null>(null);
  const [prompt, setPrompt] = useState('获取本项目的命令');
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
    if (!projectId) return;
    void api
      .projectCommands(projectId)
      .then(({ plan: saved }) => setPlan(saved))
      .catch((e: unknown) => setCmdError(e instanceof Error ? e.message : String(e)));
    void refreshRuns();
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
        prompt.trim() || '获取本项目的命令',
        controller.signal,
      );
      setPlan(next);
      setCmdNote(`分析完成：${next.commands.length} 条命令`);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        setCmdNote('已停止等待（后端仍可能在分析，稍后点「刷新」即可看到结果）');
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
        label: '自定义命令',
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
      setCmdNote(run.background ? `已在后台启动（pid ${run.pid ?? '?'}）` : `已执行（退出码 ${run.exitCode ?? '?'}）`);
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

  return (
    <div className="service-panel">
      {/* ------------------------------------------------ 项目命令 */}
      <section className="cp-section">
        <div className="cp-head">
          <h3>项目命令</h3>
          {plan && (
            <button className="btn ghost small" onClick={() => void refreshPlan()} disabled={analyzing}>
              刷新
            </button>
          )}
        </div>

        {!projectId ? (
          <div className="sv-hint">先打开一个项目，再来这里拿它的命令。</div>
        ) : (
          <>
            {hasModel === false && (
              <div className="cp-notice">
                还没有配置大模型：点顶栏「模型」填 base URL + API key + 模型 id，回来就能分析。
              </div>
            )}

            <div className="cp-input-row">
              <input
                className="cp-input"
                value={prompt}
                placeholder="获取本项目的命令"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void analyze();
                }}
                disabled={analyzing}
              />
              {analyzing ? (
                <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
                  停止等待
                </button>
              ) : (
                <button
                  className="btn"
                  onClick={() => void analyze()}
                  disabled={hasModel === false}
                  title={hasModel === false ? '先在顶栏「模型」里配置' : '让 code agent 读本项目'}
                >
                  {plan ? '重新分析' : '分析'}
                </button>
              )}
            </div>

            {analyzing && (
              <div className="cp-notice">
                正在读项目（package.json / Makefile / CI / README…），最多 3 分钟。分析过程可以在 Agent 面板看到。
              </div>
            )}
            {plan?.summary && (
              <div className="cp-summary">
                {plan.summary}
                <span className="cp-meta"> · {fmtTime(plan.createdAt)}</span>
                {plan.sessionId && onOpenSession && (
                  <button className="cp-link" onClick={() => onOpenSession(plan.sessionId as string)}>
                    看分析过程
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
                        <span className={`cmd-kind k-${cmd.kind}`}>{KIND_LABEL[cmd.kind]}</span>
                        <span className="cmd-label" title={cmd.label}>
                          {cmd.label}
                        </span>
                        {cmd.source === 'generated' && <span className="cmd-tag">建议</span>}
                        <button
                          className="cp-copy"
                          title="复制命令"
                          onClick={() => void navigator.clipboard?.writeText(cmd.command).catch(() => undefined)}
                        >
                          复制
                        </button>
                      </div>
                      <code className="cmd-text">{cmd.command}</code>
                      {cmd.note && <div className="cmd-note">{cmd.note}</div>}
                      {cmd.risk === 'warn' && <div className="cmd-risk">⚠ 危险命令：执行前请确认</div>}
                      {blocked && <div className="cmd-risk">⛔ 自毁级命令，已禁止执行</div>}
                      <div className="cmd-actions">
                        <button
                          className="btn small"
                          disabled={blocked || !manageable}
                          onClick={() => askRun({ ...cmd, background: false })}
                        >
                          运行
                        </button>
                        <button
                          className="btn ghost small"
                          disabled={blocked || !manageable}
                          onClick={() => askRun({ ...cmd, background: true })}
                        >
                          后台运行
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
                placeholder="自定义命令（在项目根执行）"
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
                运行
              </button>
            </div>

            {hasRunning && (
              <div className="cp-runs">
                <h4>后台任务</h4>
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

      {/* ------------------------------------------------ 阅读器服务 */}
      <section className="cp-section">
        <div className="sv-head">
          <h3>命令 · 服务</h3>
          <button className="btn ghost small" onClick={() => void loadStatus()} disabled={svBusy}>
            刷新状态
          </button>
        </div>

        {svError && (
          <div className="sv-error" role="alert">
            {svError}
          </div>
        )}

        {status && (
          <dl className="sv-facts">
            <div>
              <dt>状态</dt>
              <dd>运行中</dd>
            </div>
            <div>
              <dt>进程</dt>
              <dd>pid {status.pid}</dd>
            </div>
            <div>
              <dt>监听</dt>
              <dd>
                {status.host}:{status.port}
              </dd>
            </div>
            <div>
              <dt>运行时长</dt>
              <dd>{fmtDuration(status.uptimeMs)}</dd>
            </div>
            <div>
              <dt>日志</dt>
              <dd className="sv-path" title={status.logPath}>
                {status.logPath}
              </dd>
            </div>
            {status.lastAction && (
              <div>
                <dt>上次动作</dt>
                <dd>
                  {status.lastAction.action} · {new Date(status.lastAction.at).toLocaleTimeString()}
                </dd>
              </div>
            )}
          </dl>
        )}

        {!manageable && status && <div className="sv-note">共享模式下不提供命令管理（只读阅读），按钮已禁用。</div>}

        <div className="sv-actions">
          <button className="btn" disabled={!manageable || svBusy} onClick={() => setSvConfirm('restart')}>
            重启服务
          </button>
          <button className="btn ghost" disabled={!manageable || svBusy} onClick={() => setSvConfirm('stop')}>
            停止服务
          </button>
        </div>

        {svNote && <div className="sv-note">{svNote}</div>}

        <div className="sv-hint">
          重启会先停掉当前进程、再用同一条命令拉起来（日志追加到上面的文件）。 停止后界面就没法再启动它了 ——
          回到命令行跑 <code>npm start</code>。
        </div>
      </section>

      {svConfirm && (
        <Dialog title={svConfirm === 'restart' ? '重启服务？' : '停止服务？'} onClose={() => setSvConfirm(null)}>
          <p className="confirm-text">
            {svConfirm === 'restart'
              ? '当前进程会退出，随后由独立 worker 拉起新进程（约 2~5 秒）。这段时间页面上的请求会失败，稍后刷新即可。'
              : '服务会立即退出，之后这个页面就打不开了。要重新启动，请在命令行运行 npm start。'}
          </p>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setSvConfirm(null)}>
              取消
            </button>
            <button className="btn" onClick={() => void runService(svConfirm)}>
              {svConfirm === 'restart' ? '重启' : '停止'}
            </button>
          </div>
        </Dialog>
      )}

      {pending && (
        <Dialog title={pending.label} onClose={() => setPending(null)}>
          <div className="cmd-confirm">
            <code className="cmd-text">{pending.command}</code>
            <p className="confirm-text">
              {pending.background ? '后台运行' : '执行'}：在项目根目录运行这条命令
              {pending.background ? '，进程由后端托管，可随时停止。' : '，跑完把输出显示在这里。'}
            </p>
            {pending.reason && <p className="cmd-note">说明：{pending.reason}</p>}
            {pending.risk === 'block' && (
              <div className="cmd-risk">⛔ 这条命令属于自毁级操作，后端会直接拒绝执行。</div>
            )}
            {pending.risk === 'warn' && (
              <label className="cmd-ack">
                <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
                我知道这条命令有风险（{pending.reason ?? '可能的破坏性操作'}）
              </label>
            )}
          </div>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setPending(null)}>
              取消
            </button>
            <button
              className="btn"
              disabled={pending.risk === 'block' || (pending.risk === 'warn' && !acked)}
              onClick={() => void confirmRun()}
            >
              {pending.background ? '后台运行' : '运行'}
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
  return (
    <div className={`cmd-run${compact ? ' compact' : ''}`}>
      <div className="cmd-run-head">
        <span className={`cmd-dot s-${run.status}`} />
        <span className="cmd-run-status">{STATUS_LABEL[run.status]}</span>
        <span className="cp-meta">
          {run.pid ? `pid ${run.pid} · ` : ''}
          {fmtElapsed(run)}
          {run.exitCode !== undefined && run.exitCode !== null ? ` · 退出码 ${run.exitCode}` : ''}
        </span>
        {run.status === 'running' && (
          <button className="btn ghost small" onClick={onStop}>
            停止
          </button>
        )}
        <button className="cp-link" onClick={onToggle}>
          {expanded ? '收起输出' : '看输出'}
        </button>
      </div>
      {expanded && <pre className="cmd-output">{run.output?.trim() ? run.output : '（还没有输出）'}</pre>}
    </div>
  );
}
