/**
 * 05 信使 Share 的入口：把「位置 / 片段 / 理解 / 整份交付物」带得走，也把阅读器接给宿主与 agent。
 *
 * 一个下拉收口，不再往顶栏继续堆按钮：带得走（链接 / 片段）→ 导出（报告 / 截图 / 打印）
 * → 批注 → 分享给同事（同机同目录）→ 给 agent 用（HTTP 工具）。
 */
import { useEffect, useRef, useState } from 'react';
import type { HighlightResult } from './api';
import { api } from './api';
import { annotationsMarkdown } from './annotations';
import { mapApi } from './mapApi';
import {
  copyText,
  downloadText,
  fileReportMarkdown,
  overviewReportMarkdown,
  reportFilename,
  searchReportMarkdown,
  type HighlightItem,
} from './report';
import { formatLineRange, formatSnippet } from './share';
import { copyCanvasPng, exportCanvasPng, renderCodeSnapshot, type SnapshotHit } from './snapshot';
import { showFlash, useStore } from './state';
import './share.css';
import './print.css';

interface Props {
  cursor: { line: number; col: number };
  /** 搜索面板里的查询串（导出搜索报告要写进标题）。 */
  searchQuery: string;
  onOpenAnnotations: () => void;
}

interface ShareInfo {
  host: string;
  shareHint: string | null;
  shareNote?: string;
}

/** 后端 4 元组 → 可读的着色命中（length 是 UTF-16 长度，endCol = col + length）。 */
function expandHighlights(res: HighlightResult, content: string): HighlightItem[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const out: HighlightItem[] = [];
  for (let i = 0; i + 3 < res.data.length; i += 4) {
    const line = res.data[i];
    const col = res.data[i + 1];
    const length = res.data[i + 2];
    const tier = (res.kinds[res.data[i + 3]] ?? 'project') as HighlightItem['tier'];
    const text = (lines[line - 1] ?? '').slice(col - 1, col - 1 + length);
    out.push({ line, startCol: col, endCol: col + length, tier, text });
  }
  return out;
}

/** 当前编辑器的可见行范围（拿不到就退回文件开头）。 */
function visibleRange(): { startLine: number; endLine: number } | null {
  const api = (
    window as unknown as {
      __wcrMonaco?: {
        editor?: {
          getEditors?: () => Array<{
            getVisibleRanges?: () => Array<{ startLineNumber: number; endLineNumber: number }>;
          }>;
        };
      };
    }
  ).__wcrMonaco;
  const range = api?.editor?.getEditors?.()[0]?.getVisibleRanges?.()[0];
  return range ? { startLine: range.startLineNumber, endLine: range.endLineNumber } : null;
}

export function ShareMenu({ cursor, searchQuery, onOpenAnnotations }: Props) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const projectId = store.projectId;
  const file = store.openFile;

  /** 关掉下拉：Esc 触发时把焦点还给触发按钮，键盘用户不会「焦点掉进虚空」。 */
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  // 下拉不是模态框，但键盘用户按 Esc 应该能收起来 —— 与 Dialog 的 Esc 行为保持一致。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    window.addEventListener('keydown', onKey, true);
    menuRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  // 打开菜单时探一次分享信息：可访问地址由后端根据 HOST 决定（默认只监听本机）
  useEffect(() => {
    if (!open || share) return;
    void fetch('/api/health')
      .then((r) => r.json() as Promise<ShareInfo>)
      .then((info) => setShare(info))
      .catch(() => setShare(null));
  }, [open, share]);

  const say = (text: string) => {
    setNote(text);
    showFlash(text);
  };

  /** 深链：S1 的加强版 —— 带上行与列，回来还停在那一行。 */
  const deepLink = (line?: number, col?: number) => {
    const params = new URLSearchParams();
    if (projectId) params.set('project', projectId);
    if (file) {
      params.set('file', file);
      if (line) params.set('line', String(line));
      if (col) params.set('col', String(col));
    }
    return `${window.location.origin}/?${params.toString()}`;
  };

  const copyDeepLink = async () => {
    const link = deepLink(cursor.line, cursor.col);
    say((await copyText(link)) ? `已复制链接（含第 ${cursor.line} 行）` : '复制失败：浏览器拒绝了剪贴板');
  };

  /** S3a 的取选区分支：菜单里也能复制选中段（右键菜单之外的第二个入口）。 */
  const copySelection = async () => {
    const monacoApi = (
      window as unknown as {
        __wcrMonaco?: {
          editor?: {
            getEditors?: () => Array<{
              getSelection?: () => {
                isEmpty?: () => boolean;
                startLineNumber: number;
                endLineNumber: number;
              } | null;
              getModel?: () => { getValueInRange?: (r: unknown) => string } | null;
            }>;
          };
        };
      }
    ).__wcrMonaco;
    const editor = monacoApi?.editor?.getEditors?.()[0];
    const sel = editor?.getSelection?.();
    const model = editor?.getModel?.();
    if (!file || !sel || !model?.getValueInRange || sel.isEmpty?.()) {
      say('当前没有选中的代码');
      return;
    }
    const text = model.getValueInRange(sel);
    const snippet = formatSnippet({
      file,
      lang: store.fileLang,
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
      text,
    });
    say((await copyText(snippet)) ? `已复制片段 ${formatLineRange(file, sel.startLineNumber, sel.endLineNumber)}` : '复制失败：浏览器拒绝了剪贴板');
  };

  const loadHighlights = async (): Promise<HighlightItem[]> => {
    if (!projectId || !file) return [];
    try {
      return expandHighlights(await api.highlights(projectId, file), store.fileContent);
    } catch {
      return []; // 着色拿不到就不写着色节，不编造
    }
  };

  /** S4b-1：当前文件报告（含大纲 / 带行号正文 / 着色结论 / 批注）。 */
  const exportFileReport = async () => {
    if (!projectId || !file) return;
    setBusy(true);
    const highlights = await loadHighlights();
    const md = fileReportMarkdown({
      projectName: store.project?.name ?? '项目',
      projectRoot: store.project?.root,
      file,
      lang: store.fileLang,
      content: store.fileContent,
      symbols: store.symbols,
      highlights,
      annotations: useStore
        .getState()
        .annotations.filter((a) => a.file === file)
        .map((a) => ({ file: a.file, line: a.line, col: a.col, text: a.text, reply: a.replies.map((r) => r.text).join(' / ') })),
    });
    downloadText(reportFilename({ project: store.project?.name, kind: 'file', file }), md);
    setBusy(false);
    say('已导出当前文件的 Markdown 报告');
  };

  /** S4b-2：搜索结果报告。 */
  const exportSearchReport = async () => {
    if (!store.searchHits.length) {
      say('搜索面板还没有结果，先搜一次');
      return;
    }
    const md = searchReportMarkdown({
      projectName: store.project?.name ?? '项目',
      query: searchQuery,
      hits: store.searchHits,
    });
    downloadText(reportFilename({ project: store.project?.name, kind: 'search', query: searchQuery }), md);
    say(`已导出搜索报告（${store.searchHits.length} 个文件）`);
  };

  /** S4b-3：项目概览报告（拿不到就现拉一次）。 */
  const exportOverviewReport = async () => {
    if (!projectId) return;
    setBusy(true);
    const data = await mapApi.overview(projectId, { hot: 'files', denoise: true }).catch(() => null);
    const md = overviewReportMarkdown({
      projectName: store.project?.name ?? '项目',
      root: store.project?.root,
      overview: data ?? {},
    });
    downloadText(reportFilename({ project: store.project?.name, kind: 'overview' }), md);
    setBusy(false);
    say(data ? '已导出项目概览报告' : '索引未就绪，已导出可得的部分');
  };

  /** S4a：把可见范围内的代码画成 PNG（自绘 canvas，零依赖）。 */
  const exportScreenshot = async (toClipboard: boolean) => {
    if (!file) return;
    setBusy(true);
    const lines = store.fileContent.replace(/\r\n?/g, '\n').split('\n');
    const range = visibleRange() ?? { startLine: 1, endLine: Math.min(lines.length, 120) };
    const start = Math.max(1, Math.min(range.startLine, lines.length));
    const end = Math.max(start, Math.min(range.endLine, lines.length));
    const text = lines.slice(start - 1, end).join('\n');
    const highlights = (await loadHighlights()).filter((h) => h.line >= start && h.line <= end);
    const hits: SnapshotHit[] = highlights.map((h) => ({
      line: h.line,
      startCol: h.startCol,
      endCol: h.endCol,
      tier: h.tier,
    }));
    const canvas = renderCodeSnapshot({
      text,
      lang: store.fileLang,
      startLine: start,
      highlights: hits,
      title: formatLineRange(file, start, end),
      subtitle: store.project?.name ?? '',
    });
    const name = `code-${(file.split('/').pop() ?? 'snippet').replace(/[^\w.-]+/g, '-')}-${start}-${end}.png`;
    if (toClipboard) {
      const ok = await copyCanvasPng(canvas);
      say(ok ? '截图已复制到剪贴板' : '复制图片被浏览器拒绝，已改为下载');
      if (!ok) await exportCanvasPng(canvas, name);
    } else {
      await exportCanvasPng(canvas, name);
      say(`已导出截图 ${start}-${end} 行`);
    }
    setBusy(false);
  };

  /** S4c：打印友好视图 —— 打印期间挂 body class，打印样式只留代码与页眉。 */
  const printView = () => {
    document.body.classList.add('wcr-printing');
    setTimeout(() => {
      window.print();
      document.body.classList.remove('wcr-printing');
    }, 0);
  };

  const exportAnnotations = () => {
    const list = useStore.getState().annotations;
    downloadText(
      `annotations-${(store.project?.name ?? 'project').replace(/[^\w.-]+/g, '-')}.md`,
      annotationsMarkdown(store.project?.name ?? '项目', list),
    );
    say(list.length ? `已导出 ${list.length} 条批注` : '还没有批注，导出的是空清单');
  };

  const copyAgentTools = async () => {
    const url = `${window.location.origin}/api/agent/tools`;
    say((await copyText(url)) ? '已复制 agent 工具清单地址' : '复制失败：浏览器拒绝了剪贴板');
  };

  return (
    <div className="share-wrap">
      <button
        ref={btnRef}
        className="btn ghost"
        onClick={() => setOpen((v) => !v)}
        title="信使：把位置 / 片段 / 理解 / 交付物带得走"
        aria-expanded={open}
        aria-haspopup="true"
      >
        分享 ▾
      </button>

      {open && (
        <>
          <div className="share-backdrop" onClick={() => close(false)} />
          <div className="share-menu" ref={menuRef} tabIndex={-1}>
            <div className="share-section">带得走</div>
            <button className="share-item" onClick={() => void copyDeepLink()}>
              复制分享链接（含行号）
              <span className="share-hint">同事 / 未来的我打开就落在同一行</span>
            </button>
            <button className="share-item" onClick={() => void copySelection()}>
              复制选中代码（带出处）
              <span className="share-hint">出处行 + 围栏代码块，贴进聊天窗即可讨论</span>
            </button>

            <div className="share-section">导出（脱离阅读器也能读）</div>
            <button className="share-item" disabled={!file || busy} onClick={() => void exportFileReport()}>
              Markdown：当前文件
              <span className="share-hint">大纲 + 带行号正文 + 着色结论 + 批注</span>
            </button>
            <button className="share-item" disabled={!store.searchHits.length || busy} onClick={() => void exportSearchReport()}>
              Markdown：当前搜索结果
              <span className="share-hint">按文件分组，位置是 path:line:col</span>
            </button>
            <button className="share-item" disabled={!projectId || busy} onClick={() => void exportOverviewReport()}>
              Markdown：项目概览
              <span className="share-hint">规模 / 从哪看起 / 热点 / 孤立 / 环 / 最近改动</span>
            </button>
            <button className="share-item" disabled={!file || busy} onClick={() => void exportScreenshot(false)}>
              截图 PNG（当前可见范围）
              <span className="share-hint">保留语法色与着色档位，底部带出处</span>
            </button>
            <button className="share-item" disabled={!file || busy} onClick={() => void exportScreenshot(true)}>
              截图并复制到剪贴板
              <span className="share-hint">贴进 PR / 设计文档最直接</span>
            </button>
            <button className="share-item" onClick={printView}>
              打印 / 存 PDF
              <span className="share-hint">打印视图只留代码与页眉，页眉带 path:line 与项目名</span>
            </button>

            <div className="share-section">批注（只存本机，不写被读目录）</div>
            <button className="share-item" onClick={onOpenAnnotations}>
              打开批注面板
              <span className="share-hint">共 {store.annotations.length} 条</span>
            </button>
            <button className="share-item" onClick={exportAnnotations}>
              导出批注 Markdown
            </button>

            <div className="share-section">分享给同事（同一台机器 / 同一目录）</div>
            <div className="share-note">
              {share?.shareHint ? (
                <>可访问地址：<code>{share.shareHint}</code></>
              ) : (
                <>当前只在 <code>{share?.host ?? '127.0.0.1'}</code> 监听，只能同机打开。要给别人，用 <code>HOST=0.0.0.0</code> 启动，再用 <code>READER_CORS_ORIGIN</code> 收紧来源。</>
              )}
            </div>
            <button className="share-item" onClick={() => void copyText(deepLink(cursor.line, cursor.col)).then((ok) => say(ok ? '已复制链接' : '复制失败'))}>
              复制链接（发给同事）
            </button>

            <div className="share-section">给 agent 用（只读，替代 grep 猜）</div>
            <div className="share-note">
              工具清单：<code>/api/agent/tools</code> —— find_symbol / goto_definition / find_references / file_outline / search_text / read_file / list_projects / index_project。
              解析不出的位置如实返回 <code>unresolved</code>，不编造答案。
            </div>
            <button className="share-item" onClick={() => void copyAgentTools()}>
              复制 agent 工具清单地址
            </button>

            {note && <div className="share-flash">{note}</div>}
          </div>
        </>
      )}

      {/* S4c：只在打印时出现 —— 不带这个页眉，打印出来的纸没人知道是哪份代码 */
      }
      <div className="wcr-print-header">
        <div className="wcr-print-title">{file ?? '（未打开文件）'}</div>
        <div className="wcr-print-meta">
          {store.project?.name ?? ''} · {projectId ? '只读阅读器' : ''} · 行 {cursor.line}
        </div>
      </div>
    </div>
  );
}
