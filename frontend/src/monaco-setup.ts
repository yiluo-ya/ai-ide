/**
 * Monaco 环境与代码智能 Provider 注册。
 *
 * 关键点（FR-0002 §5.1）：
 * - Model 的 uri 用自定义协议 `wcr:///<项目内相对路径>`，provider 里直接取 uri.path 当 file 传给后端；
 * - 注册 Definition / Reference / DocumentSymbol 三个 Provider 后，F12 / Shift+F12 / Ctrl+Shift+O 自动生效；
 * - 跨文件跳转靠 `registerEditorOpener` 接住，交给 App 切文件。
 */
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type {
  ExternalSource,
  HoverDefinition,
  HoverLiteral,
  HoverResult,
  Location,
  Range,
  SymbolInfo,
  SymbolKind,
} from '../../shared/types';
import { api } from './api';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/** 后端语言 id → Monaco 语言 id。 */
const MONACO_LANG: Record<string, string> = {
  python: 'python',
  typescript: 'typescript',
  tsx: 'typescript',
  javascript: 'javascript',
  jsx: 'javascript',
  go: 'go',
  java: 'java',
  shell: 'shell',
  json: 'json',
  yaml: 'yaml',
  toml: 'ini', // Monaco 没有 TOML 语法，用最接近的 ini
  ini: 'ini',
  dockerfile: 'dockerfile',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  sql: 'sql',
  // 包依赖 / 构建清单（只高亮预览，见后端 languages/manifests.ts）：Monaco 没有的语法借最接近的
  xml: 'xml',
  gomod: 'go',
  groovy: 'java',
  kotlin: 'kotlin',
  scala: 'scala',
  ruby: 'ruby',
  elixir: 'elixir',
  swift: 'swift',
  pip: 'ini',
  makefile: 'shell',
};

export function monacoLangFor(lang: string | undefined): string {
  if (!lang) return 'plaintext';
  return MONACO_LANG[lang] ?? 'plaintext';
}

/** 有引用能力的语言：hover / 跳到定义 / 查找引用（与后端 LanguageSpec 的引用索引对应）。 */
export const PROVIDER_LANGUAGES = ['python', 'typescript', 'javascript', 'go', 'java', 'shell'];

/**
 * 有符号索引的语言：文件大纲（Ctrl+Shift+O）。比上面多出只有键 / 标题 / 名字的文件类型。
 * 这里是 Monaco 语言 id：toml 与 ini 共用 `ini`。
 */
export const SYMBOL_LANGUAGES = [
  ...new Set([
    ...PROVIDER_LANGUAGES,
    'json',
    'yaml',
    'ini',
    'dockerfile',
    'markdown',
    'css',
    'scss',
    'less',
    'html',
    'sql',
  ]),
];

export const MODEL_SCHEME = 'wcr';

/**
 * 阅读器专用主题（P24）：深/浅各一套。
 * 底色压暗 / 提亮，默认前景降一档，让「本项目符号」的提亮与「外部依赖」的压暗都有对比空间。
 */
export const READER_THEME_DARK = 'wcr-dark';
export const READER_THEME_LIGHT = 'wcr-light';

/** 按生效主题取 Monaco 主题名。 */
export function themeNameFor(theme: 'dark' | 'light'): string {
  return theme === 'light' ? READER_THEME_LIGHT : READER_THEME_DARK;
}

/** 语义着色的装饰类名（颜色在 styles.css 里用 CSS 变量定义）。 */
export const HL_CLASS = {
  project: 'wcr-hl-project',
  external: 'wcr-hl-external',
  local: 'wcr-hl-local',
} as const;

/** 后端 kind 序号 → 装饰类名。 */
const HL_BY_KIND = [HL_CLASS.project, HL_CLASS.external, HL_CLASS.local] as const;

export function defineReaderTheme() {
  monaco.editor.defineTheme(READER_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#131315',
      'editor.foreground': '#c3c8ce',
      'editor.lineHighlightBackground': '#1c1c21',
      'editor.selectionBackground': '#2a4a6b',
      'editorLineNumber.foreground': '#4b5057',
      'editorLineNumber.activeForeground': '#8b9198',
      'editorGutter.background': '#131315',
      'editorCursor.foreground': '#ffffff',
      'minimap.background': '#131315',
      'editorWidget.background': '#1b1b1f',
      'editorWidget.border': '#3c3c3c',
      'editorIndentGuide.background1': '#232327',
    },
  });
  monaco.editor.defineTheme(READER_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2328',
      'editor.lineHighlightBackground': '#f2f4f7',
      'editor.selectionBackground': '#b9d6f2',
      'editorLineNumber.foreground': '#a0a6ae',
      'editorLineNumber.activeForeground': '#40474f',
      'editorGutter.background': '#ffffff',
      'editorCursor.foreground': '#0f6cbd',
      'minimap.background': '#ffffff',
      'editorWidget.background': '#f8f9fb',
      'editorWidget.border': '#d5d8dd',
      'editorIndentGuide.background1': '#e6e8eb',
    },
  });
}

export function modelUriFor(file: string): monaco.Uri {
  return monaco.Uri.parse(`${MODEL_SCHEME}:///${file}`);
}

/**
 * G7.5：历史版本的 model scheme。
 * 为什么不共用 `wcr`：定义跳转 / 路径按钮的 provider 只处理 `MODEL_SCHEME`，
 * 历史正文里的一行代码并不对应磁盘上的真实文件，混进来会被当成可跳的当前代码。
 */
export const HISTORY_SCHEME = 'wcr-history';

/** 历史版本的 model uri：`wcr-history://<rev>/<path>`（rev 作 authority）。 */
export function historyModelUriFor(rev: string, file: string): monaco.Uri {
  return monaco.Uri.parse(`${HISTORY_SCHEME}://${rev}/${file}`);
}

export function fileOfModel(model: monaco.editor.ITextModel): string {
  return model.uri.path.replace(/^\//, '');
}

/** Monaco 的 DocumentSymbolProvider 需要 range + selectionRange（都要包含在同一个 model 里）。 */
function toDocumentSymbol(info: SymbolInfo): monaco.languages.DocumentSymbol {
  const sel = info.location.range;
  const full = info.range ?? sel;
  const kind = info.kind;
  return {
    name: info.name,
    detail: info.detail ?? '',
    kind: monaco.languages.SymbolKind[kind as keyof typeof monaco.languages.SymbolKind] ?? 0,
    tags: [],
    range: new monaco.Range(full.start.line, full.start.col, full.end.line, full.end.col),
    selectionRange: new monaco.Range(sel.start.line, sel.start.col, sel.end.line, sel.end.col),
    children: (info.children ?? []).map(toDocumentSymbol),
  } as monaco.languages.DocumentSymbol & { children: monaco.languages.DocumentSymbol[] };
}

export function toMonacoRange(range: Range): monaco.Range {
  return new monaco.Range(
    range.start.line,
    range.start.col,
    range.end.line,
    range.end.col,
  );
}

/** 语义着色：把「本项目符号 / 外部依赖符号」转成 Monaco 装饰。 */
export function toSemanticDecorations(
  model: monaco.editor.ITextModel,
  data: number[],
): monaco.editor.IModelDeltaDecoration[] {
  const lineCount = model.getLineCount();
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    const line = data[i];
    const col = data[i + 1];
    const len = data[i + 2];
    const kind = data[i + 3];
    if (line < 1 || line > lineCount || len <= 0) continue; // 索引可能略超前于文件内容
    const maxCol = model.getLineMaxColumn(line);
    if (col < 1 || col >= maxCol) continue;
    const end = Math.min(col + len, maxCol);
    if (end <= col) continue;
    const cls = HL_BY_KIND[kind];
    if (!cls) continue;
    out.push({
      range: new monaco.Range(line, col, line, end),
      options: {
        inlineClassName: cls,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
  }
  return out;
}

export interface GotoFailure {
  kind: 'definition' | 'references';
  reason: 'external' | 'unresolved' | 'no-symbol';
  /** 命中的符号名；光标处无符号时为 null。 */
  symbol: string | null;
  /** reason=external 时的来源（模块名 / import 位置），用于「跳到 import 行」。 */
  external?: ExternalSource;
}

export interface ProviderContext {
  projectId: string | null;
  /** 打开某文件并定位（跨文件跳转、引用面板点击都走它）。 */
  openLocation: (file: string, line: number, col: number, endLine?: number, endCol?: number) => void;
  /** 当前编辑器实例（悬停卡片点「引用 N 处」时要触发 Monaco 内置引用查找）。 */
  getEditor?: () => monaco.editor.IStandaloneCodeEditor | null;
  /**
   * 没有跳转时的回调（03-navigator §3.1 / N2）：
   * 后端已经算好 reason 与 symbol，之前被这里直接丢弃，导致「按了 F12 什么也没发生」。
   */
  onGotoFailed?: (failure: GotoFailure) => void;
  /**
   * 正文里的路径是否真实存在（N25）：只有校验通过的路径才给可点击态。
   * 误跳比不可点更伤信任（Q6）。
   */
  fileExists?: (rel: string) => boolean;
}

let ctx: ProviderContext = { projectId: null, openLocation: () => {} };

/**
 * 增量合并：App 负责 projectId / openLocation，Editor 负责 getEditor，
 * 两边各自 set 而互不覆盖（父组件 effect 晚于子组件执行，整体替换会丢掉 getEditor）。
 */
export function setProviderContext(patch: Partial<ProviderContext>) {
  ctx = { ...ctx, ...patch };
}

/** Monaco 的 ResolveLocation 分支：当前文件内联返回，跨文件用 openLocation 兜住。 */
function toLocation(file: string, r: Range): monaco.languages.Location {
  return { uri: modelUriFor(file), range: toMonacoRange(r) };
}

// ---------------------------------------------------------------- 悬停卡片（02-lens §3.1–§3.3）

/** 卡片里的两个只读动作（由 command: 链接触发）。 */
const HOVER_CMD_OPEN = 'wcr.hover.open';
const HOVER_CMD_REFS = 'wcr.hover.findReferences';
/** 「引用 N 处」先切文件再触发引用查找时的轮询次数（每次 100ms）。 */
const REFS_RETRY = 15;

/**
 * 卡片元素的样式挂点。
 *
 * 坑：Monaco 渲染 hover 内容时会用 DOMPurify 清洗，其 uponSanitizeAttribute 钩子只保留
 * 「SPAN 且 class 形如 `codicon codicon-xxx`」的 class，普通 class 会被整条剥离。
 * 所以卡片每个元素都挂 `codicon codicon-wcr-hover-*` 作挂点，样式在 styles.css 里按该前缀定义
 * （即文档说的 wcr-hover-* 类名）。
 */
const HC = {
  card: 'codicon-wcr-hover-card',
  head: 'codicon-wcr-hover-head',
  name: 'codicon-wcr-hover-name',
  container: 'codicon-wcr-hover-container',
  loc: 'codicon-wcr-hover-loc',
  sep: 'codicon-wcr-hover-sep',
  decorators: 'codicon-wcr-hover-decorators',
  decorator: 'codicon-wcr-hover-decorator',
  signature: 'codicon-wcr-hover-signature',
  types: 'codicon-wcr-hover-types',
  doc: 'codicon-wcr-hover-doc',
  refs: 'codicon-wcr-hover-refs',
  none: 'codicon-wcr-hover-none',
  note: 'codicon-wcr-hover-note',
  local: 'codicon-wcr-hover-local',
  external: 'codicon-wcr-hover-extbadge',
  /** 种类徽标：后面拼小写种类名，如 codicon-wcr-kind-method。 */
  kindPrefix: 'codicon-wcr-kind-',
} as const;

/** 卡片里可点的位置参数（command: 链接的载荷）。 */
interface HoverTarget {
  file: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** 元素：统一用 span 承载 codicon 挂点，样式在 styles.css 里恢复成块级 / 弹性布局。 */
function el(cls: string, inner: string): string {
  return `<span class="codicon ${cls}">${inner}</span>`;
}

/**
 * 卡片外壳：外层用 `<div>` 起头，让 marked 走 HTML 块分支（整段原样透传），
 * 避免签名 / 注释里的 markdown 语法（`*`、反引号等）被二次解释。
 */
function card(rows: string[]): string {
  return `<div>${el(HC.card, rows.join(''))}</div>`;
}

/** command: 链接：携带 uri-encoded JSON，命令处理时再解析。 */
function commandLink(command: string, target: HoverTarget, text: string): string {
  const payload = encodeURIComponent(JSON.stringify(target));
  return `<a href="command:${command}?${payload}">${esc(text)}</a>`;
}

function targetOf(loc: Location): HoverTarget {
  return {
    file: loc.file,
    line: loc.range.start.line,
    col: loc.range.start.col,
    endLine: loc.range.end.line,
    endCol: loc.range.end.col,
  };
}

/** `backend/src/user.ts:42` */
function locText(loc: Location): string {
  return `${loc.file}:${loc.range.start.line}`;
}

/** 定义位置行，可点跳转。 */
function locLine(loc: Location, prefix?: string): string {
  const label = prefix ? `${prefix} · ${locText(loc)}` : locText(loc);
  return el(HC.loc, commandLink(HOVER_CMD_OPEN, targetOf(loc), label));
}

/** 种类徽标：用英文种类名，与文档示例 `[method]` 一致。 */
function kindBadge(kind: SymbolKind): string {
  const slug = String(kind).toLowerCase().replace(/[^a-z]/g, '') || 'unknown';
  return el(`${HC.kindPrefix}${slug}`, esc(String(kind)));
}

function head(name: string | null | undefined, kind: SymbolKind | null, badge?: string): string {
  const parts: string[] = [];
  if (name) parts.push(el(HC.name, esc(name)));
  if (kind) parts.push(kindBadge(kind));
  if (badge) parts.push(el(HC.external, esc(badge)));
  return el(HC.head, parts.join(''));
}

/** 一条定义的完整卡片（L3a–L3e + L4/L5/L7）；local 时按最简形态展示。 */
function definitionCard(d: HoverDefinition): string {
  const rows: string[] = [head(d.name, d.kind)];
  if (d.local) {
    rows.push(el(HC.local, '局部'));
    rows.push(locLine(d.location));
    return card(rows);
  }
  // 字段顺序严格按 §3.1：名字+种类 → 容器 → 定义位置 → 分隔线 → 装饰器 → 签名 → 类型 → doc → 引用数
  if (d.containerName) rows.push(el(HC.container, esc(d.containerName)));
  rows.push(locLine(d.location));

  const tail: string[] = [];
  const decorators = (d.decorators ?? []).filter(Boolean);
  if (decorators.length) {
    tail.push(
      el(
        HC.decorators,
        decorators.map((dec) => el(HC.decorator, commandLink(HOVER_CMD_OPEN, targetOf(d.location), dec))).join(''),
      ),
    );
  }
  if (d.signature) tail.push(el(HC.signature, esc(d.signature)));
  const types = (d.types ?? []).filter(Boolean);
  if (types.length) tail.push(el(HC.types, esc(types.join(' · '))));
  const doc = (d.doc ?? []).filter((line) => line.trim().length > 0);
  if (doc.length) tail.push(el(HC.doc, doc.map(esc).join('<br>')));
  if (typeof d.refCount === 'number') {
    // 0 值不给可点入口：没有引用就没有列表可看；缺失则整行不显示（不留空行占位）
    tail.push(
      el(
        HC.refs,
        d.refCount > 0
          ? commandLink(HOVER_CMD_REFS, targetOf(d.location), `引用 ${d.refCount} 处`)
          : `<span class="codicon ${HC.none}">无引用</span>`,
      ),
    );
  }
  if (tail.length) {
    rows.push(el(HC.sep, ''));
    rows.push(...tail);
  }
  return card(rows);
}

/** 同名多定义：全部列出，不替用户猜一个。 */
function multiCard(name: string, defs: HoverDefinition[]): string {
  const rows: string[] = [head(name, defs[0]?.kind)];
  rows.push(el(HC.note, `同名定义 ${defs.length} 处，未替你选择`));
  for (const d of defs) rows.push(locLine(d.location, d.containerName ? `${d.name}（${d.containerName}）` : d.name));
  return card(rows);
}

/** 字面量绑定的种类用词（仅按 symbol kind 直译，不做推断）。 */
const LITERAL_BIND_WORD: Record<string, string> = {
  constant: '常量',
  variable: '变量',
  field: '字段',
  property: '属性',
  parameter: '参数',
};

/** 字面量溯源卡片（§3.3）：回答「这个值是什么、从哪来」。 */
function literalCard(lit: HoverLiteral): string {
  const rows: string[] = [head(`值 ${lit.text}`, null)];
  if (lit.boundTo) {
    const word = LITERAL_BIND_WORD[lit.boundTo.kind] ?? '定义';
    rows.push(el(HC.note, `绑定到${word} ${esc(lit.boundTo.name)}`));
    rows.push(locLine(lit.boundTo.location));
    if (typeof lit.refCount === 'number') {
      rows.push(el(HC.note, lit.refCount > 0 ? `该名字的其他引用 ${lit.refCount} 处` : '无其他引用'));
    }
  } else {
    rows.push(el(HC.note, '字面量，无关联定义'));
  }
  if (typeof lit.sameValueCount === 'number') rows.push(el(HC.note, `同值出现 ${lit.sameValueCount} 处`));
  // L6 keyOf：只陈述「被当作哪个对象的下标键使用」这一事实，不给跳转（契约里没有键的定义位置）
  if (lit.keyOf) rows.push(el(HC.note, `作为 ${esc(lit.keyOf)} 的键使用`));
  return card(rows);
}

/** 失败态（§3.2）：一律收敛成一句人话，不暴露 reason 枚举。 */
function failureCard(res: HoverResult): string | null {
  const name = res.symbol ?? '';
  const defs = res.definitions ?? [];
  switch (res.reason) {
    case 'external':
      return card([
        head(name || null, null, '外部依赖'),
        el(HC.note, '标准库 / 第三方包，不在项目索引内'),
      ]);
    case 'infer-needed': {
      const rows = [
        head(name || null, null, '需类型推断'),
        el(HC.note, esc(res.message ?? '无法确定类型，暂不能定位定义')),
      ];
      // 链头（如 user）仍是确定的事实，给它可点位置
      const chainHead = defs[0];
      if (chainHead) rows.push(locLine(chainHead.location, chainHead.name));
      return card(rows);
    }
    case 'indexing':
      return card([el(HC.note, esc(res.message ?? '索引进行中，符号信息稍后可查'))]);
    case 'unresolved': {
      const rows = [
        head(name || null, null, '未解析'),
        el(HC.note, esc(res.message ?? '未找到定义：可能是运行时注入或未索引文件')),
      ];
      for (const d of defs) rows.push(locLine(d.location, d.containerName ? `${d.name}（${d.containerName}）` : d.name));
      return card(rows);
    }
    default:
      return null;
  }
}

/** 把 HoverResult 渲染成卡片 HTML；返回 null 表示不弹卡片（保持安静）。 */
function hoverCardHtml(res: HoverResult): string | null {
  switch (res.reason) {
    case 'resolved': {
      const defs = res.definitions ?? [];
      if (!defs.length) return null; // 没有任何事实就不弹卡片
      return defs.length > 1 ? multiCard(res.symbol ?? defs[0].name, defs) : definitionCard(defs[0]);
    }
    case 'literal':
      return res.literal ? literalCard(res.literal) : null;
    case 'no-symbol':
      return null;
    default:
      return failureCard(res);
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 解析 command: 链接的载荷（Monaco 会先 decodeURIComponent + JSON.parse 再作为单个参数传入）。 */
function readHoverTarget(arg: unknown): HoverTarget | null {
  let value: unknown = arg;
  if (typeof value === 'string') {
    for (const candidate of [value, safeDecode(value)]) {
      try {
        value = JSON.parse(candidate);
        break;
      } catch {
        /* 换下一种形态再试 */
      }
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const t = value as Partial<HoverTarget>;
  if (typeof t.file !== 'string' || typeof t.line !== 'number' || typeof t.col !== 'number') return null;
  return { file: t.file, line: t.line, col: t.col, endLine: t.endLine, endCol: t.endCol };
}

/** 点「引用 N 处」：定位到定义并触发 Monaco 内置引用查找（找不到编辑器实例就退化为跳定义）。 */
function revealAndFindReferences(target: HoverTarget) {
  if (!ctx.getEditor?.()) {
    ctx.openLocation(target.file, target.line, target.col, target.endLine, target.endCol);
    return;
  }
  let opened = false;
  const attempt = (left: number) => {
    const live = ctx.getEditor?.() ?? null;
    const model = live?.getModel();
    if (live && model && fileOfModel(model) === target.file) {
      const position = {
        lineNumber: Math.min(Math.max(1, target.line), model.getLineCount()),
        column: Math.max(1, target.col),
      };
      live.setPosition(position);
      live.revealPositionInCenterIfOutsideViewport(position, monaco.editor.ScrollType.Smooth);
      live.focus();
      // 必须走 trigger 通道：peek references 这条命令不在 editor 的 action 表里，
      // getAction(...) 恒为 undefined（?. 会静默吞掉，表现为「点了没反应」）。
      live.trigger('keyboard', 'editor.action.referenceSearch.trigger', null);
      return;
    }
    if (!opened) {
      // 定义可能在别的文件：先切过去，model 就绪后再触发引用查找
      ctx.openLocation(target.file, target.line, target.col, target.endLine, target.endCol);
      opened = true;
    }
    if (left > 0) window.setTimeout(() => attempt(left - 1), 100);
  };
  attempt(REFS_RETRY);
}

/** 注册卡片命令，只做一次（Monaco 的命令表是全局的）。 */
let hoverCommandsRegistered = false;

function registerHoverCommands() {
  if (hoverCommandsRegistered) return;
  hoverCommandsRegistered = true;
  monaco.editor.registerCommand(HOVER_CMD_OPEN, (_accessor, arg) => {
    const target = readHoverTarget(arg);
    if (target) ctx.openLocation(target.file, target.line, target.col, target.endLine, target.endCol);
  });
  monaco.editor.registerCommand(HOVER_CMD_REFS, (_accessor, arg) => {
    const target = readHoverTarget(arg);
    if (target) revealAndFindReferences(target);
  });
}

let registered = false;

export function registerCodeProviders() {
  if (registered) return;
  registered = true;

  registerHoverCommands();

  for (const lang of PROVIDER_LANGUAGES) {
    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        if (!ctx.projectId) return null;
        const file = fileOfModel(model);
        const res = await api
          .hover(ctx.projectId, file, position.lineNumber, position.column)
          .catch(() => null);
        // 光标处没有可解释的符号 / 请求失败：不弹卡片，保持安静（§3.1 收敛规则）
        if (!res || res.reason === 'no-symbol') return null;
        const html = hoverCardHtml(res);
        if (!html) return null;
        const word = model.getWordAtPosition(position);
        return {
          contents: [
            {
              value: html,
              supportHtml: true,
              // 只放行卡片自己的两个只读命令，其它 command: 链接无效（卡片无写回入口）
              isTrusted: { enabledCommands: [HOVER_CMD_OPEN, HOVER_CMD_REFS] },
            },
          ],
          // 高亮范围取光标处的词；取不到就退化为光标右侧一个字符
          range: word
            ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
            : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + 1),
        };
      },
    });

    monaco.languages.registerDefinitionProvider(lang, {
      async provideDefinition(model, position) {
        if (!ctx.projectId) return null;
        const file = fileOfModel(model);
        const res = await api
          .gotoDefinition(ctx.projectId, file, position.lineNumber, position.column)
          .catch(() => null);
        if (!res) return null;
        if (!res.locations.length) {
          ctx.onGotoFailed?.({
            kind: 'definition',
            reason: res.reason === 'resolved' ? 'unresolved' : res.reason,
            symbol: res.symbol ?? null,
            external: res.external,
          });
          return null;
        }
        return res.locations.map((loc) => toLocation(loc.file, loc.range));
      },
    });

    monaco.languages.registerReferenceProvider(lang, {
      async provideReferences(model, position) {
        if (!ctx.projectId) return null;
        const file = fileOfModel(model);
        const res = await api
          .findReferences(ctx.projectId, {
            file,
            line: position.lineNumber,
            col: position.column,
            includeDeclaration: true,
          })
          .catch(() => null);
        if (!res) return null;
        if (!res.locations.length) {
          ctx.onGotoFailed?.({
            kind: 'references',
            reason: res.reason === 'resolved' ? 'unresolved' : res.reason,
            symbol: res.symbol ?? null,
          });
          return null;
        }
        return res.locations.map((loc) => toLocation(loc.file, loc.range));
      },
    });
  }

  for (const lang of SYMBOL_LANGUAGES) {
    monaco.languages.registerDocumentSymbolProvider(lang, {
      async provideDocumentSymbols(model) {
        if (!ctx.projectId) return null;
        const file = fileOfModel(model);
        const symbols = await api.documentSymbols(ctx.projectId, file).catch(() => []);
        return symbols.map(toDocumentSymbol);
      },
    });
  }

  // 跨文件跳转：Monaco 打开 wcr:// model 时交给 App 处理
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== MODEL_SCHEME) return false;
      const file = resource.path.replace(/^\//, '');
      let line = 1;
      let col = 1;
      let endLine: number | undefined;
      let endCol: number | undefined;
      if (selectionOrPosition) {
        if ('lineNumber' in selectionOrPosition) {
          line = selectionOrPosition.lineNumber;
          col = selectionOrPosition.column;
        } else {
          line = selectionOrPosition.startLineNumber;
          col = selectionOrPosition.startColumn;
          endLine = selectionOrPosition.endLineNumber;
          endCol = selectionOrPosition.endColumn;
        }
      }
      ctx.openLocation(file, line, col, endLine, endCol);
      return true;
    },
  });

  // 只读阅读器：关掉 TS/JS 语义与语法诊断，避免满屏红波浪线
  const diagnostics = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics);
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(false);
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(false);
  // JSON 同样不诊断：只读阅读器里带注释的 .jsonc / 配置不该满屏报错
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false, allowComments: true });

  // §6：悬停不引入 LSP / TS 语言服务猜类型，只陈述索引里确定的事实。
  // 关掉内置 TS/JS hover，避免同一符号同时出现两份签名（内置的 + 本产品的卡片）。
  // 该 API 没有 getModeConfiguration()：默认值从只读属性 modeConfiguration 读，spread 后再改
  // hovers（注意字段名是 hovers 不是 hover），避免漏字段把补全 / 重命名等能力一并关掉。
  const tsDefaults = monaco.languages.typescript.typescriptDefaults;
  const jsDefaults = monaco.languages.typescript.javascriptDefaults;
  tsDefaults.setModeConfiguration({ ...tsDefaults.modeConfiguration, hovers: false });
  jsDefaults.setModeConfiguration({ ...jsDefaults.modeConfiguration, hovers: false });
}

// ------------------------------------------------------------------ N25 正文可点击

/**
 * 形如 `src/api/client.ts` 或 `src/api/client.ts:42` 的候选（至少一段目录 + 扩展名）。
 * 注意捕获组：1=路径，2=可选行号。
 */
const PATH_RE = /(?:^|[\s'"`(\[@])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+)(?::(\d+))?/g;
/** 反引号里的符号名。 */
const SYMBOL_RE = /`([A-Za-z_][\w.$]*)`/g;
const MAX_LINKS = 200;
const MAX_SCAN_LINES = 20000;

/** 正文链接的载体 URL（点击由 link opener 解析回「文件 + 行 + 列」）。 */
function linkUrlFor(file: string, line: number, col = 1): string {
  return `${MODEL_SCHEME}:///${file}?line=${line}&col=${col}`;
}

/**
 * 正文里的符号名 / 文件路径可点击（N25）。
 * - 路径：必须先经 ctx.fileExists 校验存在（误跳比不可点更伤信任）；
 * - 符号名：只用 goto-definition 的 reason=resolved 给链接，不猜。
 */
export function registerLinkProviders() {
  // 点击由 link opener 接住（url 只是载体，不真的导航到该地址）
  monaco.editor.registerLinkOpener({
    open(resource: monaco.Uri): boolean {
      if (resource.scheme !== MODEL_SCHEME) return false;
      const path = resource.path.replace(/^\//, '');
      const params = new URLSearchParams(resource.query);
      const line = Number(params.get('line') ?? 1) || 1;
      const col = Number(params.get('col') ?? 1) || 1;
      if (!path) return false;
      ctx.openLocation(path, line, col);
      return true;
    },
  });

  for (const lang of PROVIDER_LANGUAGES) {
    monaco.languages.registerLinkProvider(lang, {
      async provideLinks(model, token) {
        if (!ctx.projectId) return null;
        const lineCount = Math.min(model.getLineCount(), MAX_SCAN_LINES);
        const links: monaco.languages.ILink[] = [];
        const symbolCandidates: Array<{ name: string; range: monaco.Range }> = [];
        const file = fileOfModel(model);

        for (let lineNo = 1; lineNo <= lineCount; lineNo++) {
          const text = model.getLineContent(lineNo);
          PATH_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = PATH_RE.exec(text)) !== null) {
            const raw = m[1];
            const line = m[2] ? Number(m[2]) : 1;
            if (!ctx.fileExists?.(raw)) continue; // 校验失败当普通文本，不给点击态
            const tokenText = m[2] ? `${raw}:${m[2]}` : raw;
            const start = m.index + m[0].length - tokenText.length;
            links.push({
              range: new monaco.Range(lineNo, start + 1, lineNo, start + raw.length + 1),
              url: linkUrlFor(raw, line),
              tooltip: `打开 ${raw}${m[2] ? ` 第 ${line} 行` : ''}`,
            });
            if (links.length >= MAX_LINKS) break;
          }
          SYMBOL_RE.lastIndex = 0;
          while ((m = SYMBOL_RE.exec(text)) !== null) {
            const name = m[1];
            if (name.includes('/')) continue;
            const start = m.index + 1;
            symbolCandidates.push({ name, range: new monaco.Range(lineNo, start + 1, lineNo, start + name.length + 1) });
          }
          if (links.length >= MAX_LINKS) break;
        }

        // 反引号符号名：只为「真能解析到定义」的给链接（最多 30 个候选，避免拖慢悬停）
        for (const cand of symbolCandidates.slice(0, 30)) {
          if (token.isCancellationRequested) break;
          const res = await api
            .gotoDefinition(ctx.projectId, file, cand.range.startLineNumber, cand.range.startColumn)
            .catch(() => null);
          if (!res || res.reason !== 'resolved' || !res.locations.length) continue;
          const loc = res.locations[0];
          links.push({
            range: cand.range,
            url: linkUrlFor(loc.file, loc.range.start.line, loc.range.start.col),
            tooltip: `跳到 ${loc.file}:${loc.range.start.line}`,
          });
        }

        if (!links.length) return null;
        return { links };
      },
    });
  }
}

export { monaco };

// 供调试与宿主集成使用（不参与业务逻辑）
(window as unknown as { __wcrMonaco?: typeof monaco }).__wcrMonaco = monaco;
