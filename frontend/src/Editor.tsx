/** Monaco 编辑器封装：model 池 + 只读显示 + 定位 + 语义着色 + 行笔记 + 密度条入口。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RevealRequest } from './state';
import { api } from './api';
import { mapApi } from './mapApi';
import { FileDensityBar } from './FileDensityBar';
import { SummaryBar } from './SummaryBar';
import { FileNoteBar, NotePopover, toNoteDecorations } from './NoteLayer';
import { useNotesStore } from './notesState';
import { useGuideStore } from './guideState';
import { anchorOf, resolveNotes } from './notes';
import { shortAuthor } from './blame';
import { translate } from './i18n';
import { loadPrefs, resolvedTheme, usePrefs } from './prefs';
import { reportCaret } from './bridge';
import type { AnnotationThread } from './annotations';
import type { BlameLine } from '../../shared/types';
import './agent-lines.css';
import './annotations.css';
import {
  monaco,
  defineReaderTheme,
  historyModelUriFor,
  monacoLangFor,
  modelUriFor,
  registerCodeProviders,
  registerLinkProviders,
  setProviderContext,
  themeNameFor,
  toSemanticDecorations,
} from './monaco-setup';

registerCodeProviders();
registerLinkProviders();
defineReaderTheme();

const MAX_MODELS = 24;

/**
 * N19（分屏）：model 池提到模块级，多个 Editor 实例共享同一批 ITextModel。
 * Monaco 允许一个 model 被多个 editor 共用，因此分屏不会把内存翻倍，
 * 也不会出现「同一文件两份内容不同步」。
 *
 * key 是 model uri（不是文件路径）：G7.5 的历史版本用 `wcr-history://<rev>/<path>`，
 * 与磁盘上的同一路径是两个 model —— 否则历史正文会盖掉真实文件的内容。
 */
const modelPool = new Map<string, monaco.editor.ITextModel>();
/** model → 当前生效的语义着色装饰 id（全局唯一，避免两个 pane 互相清掉）。 */
const decorationPool = new Map<monaco.editor.ITextModel, string[]>();
/**
 * model → agent 变更行装饰 id（M10.2）。
 * 与语义着色分开两份，是因为两者的刷新时机不同（着色看索引，行标记看宿主上报），
 * 共用一个池会互相清掉。
 */
const agentLinePool = new Map<monaco.editor.ITextModel, string[]>();
/** model → S10 批注装饰 id（与着色 / agent 行分开：三者刷新时机各不相同）。 */
const annotationPool = new Map<monaco.editor.ITextModel, string[]>();
/**
 * model → 向导笔记的行槽装饰 id（W2 / G4.1）。
 * 单独一个池的理由同上：笔记的刷新时机（本机存储 + 当前文件的锚定结果）
 * 与语义着色（看索引）、agent 行（看宿主上报）、批注都不一样。
 */
const notePool = new Map<monaco.editor.ITextModel, string[]>();
/**
 * model → G7.3 blame 行尾作者装饰 id。
 * 单独一个池的理由同上：blame 只由「打开 blame 视图 / 光标移动」驱动，
 * 与着色、agent 行、批注、笔记的刷新时机都不同。
 */
const blamePool = new Map<monaco.editor.ITextModel, string[]>();

/** S10：一条批注 → 整行淡底 + 左侧小点，悬停显示内容与回复。 */
function toAnnotationDecorations(
  model: monaco.editor.ITextModel,
  threads: AnnotationThread[],
): monaco.editor.IModelDeltaDecoration[] {
  const max = model.getLineCount();
  return threads.map((thread) => {
    const line = Math.max(1, Math.min(thread.line, max));
    const replies = thread.replies.map((r) => `↳ ${r.text}`).join('\n');
    return {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: thread.resolved ? 'wcr-note-line resolved' : 'wcr-note-line',
        linesDecorationsClassName: 'wcr-note-gutter',
        hoverMessage: {
          value: `**批注**（只存本机）\n\n${thread.text}${replies ? `\n${replies}` : ''}`,
        },
      },
    };
  });
}

/** S7b：选区转成回发给宿主的最小形状（文本截断，不把整文件塞进消息）。 */
function selectionOf(
  editor: monaco.editor.IStandaloneCodeEditor,
  sel: monaco.Selection,
): { startLine: number; startCol: number; endLine: number; endCol: number; text: string } {
  const model = editor.getModel();
  const text = model ? model.getValueInRange(sel).slice(0, 2000) : '';
  return {
    startLine: sel.startLineNumber,
    startCol: sel.startColumn,
    endLine: sel.endLineNumber,
    endCol: sel.endColumn,
    text,
  };
}

/** 把宿主声明的行范围变成整行背景装饰。 */
function toAgentLineDecorations(
  model: monaco.editor.ITextModel,
  lines: Array<[number, number]>,
): monaco.editor.IModelDeltaDecoration[] {
  const max = model.getLineCount();
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (const [start, end] of lines) {
    const from = Math.max(1, Math.min(start, max));
    const to = Math.max(from, Math.min(end, max));
    out.push({
      range: new monaco.Range(from, 1, to, 1),
      options: {
        isWholeLine: true,
        className: 'wcr-agent-line',
        linesDecorationsClassName: 'wcr-agent-gutter',
        hoverMessage: { value: '本轮 agent 改动（由宿主上报，非推断）' },
      },
    });
  }
  return out;
}

function acquireModel(key: string, uri: monaco.Uri, content: string, lang: string): monaco.editor.ITextModel {
  let model = modelPool.get(key);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(content, monacoLangFor(lang), uri);
    modelPool.set(key, model);
    if (modelPool.size > MAX_MODELS) {
      const oldest = [...modelPool.keys()].find((k) => k !== key);
      const stale = oldest ? modelPool.get(oldest) : undefined;
      if (oldest) modelPool.delete(oldest);
      if (stale) {
        decorationPool.delete(stale);
        agentLinePool.delete(stale);
        annotationPool.delete(stale);
        notePool.delete(stale);
        blamePool.delete(stale);
        stale.dispose();
      }
    }
  } else if (model.getValue() !== content) {
    model.setValue(content);
  }
  const wantLang = monacoLangFor(lang);
  if (model.getLanguageId() !== wantLang) monaco.editor.setModelLanguage(model, wantLang);
  return model;
}

/** G7.3：整文件 blame 视图 —— 每行行尾一个作者短名（只读展示，不参与任何写操作）。 */
function toBlameDecorations(model: monaco.editor.ITextModel, lines: BlameLine[]): monaco.editor.IModelDeltaDecoration[] {
  const max = model.getLineCount();
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (const entry of lines) {
    if (entry.line < 1 || entry.line > max) continue;
    const author = shortAuthor(entry.author);
    out.push({
      range: new monaco.Range(entry.line, 1, entry.line, 1),
      options: {
        isWholeLine: true,
        className: 'wcr-blame-line',
        after: { content: `  ${author}`, inlineClassName: 'wcr-blame-author' },
        hoverMessage: {
          value: `${shortAuthor(entry.author)} · ${entry.rev.slice(0, 7)}\n\n${entry.summary}`,
        },
      },
    });
  }
  return out;
}

interface Props {
  projectId: string | null;
  file: string | null;
  lang: string;
  content: string;
  reveal: RevealRequest | null;
  /** 索引完成 / 文件变更时 +1，用于重拉语义着色。 */
  highlightsToken: number;
  onCursor?: (line: number, col: number) => void;
  /** N22：光标 / 滚动位置变化时上报（供位置记忆落盘）。 */
  onPosition?: (line: number, col: number, scrollTop: number) => void;
  /** 判据 6：复制当前位置为 `path:line:col`。 */
  onCopyLocation?: (file: string, line: number, col: number) => void;
  /** S3a：复制选中代码为「带出处的片段」（出处行 + 围栏代码块）。 */
  onCopySnippet?: (file: string, startLine: number, endLine: number, text: string) => void;
  /** S3b：复制光标处符号的摘要（名字 + 种类 + 签名 + 位置）。 */
  onCopySymbol?: (file: string, line: number, col: number) => void;
  /** W4 / G5.1：右键「解释这段」（Ctrl/Cmd+Alt+E）—— 结构性解释，不使用模型。 */
  onExplain?: (file: string, line: number, col: number) => void;
  /** W5 / G9.4：右键「看调用图」（流视图浮层）。 */
  onFlow?: (file: string, line: number, col: number) => void;
  /** S10：本机批注 —— 在编辑器里标出来，悬停看内容（不写回源码）。 */
  annotations?: AnnotationThread[];
  /** G6.1：摘要条里点导出符号 / 引用文件时打开（缺省则不跳）。 */
  onOpenFile?: (file: string, line?: number, col?: number) => void;
  /**
   * G7.5：历史版本（只读快照）所在的提交。存在时本窗格用 `wcr-history://` 建 model，
   * 并且不参与真实文件的一切：不拉着色 / agent 行 / 笔记 / 摘要 / 密度条，
   * 也不上报光标与位置 —— 它不是「打开过的文件」（不进最近打开与位置记忆）。
   */
  historyRev?: string;
  /** G7.3：整文件 blame 数据（null / 缺省 = 不显示行尾作者）。 */
  blame?: BlameLine[] | null;
  /** G7.5：从摘要条的提交历史里点某一次提交（App 负责取正文并在第二窗格打开）。 */
  onOpenHistory?: (file: string, rev: string) => void;
}

export function Editor({
  projectId,
  file,
  lang,
  content,
  reveal,
  highlightsToken,
  onCursor,
  onPosition,
  onCopyLocation,
  onCopySnippet,
  onCopySymbol,
  onExplain,
  onFlow,
  annotations,
  onOpenFile,
  historyRev,
  blame,
  onOpenHistory,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const fileRef = useRef(file);
  fileRef.current = file;
  const onCopyRef = useRef(onCopyLocation);
  onCopyRef.current = onCopyLocation;
  const onCopySnippetRef = useRef(onCopySnippet);
  onCopySnippetRef.current = onCopySnippet;
  const onCopySymbolRef = useRef(onCopySymbol);
  onCopySymbolRef.current = onCopySymbol;
  const onExplainRef = useRef(onExplain);
  onExplainRef.current = onExplain;
  const onFlowRef = useRef(onFlow);
  onFlowRef.current = onFlow;
  /** G7.5：本窗格是历史版本快照（不是磁盘上的真实文件）。 */
  const historical = Boolean(file && historyRev);
  const historicalRef = useRef(historical);
  historicalRef.current = historical;
  const positionTimerRef = useRef<number | null>(null);
  /** W2：正在编辑的行级笔记浮层（行号 + 视口坐标）；null = 不显示。 */
  const [noteLine, setNoteLine] = useState<number | null>(null);
  const [noteAnchorPos, setNoteAnchorPos] = useState<{ top: number; left: number } | null>(null);
  const noteLineRef = useRef<number | null>(null);
  noteLineRef.current = noteLine;
  /** W2：本项目全部笔记（本窗格的行槽标记按自己的文件 + 正文算，见 `mineNotes`）。 */
  const notes = useNotesStore((s) => s.notes);
  const syncNoteFile = useNotesStore((s) => s.syncFile);
  /** 密度条距编辑器右缘的像素：minimap + 纵向滚动条宽度。 */
  const [densityInset, setDensityInset] = useState(0);
  /** P24：主题与字号来自 wcr:prefs（单一真相）；Monaco 主题全局生效，两个窗格一起切。 */
  const prefs = usePrefs();

  useEffect(() => {
    monaco.editor.setTheme(themeNameFor(resolvedTheme(prefs.theme)));
  }, [prefs.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: prefs.fontSize });
  }, [prefs.fontSize]);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      theme: themeNameFor(resolvedTheme(loadPrefs().theme)),
      fontSize: loadPrefs().fontSize,
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      smoothScrolling: true,
      tabSize: 4,
      contextmenu: true,
      fixedOverflowWidgets: true,
      occurrencesHighlight: 'off',
      selectionHighlight: false,
    });
    editorRef.current = editor;
    // 悬停卡片里的「引用 N 处」需要拿到编辑器实例才能触发 Monaco 内置引用查找
    setProviderContext({ getEditor: () => editorRef.current });
    // N22：上报「光标 + 滚动位置」，只在用户操作后防抖写入本机存储
    const reportPosition = () => {
      if (historicalRef.current) return; // 历史版本不记位置
      if (positionTimerRef.current != null) window.clearTimeout(positionTimerRef.current);
      positionTimerRef.current = window.setTimeout(() => {
        const pos = editor.getPosition();
        onPositionRef.current?.(pos?.lineNumber ?? 1, pos?.column ?? 1, editor.getScrollTop());
      }, 400);
    };
    const subs = [
      editor.onDidChangeCursorPosition((e) => {
        if (historicalRef.current) return; // 历史版本不上报光标
        onCursorRef.current?.(e.position.lineNumber, e.position.column);
        reportPosition();
        // S7a：宿主跟着知道「在读哪一行」；选区单独上报（S7b），光标上只带一次快照
        const sel = editor.getSelection();
        reportCaret({
          file: fileRef.current,
          line: e.position.lineNumber,
          col: e.position.column,
          selection: !sel || sel.isEmpty() ? undefined : selectionOf(editor, sel),
        });
      }),
      editor.onDidScrollChange(() => {
        reportPosition();
        // 笔记浮层是按视口坐标摆的：滚动后它就不再贴着那一行了，直接关掉（不跟随）
        if (noteLineRef.current != null) closeNotePopover();
      }),
      // W2 / G4.1：点行槽上的笔记图标 → 打开编辑浮层（只对行槽装饰生效）
      editor.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
        const line = e.target.position?.lineNumber ?? e.target.range?.startLineNumber;
        if (!line) return;
        // 行滚出视口就先滚进来，再量坐标；量不到就不开，不猜位置
        editor.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
        const pos = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
        const rect = hostRef.current?.getBoundingClientRect();
        if (!pos || !rect) return;
        setNoteLine(line);
        setNoteAnchorPos({ top: rect.top + pos.top, left: rect.left + pos.left + 24 });
      }),
      editor.onDidChangeCursorSelection((e) => {
        if (historicalRef.current) return;
        reportCaret({
          file: fileRef.current,
          line: e.selection.startLineNumber,
          col: e.selection.startColumn,
          selection: e.selection.isEmpty() ? undefined : selectionOf(editor, e.selection),
        });
      }),
    ];
    // 判据 6：把光标处复制成 `path:line:col`（右键菜单 + Ctrl/Cmd+Alt+C）
    editor.addAction({
      id: 'wcr.copyLocation',
      label: '复制位置（path:line:col）',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: (ed) => {
        const pos = ed.getPosition();
        const current = fileRef.current;
        if (!current || !pos) return;
        onCopyRef.current?.(current, pos.lineNumber, pos.column);
      },
    });
    // S3a：选中一段代码 → 带出处的片段（出处行 + 围栏代码块），可直接贴聊天窗
    editor.addAction({
      id: 'wcr.copySnippet',
      label: '复制选中代码（带出处）',
      precondition: 'editorHasSelection',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 5,
      run: (ed) => {
        const current = fileRef.current;
        const sel = ed.getSelection();
        const model = ed.getModel();
        if (!current || !sel || !model || sel.isEmpty()) return;
        const text = model.getValueInRange(sel);
        onCopySnippetRef.current?.(current, sel.startLineNumber, sel.endLineNumber, text);
      },
    });
    // W2 / G3.5：把当前位置加入待读（与向导面板 / 文件树共用同一份 wcr:queue:<id>）
    editor.addAction({
      id: 'wcr.addToQueue',
      label: '把当前位置加入待读',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: (ed) => {
        const pos = ed.getPosition();
        const current = fileRef.current;
        if (!current || !pos) return;
        useGuideStore.getState().addQueue({ file: current, line: pos.lineNumber, col: pos.column });
      },
    });
    // W4 / G5.1：解释光标处的符号（结构性解释，不使用模型）
    editor.addAction({
      id: 'wcr.explain',
      label: translate('explain.menu'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyE],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: (ed) => {
        const pos = ed.getPosition();
        const current = fileRef.current;
        if (!current || !pos) return;
        onExplainRef.current?.(current, pos.lineNumber, pos.column);
      },
    });
    // W5 / G9.4：把光标处的符号展开成调用流图
    editor.addAction({
      id: 'wcr.callGraph',
      label: translate('flow.menu'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      run: (ed) => {
        const pos = ed.getPosition();
        const current = fileRef.current;
        if (!current || !pos) return;
        onFlowRef.current?.(current, pos.lineNumber, pos.column);
      },
    });
    // S3b：不贴整段，只贴「谁、在哪、签名是什么」
    editor.addAction({
      id: 'wcr.copySymbol',
      label: '复制符号摘要（签名 + 位置）',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 6,
      run: (ed) => {
        const current = fileRef.current;
        const pos = ed.getPosition();
        if (!current || !pos) return;
        onCopySymbolRef.current?.(current, pos.lineNumber, pos.column);
      },
    });
    const closeNotePopover = () => {
      setNoteLine(null);
      setNoteAnchorPos(null);
    };
    return () => {
      for (const sub of subs) sub.dispose();
      closeNotePopover();
      if (positionTimerRef.current != null) window.clearTimeout(positionTimerRef.current);
      editor.dispose();
      editorRef.current = null;
      setProviderContext({ getEditor: undefined });
      // N19：model 由模块级池共享，不随单个 editor 销毁；只清本实例的引用
      decorationPool.clear();
      agentLinePool.clear();
      annotationPool.clear();
      notePool.clear();
      blamePool.clear();
    };
  }, []);

  // 密度条要贴在 minimap 左侧：跟随编辑器布局变化重算右缘偏移
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const sync = () => {
      const info = editor.getLayoutInfo();
      setDensityInset(info.minimap.minimapWidth + info.verticalScrollbarWidth);
    };
    sync();
    const sub = editor.onDidLayoutChange(sync);
    return () => sub.dispose();
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!file) {
      editor.setModel(null);
      return;
    }
    // G7.5：历史版本用独立的 model uri（不是 `wcr://`，不会覆盖磁盘上同一路径的 model）
    const uri = historyRev ? historyModelUriFor(historyRev, file) : modelUriFor(file);
    const model = acquireModel(uri.toString(), uri, content, lang);
    if (editor.getModel() !== model) editor.setModel(model);
    if (historicalRef.current) return; // 历史版本不当作「打开过的文件」上报
    // S7：换文件必发（行号随后由光标事件跟随）
    const pos = editor.getPosition();
    reportCaret({ file, line: pos?.lineNumber ?? 1, col: pos?.column ?? 1 });
  }, [file, lang, content, historyRev]);

  // 语义着色：本项目符号提亮、外部依赖/标准库压暗
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !file || !projectId || historical) return;
    const model = editor.getModel();
    if (!model) return;
    let cancelled = false;
    void api
      .highlights(projectId, file)
      .then((res) => {
        const live = editorRef.current;
        if (cancelled || !live || live.getModel() !== model) return;
        const next = toSemanticDecorations(model, res.data);
        const previous = decorationPool.get(model) ?? [];
        decorationPool.set(model, model.deltaDecorations(previous, next));
      })
      .catch(() => {
        /* 着色失败不影响阅读，保持语法色 */
      });
    return () => {
      cancelled = true;
    };
  }, [file, content, projectId, highlightsToken]);

  // M10.2：本轮 agent 改了哪几行 —— 只信宿主上报的行范围，没上报就什么都不画
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !file || !projectId || historical) return;
    const model = editor.getModel();
    if (!model) return;
    let cancelled = false;
    void mapApi
      .agentLines(projectId, file)
      .then((res) => {
        const live = editorRef.current;
        if (cancelled || !live || live.getModel() !== model) return;
        const next = toAgentLineDecorations(model, res.lines ?? []);
        const previous = agentLinePool.get(model) ?? [];
        agentLinePool.set(model, model.deltaDecorations(previous, next));
      })
      .catch(() => {
        /* 拿不到就不画，不能猜哪些行是 agent 写的 */
      });
    return () => {
      cancelled = true;
    };
  }, [file, content, projectId, highlightsToken]);

  // S10：本机批注 —— 在行上留一个可悬停的标记（只加装饰，不动源码）
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !file || historical) return;
    const mine = (annotations ?? []).filter((a) => a.file === file);
    const previous = annotationPool.get(model) ?? [];
    annotationPool.set(model, model.deltaDecorations(previous, toAnnotationDecorations(model, mine)));
  }, [file, annotations, content, historical]);

  // W2：把当前文件正文同步给笔记存储 —— anchor 恢复（三层兜底）只认正文。
  // 分屏时两个窗格都会同步，store 里那份（供侧栏「待归位」用）指向最后同步的文件，
  // 这是有意的：面板只有一个，锚点校验以当前阅读的那个文件为准。
  useEffect(() => {
    // G7.5：历史版本不是当前文件，不参与笔记锚定
    if (historical) return;
    syncNoteFile(file, content);
  }, [file, content, syncNoteFile, historical]);

  /**
   * 本窗格的行级笔记（含 anchor 恢复后的行号）。
   * 不用 store 里那份：分屏时两个窗格各看一个文件，各算各的才都对。
   */
  const mineNotes = useMemo(() => {
    if (!file || historical) return [];
    return resolveNotes(
      notes.filter((n) => n.file === file),
      content,
    ).located.filter((n) => n.level === 'line');
  }, [notes, file, content]);

  // W2 / G4.1：行级笔记的行槽图标（第四个装饰池，单独刷新，不与上面三个互清）
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !file || historical) return;
    const previous = notePool.get(model) ?? [];
    notePool.set(model, model.deltaDecorations(previous, toNoteDecorations(model, mineNotes)));
  }, [file, mineNotes, historical]);

  // G7.3：整文件 blame 视图 —— 每行行尾一个作者短名（数据由 App 按文件缓存后传入：
  // 光标移动不重新请求，只在换文件 / 显式重取时拉一次）
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const previous = blamePool.get(model) ?? [];
    const next = blame && !historical ? toBlameDecorations(model, blame) : [];
    blamePool.set(model, model.deltaDecorations(previous, next));
  }, [blame, historical, file, content]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || reveal.file !== file) return;
    const model = editor.getModel();
    if (!model) return;
    // N22：无显式行号时恢复上次离开的位置（含滚动位置）
    if (reveal.scrollTop != null) {
      editor.setSelection(new monaco.Selection(reveal.line, reveal.col, reveal.line, reveal.col));
      editor.setScrollTop(reveal.scrollTop);
      editor.focus();
      return;
    }
    const endLine = reveal.endLine ?? reveal.line;
    const endCol = reveal.endCol ?? reveal.col + 1;
    const selection = new monaco.Selection(reveal.line, reveal.col, endLine, endCol);
    editor.setSelection(selection);
    editor.revealRangeInCenterIfOutsideViewport(selection, monaco.editor.ScrollType.Smooth);
    editor.focus();
  }, [reveal, file]);

  /** 关闭笔记浮层（点外部 / Esc / 滚动 / 保存后都会调）。 */
  const closeNote = () => {
    setNoteLine(null);
    setNoteAnchorPos(null);
  };

  /** 密度条点击：只在本文件内滚动定位，不压历史（不是一次「跳转」而是「移到」）。 */
  const jumpToLine = (line: number) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const target = Math.min(Math.max(1, line), model.getLineCount());
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.revealLineInCenter(target, monaco.editor.ScrollType.Smooth);
    editor.focus();
  };

  return (
    <>
      {/* G6.1：顶部可折叠的文件摘要条（拿不到摘要时整条不渲染）；G7.4：展开区列提交历史。
          G7.5：历史版本窗格不显示摘要 / 笔记 / 密度条 —— 它们都属于「真实文件」。 */}
      {!historical && (
        <SummaryBar projectId={projectId} file={file} onOpenFile={onOpenFile} onOpenHistory={onOpenHistory} />
      )}
      {/* G4.2：文件级笔记（一个文件的整体印象，一行） */}
      {!historical && <FileNoteBar projectId={projectId} file={file} />}
      <div className="editor-host" ref={hostRef} />
      {/* W2 / G4.1：行级笔记的编辑浮层（点行槽图标打开） */}
      {!historical && file && noteLine != null && noteAnchorPos && (
        <NotePopover
          file={file}
          line={noteLine}
          anchor={anchorOf(content, noteLine)}
          notes={mineNotes.filter((n) => n.resolvedLine === noteLine)}
          position={noteAnchorPos}
          onClose={closeNote}
        />
      )}
      {!historical && file && projectId && (
        <FileDensityBar
          projectId={projectId}
          file={file}
          highlightsToken={highlightsToken}
          rightInset={densityInset}
          onJump={jumpToLine}
        />
      )}
    </>
  );
}
