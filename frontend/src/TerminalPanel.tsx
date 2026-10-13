/**
 * 底部「终端」面板（2026-10-08，真正的交互式终端）。
 *
 * 后端起常驻 PTY（node-pty + conpty，见 backend/src/api/terminal.ts），这里用 @xterm/xterm
 * 渲染，WebSocket 双向透传。能力对齐 VS Code 终端：
 * - 多标签（每个标签一条独立会话）；
 * - xterm 自适应容器大小 + 窗口 resize 同步给后端 PTY；
 * - cwd 跟随当前项目（后端解析，cwd = 项目根）。
 *
 * 协议（与 backend/src/api/terminal.ts 一致）：
 *   客户端→服务端：{type:'spawn',cols,rows,shell} 首帧起 shell；{type:'input',data}；{type:'resize',cols,rows}。
 *   服务端→客户端：{type:'output',data}；{type:'exit',exitCode}；{type:'error',message}。
 *
 * 生命周期纪律：xterm 实例一旦 open 就不随 React 卸载而 dispose —— 所有标签的 DOM 常驻，
 * 非激活的仅用 `display:none` 隐藏（否则切换标签会在 StrictMode 双挂载下反复 open/dispose 报错）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { useI18n } from './i18n';
import { buildRunCommand } from './runCommand';

/** 可选的 shell 种类（与 backend/src/api/terminal.ts 的 ShellKind 一致）。 */
type ShellKind = 'powershell' | 'gitbash';

/** 一个终端 pane：独立会话 + 独立 xterm 实例。 */
interface Pane {
  id: string;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  /** 后端回传的 shell 名（如 PowerShell / Git Bash），用于标签标题。 */
  shell: string;
  /** 本 pane 用哪种 shell 起的（默认 PowerShell）。 */
  shellKind: ShellKind;
  exited: boolean;
  failed: boolean;
  /** 后端回传过 title（shell 已 spawn 完成）；此前写入会被后端丢弃，见 pending。 */
  ready: boolean;
  /** FR-0011：待写入的运行命令（shell 就绪前挂起，收到 title 后补发）。 */
  pending?: string;
}

/** 一个标签页：含 1..n 个垂直堆叠的 pane。 */
interface Tab {
  id: string;
  panes: Pane[];
}

let paneSeq = 0;

function newPaneId(): string {
  return `pane-${Date.now()}-${paneSeq++}`;
}

let tabSeq = 0;

function newTabId(): string {
  return `tab-${Date.now()}-${tabSeq++}`;
}

/** 构造 WebSocket 地址（复用当前页面的 host / 协议）。 */
function wsUrl(projectId: string, sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/projects/${encodeURIComponent(projectId)}/terminal?session=${encodeURIComponent(sessionId)}`;
}

/** 基于 CSS 变量取主题色，xterm 配色跟随 IDE 主题。 */
function themeColors(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--bg').trim() || '#1e1e1e';
  const fg = css.getPropertyValue('--fg').trim() || '#cccccc';
  const accent = css.getPropertyValue('--accent').trim() || '#4fc1ff';
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    selectionBackground: 'rgba(90,120,180,0.4)',
  };
}

/** 建一个 xterm + fit 实例。 */
function createTerminal(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: themeColors(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

/** 建一个 pane（空会话，等 WS 连上再 spawn）。 */
function makePane(shellKind: ShellKind): Pane {
  const { term, fit } = createTerminal();
  return { id: newPaneId(), term, fit, ws: null, shell: '', shellKind, exited: false, failed: false, ready: false };
}

/** 操作图标（VS Code codicon 风格，16px 描边）。 */
function Icon({ d, children }: { d: string; children?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
      {children}
    </svg>
  );
}

function PlusIcon() {
  return <Icon d="M8 3v10M3 8h10" />;
}

/** 终止一个 pane：断 WS + dispose term。 */
function destroyPane(pane: Pane): void {
  try {
    pane.ws?.close();
  } catch {
    /* 已关闭 */
  }
  pane.ws = null;
  try {
    pane.term.dispose();
  } catch {
    /* 忽略：可能已 dispose */
  }
}

/**
 * FR-0011：把一行命令写进 pane 的 shell（末尾补 \r 触发执行，对应 VS Code sendText 的
 * shouldExecute=true）。shell 还没 spawn 完（pane.ready=false）就挂起 —— 后端在 spawn 之前
 * 会丢弃 input（backend/src/api/terminal.ts 的 `if (!session.pty) return`）。
 */
function sendToPane(pane: Pane, command: string): void {
  if (pane.exited || pane.failed) return;
  if (pane.ready && pane.ws?.readyState === WebSocket.OPEN) {
    pane.ws.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
    pane.term.focus();
  } else {
    pane.pending = command;
  }
}

/** shell 就绪（收到 title）后补发挂起的命令。 */
function flushPending(ws: WebSocket, pane: Pane): void {
  const command = pane.pending;
  if (!command) return;
  pane.pending = undefined;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
    pane.term.focus();
  }
}

/** 单个 pane 的宿主 + xterm。挂载时 open 一次，此后常驻。 */
function PaneHost({
  pane,
  projectId,
  onTitle,
}: {
  pane: Pane;
  projectId: string | null;
  /** 后端回传 shell 名时调一次（pane.shell 是可变字段，靠它触发重渲染刷新标签标题）。 */
  onTitle: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  /**
   * 会话绑定在「挂载时的项目」上：之后切换项目**不重连** —— 终端常驻，
   * 里面跑着的进程不被杀（新标签才用当前项目做 cwd）。
   */
  const boundProjectRef = useRef(projectId);
  const { t } = useI18n();

  useEffect(() => {
    const host = hostRef.current;
    const boundProject = boundProjectRef.current;
    if (!host || !boundProject) return;

    // open 只做一次（切换标签 / StrictMode 双挂载都不重复 open）
    if (!openedRef.current) {
      openedRef.current = true;
      pane.term.open(host);
    }
    // 面板收起 / 切到「输出」时容器尺寸为 0：跳过 fit（保持 xterm 默认维度），
    // 等重新可见时 ResizeObserver 再算 —— 免得把 0×0 当尺寸同步给后端 PTY。
    if (host.clientWidth > 0 && host.clientHeight > 0) pane.fit.fit();

    const ws = new WebSocket(wsUrl(boundProject, pane.id));
    pane.ws = ws;

    const resizeNow = () => {
      if (pane.ws?.readyState !== WebSocket.OPEN) return;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      pane.fit.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: pane.term.cols, rows: pane.term.rows }));
    };
    const observer = new ResizeObserver(resizeNow);
    observer.observe(host);

    ws.onopen = () => {
      // 重连（切 shell / 换 i18n 重建 ws）后 shell 要重新 spawn：先清就绪标记
      pane.ready = false;
      ws.send(JSON.stringify({ type: 'spawn', cols: pane.term.cols, rows: pane.term.rows, shell: pane.shellKind }));
    };
    ws.onmessage = (ev) => {
      let msg: { type: string; data?: string; title?: string; exitCode?: number; message?: string };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === 'title') {
        pane.shell = msg.title ?? '';
        pane.ready = true;
        onTitle();
        // FR-0011：运行请求挂在 shell 就绪之前 —— 到这一步才能安全写入
        flushPending(ws, pane);
      } else if (msg.type === 'output' && msg.data != null) {
        pane.term.write(msg.data);
      } else if (msg.type === 'exit') {
        pane.exited = true;
        pane.term.write(`\r\n\x1b[90m[${t('app.terminalExit', { code: msg.exitCode ?? 0 })}]\x1b[0m\r\n`);
      } else if (msg.type === 'error') {
        pane.failed = true;
        pane.term.write(`\r\n\x1b[31m[${msg.message ?? t('app.terminalDisconnected')}]\x1b[0m\r\n`);
      }
    };
    ws.onclose = () => {
      pane.ws = null;
      if (!pane.exited && !pane.failed) {
        pane.term.write(`\r\n\x1b[90m[${t('app.terminalDisconnected')}]\x1b[0m\r\n`);
      }
    };

    const inputDisposable = pane.term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    return () => {
      inputDisposable.dispose();
      observer.disconnect();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      // 不 dispose term：term 归于 pane 对象生命周期，由 destroyPane 统一回收。
    };
  }, [pane, t, onTitle]);

  return <div className="terminal-pane-host" ref={hostRef} />;
}

/** 一个标签页的 pane 容器（保留多 pane 堆叠结构，分隔线可拖动）。 */
function TabPanels({
  tab,
  projectId,
  style,
  onTitle,
}: {
  tab: Tab;
  projectId: string | null;
  style: React.CSSProperties;
  onTitle: () => void;
}) {
  const [ratios, setRatios] = useState<number[]>(() => tab.panes.map(() => 1));
  const containerRef = useRef<HTMLDivElement>(null);

  // 分屏分隔线拖动：重设相邻两个 pane 的 flex 权重。
  const onDragSplit = useCallback((idx: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const aboveRatio = Math.max(0.1, Math.min(0.9, (clientY - rect.top) / rect.height));
    setRatios((prev) => {
      const next = [...prev];
      const a = prev[idx] ?? 1;
      const b = prev[idx + 1] ?? 1;
      const sum = a + b;
      next[idx] = sum * aboveRatio;
      if (idx + 1 < next.length) next[idx + 1] = sum * (1 - aboveRatio);
      return next;
    });
  }, []);

  return (
    <div className="terminal-tab-panes" ref={containerRef} style={style}>
      {tab.panes.map((pane, idx) => (
        <div
          key={pane.id}
          className="terminal-pane"
          style={{ flexGrow: ratios[idx], flexBasis: 0, flexShrink: 1 }}
        >
          <PaneHost pane={pane} projectId={projectId} onTitle={onTitle} />
          {idx < tab.panes.length - 1 && (
            <div
              className="terminal-split-handle"
              role="separator"
              aria-orientation="horizontal"
              onMouseDown={(e) => {
                e.preventDefault();
                const move = (ev: MouseEvent) => onDragSplit(idx, ev.clientY);
                const up = () => {
                  window.removeEventListener('mousemove', move);
                  window.removeEventListener('mouseup', up);
                };
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', up);
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** FR-0011：一次「在终端中运行」请求（token 自增；展开面板由 App 负责）。 */
export interface RunRequest {
  /** 每次运行自增：token 变了才算一次新请求（effect 重跑不会重复执行）。 */
  token: number;
  /** 目标文件（项目相对路径，正斜杠）。 */
  file: string;
  /** Python 解释器绝对路径（prefs 指定或后端探测）；空 = PATH 上的 python。 */
  pythonPath?: string | null;
}

/** 底部终端面板：多标签 + 工具栏。所有标签常驻 DOM，非激活的隐藏。 */
export function TerminalPanel({ projectId, runRequest }: { projectId: string | null; runRequest?: RunRequest | null }) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // 新建标签默认用哪种 shell（切换选择器时同步更新）
  const [defaultShell, setDefaultShell] = useState<ShellKind>('powershell');
  /** 重渲染信号：pane.shell 是可变字段，后端回传 shell 名后靠它刷新标签标题。 */
  const [, setShellSeq] = useState(0);
  const bumpShell = useCallback(() => setShellSeq((n) => n + 1), []);

  const addTab = useCallback(() => {
    const tab: Tab = { id: newTabId(), panes: [makePane(defaultShell)] };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, [defaultShell]);

  /**
   * 切换 shell：记住选择（之后新建的标签沿用），并**重开**当前标签的会话。
   * 旧会话会被终止 —— 终端本来就是这么切的（不存在把一个 shell 的会话换成另一个 shell）。
   * 销毁 / 新建都放在事件处理器里，不放进 setState 的 updater（那儿属渲染阶段，会被重复执行）。
   */
  const switchShell = useCallback(
    (kind: ShellKind) => {
      setDefaultShell(kind);
      const active = tabs.find((tb) => tb.id === activeTabId);
      if (!active || active.panes[0]?.shellKind === kind) return;
      for (const p of active.panes) destroyPane(p);
      const panes = active.panes.map(() => makePane(kind));
      setTabs((prev) => prev.map((tb) => (tb.id === activeTabId ? { ...tb, panes } : tb)));
    },
    [tabs, activeTabId],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((tb) => tb.id === tabId);
        const closing = prev[idx];
        if (closing) for (const p of closing.panes) destroyPane(p);
        const next = prev.filter((tb) => tb.id !== tabId);
        if (activeTabId === tabId) {
          setActiveTabId(next.length > 0 ? next[Math.min(idx, next.length - 1)].id : null);
        }
        return next;
      });
    },
    [activeTabId],
  );

  /**
   * FR-0011「在终端中运行」：runRequest.token 变化 = 一次新请求。
   * - 已有激活标签 → 写进它的第一个 pane；
   * - 一个标签都没有 → 交给下面的 auto-open effect（把命令挂到新 pane 上等 shell 就绪）。
   * consumedTokenRef 去重：effect 因别的依赖重跑时不会重复执行同一条命令。
   */
  const consumedTokenRef = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabRef = useRef(activeTabId);
  activeTabRef.current = activeTabId;

  // 当前项目被移除（projectId → null）：面板没有可连的宿，把会话收干净
  // （否则 term 还挂在已卸载的 host 上，重新选项目时会重复 open）。
  useEffect(() => {
    if (projectId) return;
    for (const tb of tabsRef.current) for (const p of tb.panes) destroyPane(p);
    setTabs([]);
    setActiveTabId(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !runRequest || runRequest.token <= consumedTokenRef.current) return;
    const tab = tabsRef.current.find((tb) => tb.id === activeTabRef.current) ?? tabsRef.current[0];
    const pane = tab?.panes[0];
    if (!pane) return; // 没有标签：交给下面的 auto-open effect
    const command = buildRunCommand({
      file: runRequest.file,
      shellKind: pane.shellKind,
      pythonPath: runRequest.pythonPath,
    });
    if (!command) return; // 未识别语言（界面本已置灰，这里兜底）
    consumedTokenRef.current = runRequest.token;
    sendToPane(pane, command);
  }, [runRequest, projectId]);

  // 首次进入（有项目）自动开一个标签；若此刻带着运行请求，命令挂到新 pane 上等 shell 就绪
  useEffect(() => {
    if (!projectId || tabs.length > 0) return;
    const pane = makePane(defaultShell);
    if (runRequest && runRequest.token > consumedTokenRef.current) {
      const command = buildRunCommand({
        file: runRequest.file,
        shellKind: pane.shellKind,
        pythonPath: runRequest.pythonPath,
      });
      if (command) {
        pane.pending = command;
        consumedTokenRef.current = runRequest.token;
      }
    }
    const tab: Tab = { id: newTabId(), panes: [pane] };
    setTabs([tab]);
    setActiveTabId(tab.id);
  }, [projectId, tabs.length, runRequest, defaultShell]);

  if (!projectId) {
    return <div className="panel-empty">{t('app.noProject')}</div>;
  }

  return (
    <div className="terminal-container">
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist">
          {tabs.map((tb) => {
            const pane = tb.panes[0];
            const idx = tabs.indexOf(tb) + 1;
            const title = pane?.shell ? `${idx}: ${pane.shell}` : `${idx}: ${t('app.terminalConnecting')}`;
            const running = pane ? !pane.exited && !pane.failed : false;
            return (
              <button
                key={tb.id}
                type="button"
                role="tab"
                className={`terminal-tab${tb.id === activeTabId ? ' active' : ''}`}
                onClick={() => setActiveTabId(tb.id)}
                title={title}
              >
                <span className={`terminal-status-dot${running ? ' running' : ''}`} />
                <span className="terminal-tab-name">{title}</span>
                <span
                  className="terminal-tab-close"
                  title={t('app.terminalClose')}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tb.id);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
        </div>
        <div className="terminal-actions">
          <select
            className="terminal-shell-select"
            value={tabs.find((tb) => tb.id === activeTabId)?.panes[0]?.shellKind ?? defaultShell}
            onChange={(e) => switchShell(e.target.value as ShellKind)}
            title={t('app.terminalShell')}
            aria-label={t('app.terminalShell')}
          >
            <option value="powershell">PowerShell</option>
            <option value="gitbash">Git Bash</option>
          </select>
          <button className="terminal-action" onClick={addTab} title={t('app.terminalNew')} aria-label={t('app.terminalNew')}>
            <PlusIcon />
          </button>
        </div>
      </div>
      <div className="terminal-body">
        {tabs.map((tb) => (
          <TabPanels
            key={tb.id}
            tab={tb}
            projectId={projectId}
            style={{ display: tb.id === activeTabId ? 'flex' : 'none' }}
            onTitle={bumpShell}
          />
        ))}
        {tabs.length === 0 && <div className="panel-empty">{t('app.terminalPlaceholder')}</div>}
      </div>
    </div>
  );
}