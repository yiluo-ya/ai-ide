/**
 * 底部「终端」面板（2026-10-08，真正的交互式终端）。
 *
 * 后端起常驻 PTY（node-pty + conpty，见 backend/src/api/terminal.ts），这里用 @xterm/xterm
 * 渲染，WebSocket 双向透传。能力对齐 VS Code 终端：
 * - 多标签（每个标签一条独立会话）；
 * - 标签内向下分屏（多个 pane 垂直堆叠，分隔线可拖动，各自独立会话）；
 * - xterm 自适应容器大小 + 窗口 resize 同步给后端 PTY；
 * - cwd 跟随当前项目（后端解析，cwd = 项目根）。
 *
 * 协议（与 backend/src/api/terminal.ts 一致）：
 *   客户端→服务端：{type:'spawn',cols,rows} 首帧起 shell；{type:'input',data}；{type:'resize',cols,rows}。
 *   服务端→客户端：{type:'output',data}；{type:'exit',exitCode}；{type:'error',message}。
 *
 * 生命周期纪律：xterm 实例一旦 open 就不随 React 卸载而 dispose —— 所有标签 / 分屏的 DOM 常驻，
 * 非激活的仅用 `display:none` 隐藏（否则切换标签会在 StrictMode 双挂载下反复 open/dispose 报错）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { useI18n } from './i18n';

/** 一个终端 pane：独立会话 + 独立 xterm 实例。 */
interface Pane {
  id: string;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  /** 后端回传的 shell 名（如 cmd / bash / pwsh），用于标签标题。 */
  shell: string;
  exited: boolean;
  failed: boolean;
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
function makePane(): Pane {
  const { term, fit } = createTerminal();
  return { id: newPaneId(), term, fit, ws: null, shell: '', exited: false, failed: false };
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

function SplitIcon() {
  return <Icon d="M3 3h4v10H3zM9 3h4v10H9z" />;
}

function TrashIcon() {
  return <Icon d="M4 4h8M6 4V2h4v2M5 4l.5 9h5l.5-9M6.5 6v4M9.5 6v4" />;
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

/** 单个 pane 的宿主 + xterm。挂载时 open 一次，此后常驻。 */
function PaneHost({ pane, projectId }: { pane: Pane; projectId: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const { t } = useI18n();

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !projectId) return;

    // open 只做一次（切换标签 / StrictMode 双挂载都不重复 open）
    if (!openedRef.current) {
      openedRef.current = true;
      pane.term.open(host);
    }
    pane.fit.fit();

    const ws = new WebSocket(wsUrl(projectId, pane.id));
    pane.ws = ws;

    const observer = new ResizeObserver(() => {
      if (pane.ws?.readyState !== WebSocket.OPEN) return;
      pane.fit.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: pane.term.cols, rows: pane.term.rows }));
    });
    observer.observe(host);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'spawn', cols: pane.term.cols, rows: pane.term.rows }));
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
  }, [pane, projectId, t]);

  return <div className="terminal-pane-host" ref={hostRef} />;
}

/** 一个标签页的 panes 容器，承载向下分屏。 */
function TabPanels({
  tab,
  projectId,
  style,
}: {
  tab: Tab;
  projectId: string | null;
  style: React.CSSProperties;
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
          <PaneHost pane={pane} projectId={projectId} />
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

/** 底部终端面板：多标签 + 分屏 + 工具栏。所有标签常驻 DOM，非激活的隐藏。 */
export function TerminalPanel({ projectId }: { projectId: string | null }) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const addTab = useCallback(() => {
    const tab: Tab = { id: newTabId(), panes: [makePane()] };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

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

  const splitDown = useCallback(() => {
    setTabs((prev) =>
      prev.map((tb) => {
        if (tb.id !== activeTabId) return tb;
        return { ...tb, panes: [...tb.panes, makePane()] };
      }),
    );
  }, [activeTabId]);

  const killActivePane = useCallback(() => {
    setTabs((prev) =>
      prev.map((tb) => {
        if (tb.id !== activeTabId) return tb;
        // 对最后一个 pane 发 SIGTERM，其余 pane 保留（终端 kill 通常是针对焦点终端）
        const pane = tb.panes[tb.panes.length - 1];
        if (pane?.ws && pane.ws.readyState === WebSocket.OPEN) {
          pane.ws.send(JSON.stringify({ type: 'signal', data: 'SIGTERM' }));
        }
        return tb;
      }),
    );
  }, [activeTabId]);

  // 首次进入（有项目）自动开一个标签
  useEffect(() => {
    if (projectId && tabs.length === 0) addTab();
  }, [projectId, tabs.length, addTab]);

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
          <button className="terminal-action" onClick={addTab} title={t('app.terminalNew')} aria-label={t('app.terminalNew')}>
            <PlusIcon />
          </button>
          <button className="terminal-action" onClick={splitDown} title={t('app.terminalSplit')} aria-label={t('app.terminalSplit')}>
            <SplitIcon />
          </button>
          <button className="terminal-action" onClick={killActivePane} title={t('app.terminalKill')} aria-label={t('app.terminalKill')}>
            <TrashIcon />
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
          />
        ))}
        {tabs.length === 0 && <div className="panel-empty">{t('app.terminalPlaceholder')}</div>}
      </div>
    </div>
  );
}