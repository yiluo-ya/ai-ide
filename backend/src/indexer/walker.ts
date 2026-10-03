/**
 * 通用 AST 遍历器：各语言模块只提供「哪些节点开作用域 / 哪些节点是定义 / 哪些是引用 / 怎么解析模块」，
 * 遍历、作用域链、坐标换算由这里统一完成。
 */
import type { LangId, Range, SymbolKind } from '../types';
import type {
  BaseInfo,
  DefRecord,
  ImportRecord,
  LitRecord,
  RefRecord,
  ScopeKind,
  ScopeRecord,
  SourceTextLike,
} from './model';

export type { BaseInfo };

export interface ScopeRule {
  kind: ScopeKind;
  /** 绑定名字的字段名（按顺序取第一个命中的）。 */
  nameFields?: string[];
  /** 若设置，就在父作用域里注册这个名字为一个定义。 */
  defKind?: SymbolKind;
  /** 匿名作用域的固定名字（如 lambda）。 */
  fixedName?: string;
  /** 形参所在字段（进入该作用域后交给 spec.params 处理）。 */
  paramFields?: string[];
  /** 该定义在父作用域里是否算「局部」（默认按所在作用域推断）。 */
  local?: boolean;
  /** 定义节点的 detail（签名首行）覆盖。 */
  detail?: 'first-line' | 'none';
}

export type NodeHandler = (node: any, ctx: WalkContext) => void | boolean;

/** 装饰器 / 注解（L7）：原文与所在行（无需列，仅用于「上方紧邻注释」的归属）。 */
export interface DecoratorInfo {
  text: string;
  startLine: number;
  endLine: number;
}

/** 模块解析候选：文件 / 包目录 / 类名。 */
export interface ModuleCandidate {
  path: string;
  kind: 'file' | 'dir' | 'class';
}

export interface ModuleHint {
  /** 项目里是否存在该相对路径。 */
  exists(relPath: string): boolean;
  /** 项目里所有文件（相对路径）。 */
  files(): Iterable<string>;
  /** 类名 → 文件（Java 用）。 */
  classFiles(className: string): string[];
  /** 项目级元数据（如 go.mod 的 module path）。 */
  projectMeta: Record<string, string>;
}

/**
 * 行式格式（Dockerfile / ini / env / conf / SQL）扫出的一个顶层符号。
 * 这些格式没有可用的 tree-sitter 语法包，只能按行做只读语法扫描。
 */
export interface LineSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based 行号。 */
  line: number;
  /** 1-based 列（UTF-16 code unit）。 */
  col: number;
  /** 名字结束列（不含）；缺省按名字长度算。 */
  endCol?: number;
  /** 展示用的一行说明（缺省取该行正文）。 */
  detail?: string | null;
}

export interface LanguageSpec {
  id: LangId;
  label: string;
  /** 小写扩展名，含点。 */
  extensions: string[];
  /** 没有扩展名的固定文件名（小写），如 Dockerfile、.env。 */
  filenames?: string[];
  /** tree-sitter 语法；行式格式（lineSymbols）不需要。 */
  grammar?: unknown;
  /** 行式格式的符号扫描（与 grammar 二选一）。 */
  lineSymbols?: (source: string) => LineSymbol[];
  /** node.type → 作用域规则。 */
  scopes: Record<string, ScopeRule>;
  /** node.type → 处理器（返回 true 表示已完全处理，不再自动遍历子节点）。 */
  handlers: Record<string, NodeHandler>;
  /** 默认视为引用的节点类型。 */
  identifierTypes: string[];
  /** 进一步过滤（默认全部通过）。 */
  isReference?: (node: any, ctx: WalkContext) => boolean;
  builtins?: Set<string>;
  /** 模块说明符 → 候选路径；null 表示外部依赖。 */
  resolveModule?: (
    specifier: string,
    fromFile: string,
    hint: ModuleHint,
  ) => ModuleCandidate[] | null;
  /** 由文件路径反推模块说明符（Python 用于「成员其实是子模块」的回退）。 */
  moduleSpecifierOf?: (relFile: string) => string | null;
  /** 解析文件级元数据（go 包名 / java package）。 */
  fileMeta?: (root: any, ctx: WalkContext) => void;
  /** 形参节点处理（配合 ScopeRule.paramFields）。 */
  params?: (node: any, ctx: WalkContext) => void;
  /** import 的成员名就是类名，按「类名 → 文件」解析（Java）。 */
  classBasedImports?: boolean;
  /** 同包 / 同目录隐式可见（Go 没有 per-symbol import），返回候选文件。 */
  siblings?: (fromFile: string, hint: ModuleHint) => string[];
  /** 注释节点类型（L4：doc 提取）。 */
  commentTypes?: string[];
  /** 字面量节点类型 → 类别（L6）。 */
  literalTypes?: Record<string, 'number' | 'string' | 'other'>;
  /** 字面量绑定的「值位置」容器：节点类型 → 承载值的字段名（L6）。 */
  valueContainers?: Record<string, string[]>;
  /** 下标 / 元素访问节点：节点类型 → 对象与键的字段名（L6 配置键溯源）。 */
  indexAccess?: Record<string, { object: string; key: string }>;
  /** 定义节点（或其父节点）上的装饰器 / 注解原文（L7）。 */
  decoratorsOf?: (node: any) => DecoratorInfo[] | null;
  /** 语言原生 docstring（如 Python 函数 / 类体的首个字符串），返回原文或 null（L4a）。 */
  docstringOf?: (node: any) => string | null;
  /**
   * 显式声明的基类 / 接口 / 嵌入字段（N17）。
   * 只读 AST 语法，不做类型推断：泛型参数、条件类型、动态注册一律不覆盖。
   */
  basesOf?: (node: any) => BaseInfo[] | null;
}

/** doc 收敛：最多 6 行，每行不超过 200 字符（L4）。 */
const MAX_DOC_LINES = 6;
const MAX_DOC_LINE_CHARS = 200;

/** 去掉注释标记、按行拆分（`//`、`#`、块注释、JSDoc 的 `*`）。 */
function cleanCommentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((raw) => {
      let t = raw.trim();
      for (let guard = 0; guard < 8; guard++) {
        const before = t;
        if (t.endsWith('*/')) t = t.slice(0, -2).trim();
        if (t.startsWith('/**')) t = t.slice(3).trim();
        else if (t.startsWith('/*')) t = t.slice(2).trim();
        else if (t.startsWith('//')) t = t.slice(2).trim();
        else if (t.startsWith('#')) t = t.slice(1).trim();
        else if (t.startsWith('*')) t = t.slice(1).trim();
        if (t === before) break;
      }
      return t;
    })
    .filter((l) => l.length > 0);
}

function truncateDoc(lines: string[]): string[] {
  const kept = lines.slice(0, MAX_DOC_LINES);
  if (lines.length > MAX_DOC_LINES && kept.length) kept[kept.length - 1] += '...';
  return kept.map((l) =>
    l.length > MAX_DOC_LINE_CHARS ? `${l.slice(0, MAX_DOC_LINE_CHARS - 3)}...` : l,
  );
}

const nodeKey = (node: any): string => `${node.type}#${node.startIndex}-${node.endIndex}`;

/** 值位置上的「直接值」：字面量本身，或 Go 的 expression_list / 括号表达式。 */
const isDirectValue = (child: any, node: any): boolean =>
  sameNode(child, node) ||
  child.type === 'expression_list' ||
  child.type === 'parenthesized_expression';

/** 简单标识符 / 成员链（L6）：只由标识符与点组成，调用 / 字面量 / 下标等一律不算。 */
const SIMPLE_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** 签名展示的长度上限（压平与「首行」口径一致）。 */
const MAX_DETAIL_CHARS = 160;

const firstLine = (text: string): string => {
  const line = text.split('\n')[0] ?? '';
  return line.length > MAX_DETAIL_CHARS
    ? `${line.slice(0, MAX_DETAIL_CHARS - 3)}...`
    : line;
};

/** 压平签名时的开 / 闭括号（相邻处不补空格，避免 `f( a` / `b, )` 这类排版噪声）。 */
const OPENERS = '([{<';
const CLOSERS = ')]}>';

/**
 * 压平：换行折成空格（开括号之后、闭括号之前不补空格）、去掉紧邻闭括号的尾逗号，
 * 再压连续空白与截断（L3d）。纯展示层格式化，不改动任何标识符与类型文本。
 */
const flatten = (text: string): string => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let flat = '';
  for (const line of lines) {
    if (!flat) {
      flat = line;
      continue;
    }
    const prev = flat[flat.length - 1];
    flat = OPENERS.includes(prev) || CLOSERS.includes(line[0]) ? `${flat}${line}` : `${flat} ${line}`;
  }
  const one = flat.replace(/\s+/g, ' ').replace(/,\s*([)\]}>])/g, '$1').trim();
  return one.length > MAX_DETAIL_CHARS ? `${one.slice(0, MAX_DETAIL_CHARS - 3)}...` : one;
};

/**
 * 压平签名（L3d）：从声明起点读到签名结束，多行合并为一行。
 * 只用源码文本，不做推断；终止符仅在括号深度 0 且不在字符串内时生效：
 * - `{`：body 开始；`;`：声明式方法 / 接口字段 / `declare`（Java 接口方法、TS `method_signature` 同此）
 * - Python 参数括号闭合后的 `:`（参数区内的 `:` 深度 ≥1，天然排除）
 * 扫不到终止符（异常语法）时返回 null，由调用方退回原有「首行」行为。
 */
export function flattenSignature(source: string, lang: LangId): string | null {
  let depth = 0;
  let quote = '';
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i++;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '(' || ch === '[') {
      depth++;
      out += ch;
      continue;
    }
    if (ch === ')' || ch === ']') {
      if (depth > 0) depth--;
      out += ch;
      continue;
    }
    const terminator = ch === '{' || ch === ';' || (ch === ':' && lang === 'python');
    if (depth === 0 && terminator) return flatten(out);
    out += ch;
  }
  return null;
}

/** 同一棵 tree-sitter 树里，起始/结束偏移与类型一致即为同一节点（包装对象不共享引用）。 */
export const sameNode = (a: any, b: any): boolean =>
  a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;

export class WalkContext {
  readonly file: string;
  readonly text: SourceTextLike;
  readonly spec: LanguageSpec;
  readonly scopes = new Map<string, ScopeRecord>();
  readonly definitions: DefRecord[] = [];
  readonly references: RefRecord[] = [];
  readonly imports: ImportRecord[] = [];
  /** 本文件的字面量（L6），按源码顺序。 */
  readonly literals: LitRecord[] = [];
  readonly meta: Record<string, string> = {};
  private stack: ScopeRecord[] = [];
  private counter = 0;
  /** 收集到的注释块（用于「声明上方紧邻注释」的归属）。 */
  private comments: Array<{ startLine: number; endLine: number; lines: string[] }> = [];
  /** 装饰器 / 注解占用的行区间（跳过它继续向上找注释）。 */
  private decoratorLines: Array<[number, number]> = [];
  /** 定义节点 → 定义记录（字面量绑定用）。 */
  private defByNodeKey = new Map<string, DefRecord>();
  /**
   * 大文件降级（P11）：只登记顶层定义与导入，不记引用 / 字面量 / 注释。
   * 引用与字面量是遍历成本的大头，跳过它们让 1MB 级文件的解析成本可控。
   */
  readonly topLevelOnly: boolean;

  constructor(file: string, text: SourceTextLike, spec: LanguageSpec, opts?: { topLevelOnly?: boolean }) {
    this.file = file;
    this.text = text;
    this.spec = spec;
    this.topLevelOnly = opts?.topLevelOnly === true;
  }

  get scope(): ScopeRecord {
    return this.stack[this.stack.length - 1];
  }

  rangeOf(node: any): Range {
    const s = node.startPosition;
    const e = node.endPosition;
    return {
      start: { line: s.row + 1, col: this.text.byteColToCharCol(s.row + 1, s.column) },
      end: { line: e.row + 1, col: this.text.byteColToCharCol(e.row + 1, e.column) },
    };
  }

  /** 进入文件作用域并遍历整棵树。 */
  run(rootNode: any) {
    const fileScope: ScopeRecord = {
      id: `${this.file}#s0`,
      file: this.file,
      parent: null,
      kind: 'file',
      name: null,
      range: this.rangeOf(rootNode),
    };
    this.scopes.set(fileScope.id, fileScope);
    this.stack.push(fileScope);
    this.spec.fileMeta?.(rootNode, this);
    this.walkChildren(rootNode);
    this.stack.pop();
  }

  containerName(): string | null {
    return this.containerNameOf(this.scope);
  }

  /** 从指定作用域向上找第一个有名字的作用域（类名 / 函数名）。 */
  containerNameOf(scope: ScopeRecord | null): string | null {
    let cursor = scope;
    while (cursor) {
      if (cursor.name) return cursor.name;
      cursor = cursor.parent ? this.scopes.get(cursor.parent) ?? null : null;
    }
    return null;
  }

  /** 向上找最近的某类作用域。 */
  enclosing(kinds: ScopeKind[]): ScopeRecord | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (kinds.includes(this.stack[i].kind)) return this.stack[i];
    }
    return null;
  }

  enterScope(node: any, rule: ScopeRule, name: string | null): ScopeRecord {
    this.counter++;
    const scope: ScopeRecord = {
      id: `${this.file}#s${this.counter}`,
      file: this.file,
      parent: this.scope ? this.scope.id : null,
      kind: rule.kind,
      name,
      range: this.rangeOf(node),
    };
    this.scopes.set(scope.id, scope);
    this.stack.push(scope);
    return scope;
  }

  exitScope() {
    this.stack.pop();
  }

  define(
    node: any,
    opts: {
      name?: string | null;
      nameNode?: any;
      kind: SymbolKind;
      local?: boolean;
      detail?: string | null;
      nameRange?: Range;
    },
  ): DefRecord | null {
    return this.defineIn(this.scope, node, opts);
  }

  /** 在指定作用域里登记定义（如 Python 的 `self.x = ...` 要落到类作用域）。 */
  defineIn(
    scope: ScopeRecord | null,
    node: any,
    opts: {
      name?: string | null;
      nameNode?: any;
      kind: SymbolKind;
      local?: boolean;
      detail?: string | null;
      nameRange?: Range;
    },
  ): DefRecord | null {
    const name = opts.name ?? opts.nameNode?.text ?? '';
    if (!name || !scope) return null;
    if (this.topLevelOnly && scope.id !== `${this.file}#s0`) return null;
    const nameRange = opts.nameRange ?? (opts.nameNode ? this.rangeOf(opts.nameNode) : this.rangeOf(node));
    const local =
      opts.local ??
      (scope.kind === 'function' || scope.kind === 'block' || scope.kind === 'namespace');
    const decorators = this.spec.decoratorsOf?.(node) ?? null;
    const def: DefRecord = {
      id: `${this.file}!${nameRange.start.line}:${nameRange.start.col}:${name}`,
      name,
      kind: opts.kind,
      file: this.file,
      range: this.rangeOf(node),
      nameRange,
      scopeId: scope.id,
      containerName: this.containerNameOf(scope),
      detail: opts.detail === undefined ? this.detailOf(node, decorators) : opts.detail,
      local,
      bodyScopeId: null,
      decorators: decorators?.length ? decorators.map((d) => d.text) : undefined,
      doc: null,
    };
    if (decorators?.length) {
      for (const d of decorators) this.decoratorLines.push([d.startLine, d.endLine]);
    }
    const bases = this.spec.basesOf?.(node) ?? null;
    if (bases?.length) def.bases = bases;
    // 局部变量密度高，不给 doc（宁可不给，也不误导）
    if (!local) def.doc = this.docFor(node);
    this.defByNodeKey.set(nodeKey(node), def);
    this.definitions.push(def);
    return def;
  }

  /** 声明签名：跳过装饰器 / 注解自己占用的行，再把多行签名压平为一行（L3d）。 */
  private detailOf(node: any, decorators: DecoratorInfo[] | null): string {
    const { text, first } = this.signatureBody(node, decorators);
    return flattenSignature(text, this.spec.id) ?? first;
  }

  /** 声明起点起的文本（已跳过装饰器 / 注解行）与原有「首行」结果（压平失败时保底）。 */
  private signatureBody(
    node: any,
    decorators: DecoratorInfo[] | null,
  ): { text: string; first: string } {
    const raw = String(node.text ?? '');
    if (!decorators?.length) return { text: raw, first: firstLine(raw) };
    const nodeStart = (node.startPosition?.row ?? 0) + 1;
    const skip = Math.max(...decorators.map((d) => d.endLine - nodeStart + 1));
    if (skip <= 0) return { text: raw, first: firstLine(raw) };
    const lines = raw.split('\n').slice(skip);
    const idx = lines.findIndex((l) => l.trim().length > 0);
    const text = idx < 0 ? '' : lines.slice(idx).join('\n');
    return { text, first: firstLine((lines[idx] ?? '').trim()) };
  }

  /** 声明的解释性文本：语言原生 docstring 优先，其次紧邻注释（L4）。 */
  private docFor(node: any): string[] | null {
    const raw = this.spec.docstringOf?.(node);
    if (raw) {
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length) return truncateDoc(lines);
    }
    return this.commentAbove(this.rangeOf(node).start.line);
  }

  /** 声明上方紧邻的连续注释块；中间只允许隔装饰器 / 注解行，空行即断。 */
  private commentAbove(startLine: number): string[] | null {
    const blocks: Array<{ startLine: number; endLine: number; lines: string[] }> = [];
    let line = startLine;
    for (let guard = 0; guard < 64; guard++) {
      const prev = line - 1;
      if (prev < 1) break;
      const deco = this.decoratorLines.find(([s, e]) => prev >= s && prev <= e);
      if (deco) {
        line = deco[0];
        continue;
      }
      const block = this.comments.find((c) => c.endLine === prev);
      if (!block) break;
      blocks.unshift(block);
      line = block.startLine;
    }
    const lines = blocks.flatMap((b) => b.lines);
    return lines.length ? truncateDoc(lines) : null;
  }

  private addComment(node: any) {
    if (this.topLevelOnly) return;
    const range = this.rangeOf(node);
    this.comments.push({
      startLine: range.start.line,
      endLine: range.end.line,
      lines: cleanCommentLines(node.text ?? ''),
    });
  }

  private addLiteral(node: any, kind: 'number' | 'string' | 'other') {
    if (this.topLevelOnly) return;
    const bound = this.literalBinder(node);
    this.literals.push({
      text: node.text,
      kind,
      file: this.file,
      range: this.rangeOf(node),
      boundDefId: bound ? bound.id : null,
      keyOf: this.keyObjectOf(node),
    });
  }

  /**
   * 字面量恰是下标 / 元素访问的键时，返回被索引对象的文本（L6，如 `cfg["k"]` → `cfg`）。
   * 对象只认简单标识符或成员链；调用 / 字面量 / 嵌套下标等复杂表达式一律不给（宁可不给，别编）。
   */
  private keyObjectOf(node: any): string | null {
    const access = this.spec.indexAccess;
    const parent = node.parent;
    if (!access || !parent) return null;
    const shape = access[parent.type];
    if (!shape) return null;
    const key = parent.childForFieldName?.(shape.key);
    if (!key || !sameNode(key, node)) return null;
    const object = parent.childForFieldName?.(shape.object);
    if (!object) return null;
    const text = String(object.text ?? '');
    return SIMPLE_CHAIN.test(text) ? text : null;
  }

  /** 字面量恰好是某声明的 value / right 时绑定到它；调用实参里的字面量（如 `foo(60)`）不绑定。 */
  private literalBinder(node: any): DefRecord | null {
    const containers = this.spec.valueContainers;
    if (!containers) return null;
    let child = node;
    let cur = node.parent;
    for (let hops = 0; cur && hops < 3; hops++) {
      const fields = containers[cur.type];
      if (fields) {
        for (const f of fields) {
          const v = cur.childForFieldName?.(f);
          if (v && sameNode(v, child) && isDirectValue(child, node)) {
            return this.firstDefInside(cur);
          }
        }
        return null;
      }
      child = cur;
      cur = cur.parent;
    }
    return null;
  }

  /** 声明节点子树里登记的第一个定义（`const a = 1` 的名字挂在 name 节点上）。 */
  private firstDefInside(node: any): DefRecord | null {
    const direct = this.defByNodeKey.get(nodeKey(node));
    if (direct) return direct;
    for (const c of node.namedChildren as any[]) {
      const found = this.firstDefInside(c);
      if (found) return found;
    }
    return null;
  }

  addRef(
    node: any,
    opts: {
      name?: string;
      parts?: string[] | null;
      kind?: RefRecord['kind'];
      rangeNode?: any;
      text?: string;
    } = {},
  ): RefRecord | null {
    if (this.topLevelOnly) return null;
    const parts = opts.parts && opts.parts.length > 1 ? opts.parts : null;
    const name = opts.name ?? (parts ? parts[parts.length - 1] : node.text);
    const ref: RefRecord = {
      name,
      kind: opts.kind ?? (parts ? 'member' : 'identifier'),
      file: this.file,
      range: this.rangeOf(opts.rangeNode ?? node),
      scopeId: this.scope.id,
      memberParts: parts ?? undefined,
      text: opts.text ?? node.text,
    };
    this.references.push(ref);
    return ref;
  }

  addImport(rec: Omit<ImportRecord, 'file' | 'scopeId'>) {
    this.imports.push({ ...rec, file: this.file, scopeId: this.scope.id });
  }

  walk(node: any) {
    const spec = this.spec;
    if (spec.commentTypes?.includes(node.type)) {
      this.addComment(node);
      return;
    }
    const literalKind = spec.literalTypes?.[node.type];
    if (literalKind) {
      this.addLiteral(node, literalKind);
      // 继续往下走：`f"{cfg['k']} {user.name}"` 这类字符串里嵌着真正的代码
      // （键字符串、变量引用都要能被索引）；普通字符串没有子结构，遍历无副作用。
      this.walkChildren(node);
      return;
    }
    const handler = spec.handlers[node.type];
    if (handler) {
      const handled = handler(node, this);
      if (handled === true) return;
    }
    const rule = spec.scopes[node.type];
    if (rule) {
      const nameNode = this.nameNodeOf(node, rule);
      let def: DefRecord | null = null;
      if (rule.defKind) {
        def = this.define(node, {
          nameNode,
          name: nameNode ? undefined : rule.fixedName,
          kind: rule.defKind,
          local: rule.local,
          detail: rule.detail === 'none' ? null : undefined,
        });
      }
      const scope = this.enterScope(node, rule, nameNode?.text ?? rule.fixedName ?? null);
      if (def) def.bodyScopeId = scope.id;
      const skip: any[] = nameNode ? [nameNode] : [];
      if (rule.paramFields) {
        for (const f of rule.paramFields) {
          const p = node.childForFieldName?.(f);
          if (!p) continue;
          skip.push(p);
          if (spec.params) spec.params(p, this);
          else this.walk(p);
        }
      }
      this.walkChildren(node, skip);
      this.exitScope();
      return;
    }
    if (spec.identifierTypes.includes(node.type)) {
      if (!spec.isReference || spec.isReference(node, this)) {
        this.addRef(node, node.type === 'type_identifier' ? { kind: 'type' } : {});
      }
      return;
    }
    this.walkChildren(node);
  }

  walkChildren(node: any, skip?: any[]) {
    const skipped = skip && skip.length ? skip : null;
    for (const child of node.namedChildren as any[]) {
      if (skipped && skipped.some((s) => sameNode(s, child))) continue;
      this.walk(child);
    }
  }

  nameNodeOf(node: any, rule: ScopeRule): any {
    if (!rule.nameFields) return null;
    for (const f of rule.nameFields) {
      const c = node.childForFieldName?.(f);
      if (c) return c;
    }
    return null;
  }
}
