/** 索引内部数据模型（不出现在 HTTP 契约里）。 */
import type { IndexStatus, LangId, Range, SymbolKind } from '../types';

export type ScopeKind = 'file' | 'module' | 'namespace' | 'class' | 'function' | 'block';

export interface ScopeRecord {
  id: string;
  file: string;
  parent: string | null;
  kind: ScopeKind;
  /** 该作用域绑定的名字（函数名 / 类名），文件作用域为 null。 */
  name: string | null;
  range: Range;
}

/** 显式声明的继承 / 实现 / 嵌入（N17，只读 AST，不做类型推断）。 */
export interface BaseInfo {
  /** 源码里写的基名（泛型参数已丢弃），如 `Base`、`mixins.M`。 */
  name: string;
  kind: 'extends' | 'implements' | 'embeds';
}

export interface DefRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  /** 整个声明节点的范围。 */
  range: Range;
  /** 名字标识符自身的范围。 */
  nameRange: Range;
  scopeId: string;
  /** 所在类 / 外层函数名。 */
  containerName: string | null;
  /** 声明首行（签名），用于展示。 */
  detail: string | null;
  /** 函数内局部变量 / 参数（不上 workspace 符号列表）。 */
  local: boolean;
  /** 该定义自身引入的 body 作用域（类的成员、函数的局部都挂在这里）。 */
  bodyScopeId: string | null;
  /** 声明上的装饰器 / 注解原文（L7），如 `["@cache"]`；无则为 undefined。 */
  decorators?: string[];
  /** 声明的解释性文本（L4）：docstring 或紧邻注释，已按行拆分与截断。 */
  doc?: string[] | null;
  /** 显式声明的基类 / 接口（N17）；无则 undefined。 */
  bases?: BaseInfo[];
}

/** 字面量（L6）：值溯源的最小事实单元。 */
export interface LitRecord {
  /** 源码原文（字符串含引号）。 */
  text: string;
  kind: 'number' | 'string' | 'other';
  file: string;
  range: Range;
  /** 直接绑定的定义 id（该字面量恰是它的 value / right）；无绑定为 null。 */
  boundDefId?: string | null;
  /** 该字面量作为下标 / 元素访问的键时，被索引对象的文本（如 `cfg["k"]` 的 `cfg`）；否则 null。 */
  keyOf?: string | null;
}

export type RefKind = 'identifier' | 'member' | 'type' | 'import';

export interface RefRecord {
  name: string;
  kind: RefKind;
  file: string;
  range: Range;
  scopeId: string;
  /** 成员访问的完整链，如 `os.path.join`；非成员访问为 undefined。 */
  memberParts?: string[];
  /** 原始文本（成员访问用整链文本）。 */
  text: string;
  /** 解析结果缓存：定义 id / 模块文件 / null(未解析)。 */
  resolved?: Resolved;
}

export interface ImportRecord {
  /** 本文件里绑定的名字。 */
  localName: string;
  /** 源码里写的模块说明符。 */
  module: string;
  /** named/default 导入的原始成员名。 */
  importedName?: string;
  kind: 'module' | 'namespace' | 'named' | 'default' | 'star';
  file: string;
  scopeId: string;
  /** 导入语句里该绑定名的位置（find-references 要报这里）。 */
  range: Range;
  /** 解析出的模块文件（缓存）。 */
  resolvedFile?: string | null;
}

export interface FileSymbols {
  scopes: Map<string, ScopeRecord>;
  definitions: DefRecord[];
  references: RefRecord[];
  imports: ImportRecord[];
}

export interface FileIndex extends FileSymbols {
  /** 相对项目根的 POSIX 路径。 */
  file: string;
  lang: LangId;
  source: string;
  text: SourceTextLike;
  tree: unknown;
  /** 本文件里的字面量（L6），按源码顺序。 */
  literals: LitRecord[];
  defsByScope: Map<string, Map<string, DefRecord[]>>;
  importsByScope: Map<string, Map<string, ImportRecord>>;
  /** 解析 <file> 时用到的语言语法包的额外元数据（包名 / module path 等）。 */
  meta: Record<string, string>;
  mtimeMs: number;
  size: number;
  /** true=已解析进索引；false=只读了正文（过大 / 解析失败 / 非源码）。 */
  indexed: boolean;
  /** 解析期间产生的可见错误。 */
  error?: string | null;
  /** 正文实际使用的编码（P12），未进索引的文件为 undefined。 */
  encoding?: string;
  /**
   * 降级索引（P11 / Q12）：`top-level` = 只保留顶层定义与导入，
   * 引用 / 字面量 / 嵌套定义都丢弃。null / undefined = 完整索引。
   */
  degraded?: 'top-level' | null;
}

/**
 * 解析结果的纯数据形态（P5）：worker 线程无法回传 SourceText 实例与 AST tree，
 * 因此跨线程只传这部分，主线程再补齐 `source` / `text` / `tree`。
 */
export interface SerializedParsed {
  file: string;
  lang: LangId;
  scopes: ScopeRecord[];
  definitions: DefRecord[];
  references: RefRecord[];
  imports: ImportRecord[];
  literals: LitRecord[];
  defsByScope: Record<string, Record<string, DefRecord[]>>;
  importsByScope: Record<string, Record<string, ImportRecord>>;
  meta: Record<string, string>;
  mtimeMs: number;
  size: number;
  indexed: boolean;
  error: string | null;
  degraded?: 'top-level' | null;
}

/** 只需要用到 SourceText 的一部分能力，抽出来便于测试替身。 */
export interface SourceTextLike {
  readonly source: string;
  lineText(line: number): string;
  charColToByteCol(line: number, col: number): number;
  byteColToCharCol(line: number, byteCol: number): number;
  offset(line: number, col: number): number;
  position(offset: number): { line: number; col: number };
}

/** 解析目标：定义 / 模块文件。 */
export type Resolved =
  | { kind: 'def'; file: string; def: DefRecord }
  | { kind: 'module'; file: string }
  | { kind: 'external' };

export interface ProjectFiles {
  files: Map<string, FileIndex>;
  /** 名字 → 定义（跨文件，用于 find-references 的候选筛选与符号搜索）。 */
  defsByName: Map<string, DefRecord[]>;
  /** 名字 → 引用位置（跨文件，同上）。 */
  refsByName: Map<string, Array<{ file: string; ref: RefRecord }>>;
  /** language id → 文件数。 */
  langStats: Record<string, number>;
}

export interface ProjectState extends ProjectFiles {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  status: IndexStatus;
}
