/** Monaco 编辑器封装：model 池 + 只读显示 + 定位 + 语义着色 + 密度条入口。 */
import { useEffect, useRef, useState } from 'react';
import type { RevealRequest } from './state';
import { api } from './api';
import { mapApi } from './mapApi';
import { FileDensityBar } from './FileDensityBar';
import { shortAuthor } from './blame';
import { translate } from './i18n';
import { loadPrefs, resolvedTheme, usePrefs } from './prefs';
import { reportCaret } from './bridge';
import type { BlameLine } from '../../shared/types';
import './agent-lines.css';
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
/**
 * model → G7.3 blame 行尾作者装饰 id。
 * 单独一个池的理由同上：blame 只由「打开 blame 视图 / 光标移动」驱动，
 * 与着色、agent 行的刷新时机都不同。
 */
const blamePool = new Map<monaco.editor.ITextModel, string[]>();

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
        hoverMessage: { value: translate('editor.agentHover') },
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
  /** 状态栏：当前选区的字符数与行数（无选区时为 null）。 */
  onSelection?: (sel: { chars: number; lines: number } | null) => void;
  /** N22：光标 / 滚动位置变化时上报（供位置记忆落盘）。 */
  onPosition?: (line: number, col: number, scrollTop: number) => void;
  /**
   * 编辑器内点击文本区产生的光标位置（App 负责记进前进 / 后退历史）。
   * 与 onPosition 的区别：onPosition 是「防抖后的当前落脚点」（用于下次打开这个文件回到哪），
   * 这里是「用户主动点了一下」这个离散动作，用来在导航历史里留回退点。
   */
  onClickPosition?: (line: number, col: number) => void;
  /** 判据 6：复制当前位置为 `path:line:col`。 */
  onCopyLocation?: (file: string, line: number, col: number) => void;
  /** S3a：复制选中代码为「带出处的片段」（出处行 + 围栏代码块）。 */
  onCopySnippet?: (file: string, startLine: number, endLine: number, text: string) => void;
  /** N19：在旁边的窗格打开（同一文件也允许，用于对照两个位置）。 */
  onOpenAside?: (file: string, line: number, col: number) => void;
  /** W4 / G5.1：右键「解释这段」（Ctrl/Cmd+Alt+E）—— 结构性解释，不使用模型。 */
  onExplain?: (file: string, line: number, col: number) => void;
  /** W5 / G9.4：右键「看调用图」（流视图浮层）。 */
  onFlow?: (file: string, line: number, col: number) => void;
  /** FR-0011：右键「在终端中运行」（整文件跑，不需要行列）。 */
  onRun?: (file: string) => void;
  /**
   * G7.5：历史版本（只读快照）所在的提交。存在时本窗格用 `wcr-history://` 建 model，
   * 并且不参与真实文件的一切：不拉着色 / agent 行 / 摘要 / 密度条，
   * 也不上报光标与位置 —— 它不是「打开过的文件」（不进最近打开与位置记忆）。
   */
  historyRev?: string;
  /** G7.3：整文件 blame 数据（null / 缺省 = 不显示行尾作者）。 */
  blame?: BlameLine[] | null;
  /**
   * FR-0008（2026-10-10）：本窗格可编辑。缺省 false —— 分屏第二窗格与历史快照保持只读。
   */
  editable?: boolean;
  /** FR-0008：正文变化（停手 1 s 由 App 自动落盘）。 */
  onChange?: (text: string) => void;
  /**
   * FR-0008：“把 content 灌进 model”的显式信号（打开文件 / 用磁盘版本重载时 +1）。
   *
   * **不能直接用 `content` 做依赖**：保存成功后 store 也会更新 `content`，
   * 一旦用它当依赖，保存回执到达时就会拿旧快照 `setValue()` 覆盖编辑器，
   * 把期间敲进去的字回退掉（并清空 undo 栈）。编辑期的真相只能是 model 本身。
   */
  contentToken?: number;
}

export function Editor({
  projectId,
  file,
  lang,
  content,
  reveal,
  highlightsToken,
  onCursor,
  onSelection,
  onPosition,
  onClickPosition,
  onCopyLocation,
  onCopySnippet,
  onOpenAside,
  onExplain,
  onFlow,
  onRun,
  historyRev,
  blame,
  editable = false,
  onChange,
  contentToken = 0,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const onClickPositionRef = useRef(onClickPosition);
  onClickPositionRef.current = onClickPosition;
  const fileRef = useRef(file);
  fileRef.current = file;
  const onCopyRef = useRef(onCopyLocation);
  onCopyRef.current = onCopyLocation;
  const onCopySnippetRef = useRef(onCopySnippet);
  onCopySnippetRef.current = onCopySnippet;
  const onOpenAsideRef = useRef(onOpenAside);
  onOpenAsideRef.current = onOpenAside;
  const onExplainRef = useRef(onExplain);
  onExplainRef.current = onExplain;
  const onFlowRef = useRef(onFlow);
  onFlowRef.current = onFlow;
  /** FR-0011：右键「在终端中运行」的回调（ref 读最新值，见 onExplainRef 说明）。 */
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  /** FR-0008：正文变化上报（放 ref：create 只跑一次，不该因它重建设编辑器）。 */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** FR-0008：可编辑开关（同上，用 ref 读最新值）。 */
  const editableRef = useRef(editable);
  editableRef.current = editable;
  /** FR-0008：正文用 ref 读 —— 它不该出现在同步 effect 的依赖里（见 contentToken 说明）。 */
  const contentRef = useRef(content);
  contentRef.current = content;
  /** G7.5：本窗格是历史版本快照（不是磁盘上的真实文件）。 */
  const historical = Boolean(file && historyRev);
  const historicalRef = useRef(historical);
  historicalRef.current = historical;
  const positionTimerRef = useRef<number | null>(null);
  /** 密度条距编辑器右缘的像素：minimap + 纵向滚动条宽度。 */
  const [densityInset, setDensityInset] = useState(0);
  /** P24：主题与字号来自 wcr:prefs（单一真相）；Monaco 主题全局生效，两个窗格一起切。 */
  const prefs = usePrefs();

  useEffect(() => {
    monaco.editor.setTheme(themeNameFor(resolvedTheme(prefs.theme)));
  }, [prefs.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: prefs.fontSize,
      wordWrap: prefs.wrap ? 'on' : 'off',
      tabSize: prefs.tabSize,
      minimap: { enabled: prefs.minimap, renderCharacters: false },
      renderWhitespace: prefs.whitespace ? 'all' : 'none',
      guides: { indentation: prefs.whitespace },
    });
  }, [prefs.fontSize, prefs.wrap, prefs.tabSize, prefs.minimap, prefs.whitespace]);

  /** FR-0008：可编辑开关（历史版本恒只读）—— 编辑器已建好，改的是运行时选项。 */
  useEffect(() => {
    const readOnly = !editable || historical;
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [editable, historical]);

  useEffect(() => {
    if (!hostRef.current) return;
    const initial = loadPrefs();
    const editor = monaco.editor.create(hostRef.current, {
      // FR-0008：可编辑由 prop 决定（默认只读；分屏第二窗格与历史快照不传）
      readOnly: !editableRef.current,
      domReadOnly: !editableRef.current,
      automaticLayout: true,
      theme: themeNameFor(resolvedTheme(initial.theme)),
      fontSize: initial.fontSize,
      minimap: { enabled: initial.minimap, renderCharacters: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      smoothScrolling: true,
      wordWrap: initial.wrap ? 'on' : 'off',
      tabSize: initial.tabSize,
      renderWhitespace: initial.whitespace ? 'all' : 'none',
      guides: { indentation: initial.whitespace },
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
    /** 状态栏：上报当前选区的字符数与行数（空选区 = null）。 */
    const reportSelection = () => {
      const model = editor.getModel();
      const sel = editor.getSelection();
      if (!model || !sel || sel.isEmpty()) {
        onSelectionRef.current?.(null);
        return;
      }
      const lines = sel.endLineNumber - sel.startLineNumber + 1;
      // getValueLengthInRange 把跨行的换行符也算进长度，减掉才是纯字符数
      const chars = model.getValueLengthInRange(sel) - (lines - 1);
      onSelectionRef.current?.({ chars, lines });
    };

    const subs = [
      // FR-0008：正文变化上报（App 负责 1 s 防抖落盘）；历史快照不上报
      editor.onDidChangeModelContent(() => {
        if (historicalRef.current) return;
        onChangeRef.current?.(editor.getValue());
      }),
      editor.onDidChangeCursorPosition((e) => {
        if (historicalRef.current) return; // 历史版本不上报光标
        onCursorRef.current?.(e.position.lineNumber, e.position.column);
        reportPosition();
        reportSelection();
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
      }),
      // 在编辑器里点一下也进导航历史：位置本身就是一个可回退的点（App 侧压栈）。
      // 只认文本区左键——滚动条 / 行号槽 / 浮层部件 / 右键 / Ctrl+Click（跳转）| Alt+Click（多光标）都不算。
      editor.onMouseUp((e) => {
        if (historicalRef.current) return; // 历史快照不记位置
        if (!e.event.leftButton) return;
        if (e.event.ctrlKey || e.event.metaKey || e.event.altKey) return;
        const t = e.target.type;
        if (t !== monaco.editor.MouseTargetType.CONTENT_TEXT && t !== monaco.editor.MouseTargetType.CONTENT_EMPTY) return;
        const pos = editor.getPosition();
        if (!pos) return;
        onClickPositionRef.current?.(pos.lineNumber, pos.column);
      }),
      editor.onDidChangeCursorSelection((e) => {
        if (historicalRef.current) return;
        reportCaret({
          file: fileRef.current,
          line: e.selection.startLineNumber,
          col: e.selection.startColumn,
          selection: e.selection.isEmpty() ? undefined : selectionOf(editor, e.selection),
        });
        reportSelection();
      }),
    ];
    // 判据 6：把光标处复制成 `path:line:col`（右键菜单 + Ctrl/Cmd+Alt+C）
    editor.addAction({
      id: 'wcr.copyLocation',
      label: translate('editor.copyLocationLabel'),
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
      label: translate('editor.copySnippetLabel'),
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
    // N19：在旁边打开（分屏）—— 搬自顶部导航条的按钮（2026-10-08 用户要求）
    editor.addAction({
      id: 'wcr.openAside',
      label: translate('editor.openAsideLabel'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0.5,
      run: (ed) => {
        const pos = ed.getPosition();
        const current = fileRef.current;
        if (!current || !pos) return;
        onOpenAsideRef.current?.(current, pos.lineNumber, pos.column);
      },
    });
    // FR-0011：在终端中运行当前文件
    editor.addAction({
      id: 'wcr.runFile',
      label: translate('run.menu'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => {
        const current = fileRef.current;
        if (!current) return;
        onRunRef.current?.(current);
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
    return () => {
      for (const sub of subs) sub.dispose();
      if (positionTimerRef.current != null) window.clearTimeout(positionTimerRef.current);
      editor.dispose();
      editorRef.current = null;
      setProviderContext({ getEditor: undefined });
      // N19：model 由模块级池共享，不随单个 editor 销毁；只清本实例的引用
      decorationPool.clear();
      agentLinePool.clear();
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
    // 只在「换文件」或「显式重载（contentToken）」时把 store 的内容同步进 model；
    // 自动保存后 store 的 content 也会变，但 effect 不因它而跑 —— 否则会回退用户正在敲的字。
    const model = acquireModel(uri.toString(), uri, contentRef.current, lang);
    if (editor.getModel() !== model) editor.setModel(model);
    if (historicalRef.current) return; // 历史版本不当作「打开过的文件」上报
    // S7：换文件必发（行号随后由光标事件跟随）
    const pos = editor.getPosition();
    reportCaret({ file, line: pos?.lineNumber ?? 1, col: pos?.column ?? 1 });
  }, [file, lang, historyRev, contentToken]);

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
    // 只跟「文件 + 索引版本」走：带上 content 会把着色请求打成一片（编辑时每次输入都变）
    return () => {
      cancelled = true;
    };
  }, [file, projectId, highlightsToken, historical]);

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
    // 同上：不跟 content 走（编辑期间 content 会变）
    return () => {
      cancelled = true;
    };
  }, [file, projectId, highlightsToken, historical]);

  // G7.3：整文件 blame 视图 —— 每行行尾一个作者短名（数据由 App 按文件缓存后传入：
  // 光标移动不重新请求，只在换文件 / 显式重取时拉一次）
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const previous = blamePool.get(model) ?? [];
    const next = blame && !historical ? toBlameDecorations(model, blame) : [];
    blamePool.set(model, model.deltaDecorations(previous, next));
  }, [blame, historical, file]);

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
      {/* G6.1 的文件摘要条已搬到编辑区顶条（2，2026-10-15 用户要求），不再占编辑区一行。
          G7.5：历史版本窗格不显示密度条 —— 它属于「真实文件」。 */}
      <div className="editor-host" ref={hostRef} />
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
