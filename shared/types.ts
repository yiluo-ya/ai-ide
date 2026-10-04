/**
 * 前后端共享的 API 契约。
 *
 * 坐标约定（FR-0002 §9.1）：位置一律 1-based、列为 UTF-16 code unit 数，
 * 与 Monaco 的 `position.column` 完全一致；后端内部用 tree-sitter 的字节列时自行换算。
 */

export type LangId =
  | 'python'
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'go'
  | 'java'
  | 'rust'
  // 常用文件（2026-10-03）：shell / 数据配置 / 标记 / 样式 / SQL
  | 'shell'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'ini'
  | 'dockerfile'
  | 'markdown'
  | 'css'
  | 'scss'
  | 'less'
  | 'html'
  | 'sql'
  // 包依赖 / 构建清单（2026-10-03）：只高亮与预览，不进符号索引
  | 'xml'
  | 'gomod'
  | 'groovy'
  | 'kotlin'
  | 'scala'
  | 'ruby'
  | 'elixir'
  | 'swift'
  | 'pip'
  | 'makefile'
  | 'plaintext';

/** 位置：行、列均 1-based，列按 UTF-16 code unit 计。 */
export interface Position {
  line: number;
  col: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** 项目内相对路径的定位。 */
export interface Location {
  file: string;
  range: Range;
}

export type SymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'package'
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'enumMember'
  | 'type'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'parameter'
  | 'import'
  | 'unknown';

/** 符号信息（document-symbols / workspace-symbols 共用）。 */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** 名字标识符的位置（Monaco 的 selectionRange）。 */
  location: Location;
  /** 整个声明的位置（Monaco 的 range），缺省时退化为 location.range。 */
  range?: Range;
  /** 所属类 / 模块名，用于列表分组与面包屑。 */
  containerName?: string | null;
  /** 签名或声明首行的简短展示文本。 */
  detail?: string | null;
  /** 定义在测试文件里（N8 标注）；未标注 = 非测试。 */
  isTest?: boolean;
  children?: SymbolInfo[];
}

export interface FileNode {
  name: string;
  /** 相对项目根的路径，root 为空串。 */
  path: string;
  type: 'file' | 'directory';
  /** 该目录子树内的文件数（目录）。 */
  count?: number;
  lang?: LangId;
  size?: number;
  /** 二进制 / 资源文件（图片、压缩包…）：文件树里能看见，但不预览。 */
  binary?: boolean;
  /** 是否已进符号索引；false = 非源码 / 被规则忽略 / 过大（点开时给明确理由）。 */
  indexed?: boolean;
  /** 目录的子节点（文件为 undefined）。 */
  children?: FileNode[];
}

/** 服务状态（2026-10-03 命令管理）：命令面板显示它，并据此决定按钮是否可用。 */
export interface ServiceStatus {
  pid: number;
  port: number;
  host: string;
  startedAt: number;
  uptimeMs: number;
  /** 本机模式才允许启停；共享模式下为 false。 */
  manageable: boolean;
  /** 日志文件路径（本服务自己拉起的进程会写这里）。 */
  logPath: string;
  lastAction: { action: string; at: number; detail?: string } | null;
}

/** Code Agent 后端的定位状态（FR-0007）：设置面板显示它，并据此给出安装指引。 */
export interface AgentRuntimeStatus {
  /** 手填的 pi 路径（空 = 走落点与 PATH）。 */
  piPath: string;
  pi: {
    available: boolean;
    /** 命中的是定位链的哪一环（前端按它取 i18n 文案）。 */
    source: 'env' | 'config' | 'agents' | 'path';
    /** 解析到的目标：绝对路径或裸命令名。 */
    label: string;
    /** 该目标是否已确认指向一个存在的文件。 */
    resolved: boolean;
    version?: string;
    error?: string;
  };
  /** 装在哪：落点绝对路径 + 两条可复制的 npm 命令。 */
  hint: { dir: string; globalCommand: string; prefixCommand: string };
  /** 落点根目录（`~/.ide/agents`）。 */
  agentsDir: string;
  /** OpenHands 只留位置，适配器未接入。 */
  openhands: { implemented: boolean; dir: string };
}

// ------------------------------------------------ 项目命令（FR-0005，2026-10-03）

/** 命令的用途分类；四类为主，其余归 other。 */
export type CommandKind = 'build' | 'start' | 'stop' | 'test' | 'other';

/** 命令从哪来：script = 仓库里读到的（note 写出处）；generated = agent 给的建议。 */
export type CommandSource = 'script' | 'generated';

/** 危险级别：warn 要在确认框里额外勾选；block 后端直接拒绝执行。 */
export type CommandRisk = 'none' | 'warn' | 'block';

/** 一条项目命令（agent 分析出来的，或用户手输的自定义命令）。 */
export interface ProjectCommand {
  id: string;
  kind: CommandKind;
  /** 展示名，如「编译前端」。 */
  label: string;
  /** 原样可执行的命令字符串。 */
  command: string;
  source: CommandSource;
  /** 出处（package.json scripts.build）或「生成」的理由。 */
  note?: string;
  /** 建议后台跑（start 类默认 true）。 */
  background?: boolean;
  /** 后端按黑名单标注。 */
  risk?: CommandRisk;
}

/** 一个项目的命令清单（一次分析的结果，落盘保留）。 */
export interface CommandPlan {
  projectId: string;
  createdAt: number;
  /** 用户那次输入的一句话。 */
  prompt: string;
  /** agent 的一句话结论。 */
  summary?: string;
  model?: { provider?: string; modelId?: string } | null;
  /** 想回看分析过程时，去 Agent 面板打开它（内存会话，重启即清）。 */
  sessionId?: string;
  commands: ProjectCommand[];
}

/** 一次命令执行（前台跑完就结束；后台留在运行列表里）。 */
export interface CommandRun {
  id: string;
  projectId: string;
  command: string;
  kind: CommandKind;
  background: boolean;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** lost = 记着但进程已不在（IDE 后端重启过）。 */
  status: 'running' | 'done' | 'failed' | 'stopped' | 'lost';
  /** 后台运行的日志文件。 */
  logPath?: string;
  /** 前台运行的合并输出；后台为空（去读日志）。 */
  output?: string;
}

/**
 * 变更（以 git 为准，2026-10-03 用户要求）：工作区相对 HEAD 的改动清单。
 * 阅读器不再自己记录「阅读基线快照」——git 说改了才算改了。
 */
export interface GitChangeEntry {
  file: string;
  /** 未跟踪的新文件按 added 报（见 gitread.classifyStatus）；被忽略的文件不会出现在清单里。 */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';
  /** 重命名 / 复制时的原路径。 */
  from?: string;
  /** 增删行数；未跟踪文件与二进制为 null（不编 0）。 */
  added: number | null;
  removed: number | null;
  binary: boolean;
  isTest?: boolean;
}

export interface GitChangesResult {
  /** false = 不是 git 仓库（或没装 git），此时 entries 为空，界面如实说明。 */
  isRepo: boolean;
  branch: string | null;
  entries: GitChangeEntry[];
  /** 超过上限被省略的条数。 */
  truncated: number;
}

/**
 * 变更栏上的四个写操作（2026-10-03 用户要求）：只有这四个，没有「任意 git」。
 * git status 是默认的只读展示，不需要点。
 */
export type GitWriteAction = 'add' | 'commit' | 'pull' | 'push';

export interface GitWriteRequest {
  action: GitWriteAction;
  /** action=commit 时的提交说明（空串由后端拒绝）。 */
  message?: string;
}

/** 一次 git 写操作的结果：成功失败都如实回报，界面只负责把 summary 冒泡出来。 */
export interface GitRunResult {
  ok: boolean;
  /** 退出码；git 命令根本没起来（本机没装 git）时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 一句人话（成功 / 失败都能直接显示给用户）。 */
  summary: string;
}

export interface SearchMatch {
  file: string;
  range: Range;
  lineText: string;
  /** 该文件内的序号（0 起）。 */
  index: number;
  /** 命中来自测试文件（N11 的「按测试过滤」）；口径与 01 地图降噪同源。 */
  isTest?: boolean;
}

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** 文件名 glob（如 `*.py`），可选。 */
  filePattern?: string;
  maxResults?: number;
  /** 只在这些相对路径内搜索（可选）。 */
  files?: string[];
  /** 只在这些目录（前缀匹配）内搜索（N14，可选）。 */
  dirs?: string[];
}

export interface SearchResult {
  query: string;
  matches: SearchMatch[];
  fileCount: number;
  truncated: boolean;
}

export interface IndexStatus {
  indexing: boolean;
  /** 已索引（解析成功）的文件数。 */
  filesIndexed: number;
  /** 扫描到的待索引源码文件总数。 */
  filesTotal: number;
  /** 0~1。 */
  progress: number;
  indexedAt: number | null;
  error: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** 本机绝对路径（POSIX 风格分隔符）。 */
  root: string;
  createdAt: number;
  status: IndexStatus;
}

/** 注册（打开）一个本机目录为代码阅读项目 —— 也是留给 xchen 项目列表的接入点。 */
export interface RegisterProjectRequest {
  /** 本机目录绝对路径。 */
  root: string;
  /** 展示名，缺省取目录名。 */
  name?: string;
  /** 指定 id（缺省由 root 派生，同一 root 永远得到同一 id）。 */
  id?: string;
}

export interface GotoDefinitionRequest {
  file: string;
  line: number;
  col: number;
}

export interface DefinitionResult {
  locations: Location[];
  /** 解析结论：resolved=跳到位；external=外部依赖；unresolved=没找到。 */
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  /** 命中的符号名，便于前端提示。 */
  symbol?: string | null;
  /** reason=external 时的来源详情（03-navigator Q1）：模块说明符 + 导入语句位置。 */
  external?: ExternalSource;
  /** reason=unresolved 时的缺失原因（06-platform Q1/Q20）：后端给口径，前端只做文案。 */
  detail?: UnresolvedDetail | null;
}

/**
 * 未解析的具体缺失原因（06-platform Q1：不引入类型推断，但必须说清缺什么）。
 * - needs-type-info：`obj.method()`，`obj` 是局部变量，需类型推断才能确定
 * - dynamic-member：动态属性（`getattr` / `obj[name]` / 计算成员）
 * - module-not-found：说明符解析不到任何项目内文件
 * - not-in-project：指向项目外且不是语言内置 / 已安装依赖
 * - indexing：索引还没跑完（前端优先读 status.indexing，不应显示为「认不出」）
 */
export type UnresolvedDetail =
  | 'needs-type-info'
  | 'dynamic-member'
  | 'module-not-found'
  | 'not-in-project'
  | 'indexing';

/** 外部依赖的来源：模块说明符与导入处（都给不出时 module 为空串）。 */
export interface ExternalSource {
  /** import / from 里写的模块说明符，如 `os`、`react`；语言内置符号为空串。 */
  module: string;
  /** 导入语句里该绑定名的位置，供「跳到 import 行」。 */
  importLocation?: Location;
}

export interface FindReferencesRequest {
  file: string;
  line: number;
  col: number;
  includeDeclaration?: boolean;
}

export interface ReferenceResult {
  locations: ReferenceLocation[];
  symbol?: string | null;
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  /** 符号声明处（N4 的「声明行」标注由后端给出，避免前端猜）。 */
  declaration?: Location | null;
}

/** 一处引用（03-navigator N4）：isTest 由后端标注，前端只渲染。 */
export interface ReferenceLocation extends Location {
  isTest: boolean;
}

// -------------------------------------------------------- 导航（03-navigator）

/** 调用层级方向：in=谁调用我，out=我调用了谁（N16）。 */
export type CallDirection = 'in' | 'out';

export interface CallNode {
  name: string;
  kind: SymbolKind;
  file: string;
  location: Location;
  /** 与父节点之间的调用处数。 */
  callCount: number;
  /** out 方向：外部依赖叶子。 */
  external?: boolean;
  /** out 方向：解析不到的调用（聚合叶子）。 */
  unresolved?: boolean;
  /** 入口候选（判定与 01 地图同源）。 */
  isEntry?: boolean;
  isTest?: boolean;
  children?: CallNode[];
}

export interface CallHierarchyResult {
  direction: CallDirection;
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  symbol: string | null;
  root: CallNode | null;
  /** 诚实上报的覆盖率：已解析 / 未归属 / 外部。 */
  coverage: { resolved: number; unresolved: number; external: number };
  message?: string;
}

/** 类型层级 / 实现清单里的一项（N17 / N15）。 */
export interface TypeNode {
  name: string;
  kind: SymbolKind;
  file: string;
  location: Location;
  relation: 'extends' | 'implements' | 'embeds' | 'overrides';
  isTest?: boolean;
}

export interface TypeHierarchyResult {
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol';
  symbol: string | null;
  kind: SymbolKind | null;
  /** 显式声明的父类 / 接口（能解析到项目内定义的）。 */
  bases: TypeNode[];
  /** 谁显式继承 / 实现了它。 */
  derived: TypeNode[];
  /** 项目内找不到定义的基名（外部依赖或未索引）。 */
  unresolvedBases: string[];
  message?: string;
}

export interface ImplementationsResult {
  reason: 'resolved' | 'external' | 'unresolved' | 'no-symbol' | 'not-applicable';
  symbol: string | null;
  items: TypeNode[];
  message?: string;
}

// ------------------------------------------------------------ 向导（04 Guide · G2）

/** 阅读路线种类：依赖序 / 入口向下 / 热度序 / 新鲜度序（G2.1–G2.4）。 */
export type GuideRouteKind = 'dep' | 'entry' | 'hot' | 'fresh';

/** 路线里的一步：一个文件，外加「为什么是它 / 为什么在这个位置」。 */
export interface GuideRouteStep {
  /** 1-based 序号，即「第几步读」。 */
  order: number;
  /** 相对项目根的 POSIX 路径。 */
  file: string;
  /** 一句人话的理由，如「依赖 src/a.ts（第 1 步，已排在前）」。 */
  reason: string;
  lang: LangId;
  lines: number;
  /** 测试 / 示例文件（判定与 01 地图同源），路线不排除它，只是标出来。 */
  test: boolean;
  /**
   * 建议先看这一行（1-based）：该文件第一个顶层符号的定义行；取不到符号时为 1。
   * 路线只说到「读哪个文件」是不够的 —— 打开一个 800 行的文件，人还得自己找入口。
   */
  line: number;
  /** 关注点：该文件最值得先看的几个顶层符号（名称 + 行 + 种类）。 */
  hints: Array<{ name: string; line: number; kind: string }>;
}

/** 一条阅读路线。 */
export interface GuideRoute {
  kind: GuideRouteKind;
  /** 路线中文名（依赖序 / 入口向下 / 热度序 / 新鲜度序）。 */
  label: string;
  /** 全部步数（截断前）。 */
  total: number;
  /** 是否因步数上限被截断（只返回前 GUIDE_ROUTE_LIMIT 步）。 */
  truncated: boolean;
  steps: GuideRouteStep[];
}

/** 四条路线一次算全的结果。 */
export interface GuideRoutesResult {
  routes: GuideRoute[];
  /** 索引未跑完：结果只基于当前已索引文件，会随后续索引继续长出来（不报错）。 */
  partial: boolean;
  /** 源码文件数（排除测试与文档 / 配置），项目级进度的分母（G3.2）。 */
  sourceFiles: number;
}

// ------------------------------------------------------------ 向导（04 Guide · G6.1）

/** 文件级结构性摘要：只用索引里已有的事实拼装，不调模型。 */
export interface FileSummary {
  /** 本文件的顶层定义（导出候选），按行号升序。 */
  exports: Array<{ name: string; kind: SymbolKind; line: number }>;
  /** 本文件的 import：解析到项目内文件 / 外部的条数。 */
  imports: { project: number; external: number };
  /** 谁引用了本文件（排除自身）：条目总数、按来源文件拆分、其中来自测试的条目数。 */
  inbound: { total: number; files: Array<{ file: string; count: number }>; tests: number };
  /** 本文件引用的项目内文件数（去重）。 */
  outbound: number;
  /** 本文件里最长的一个函数 / 方法有多少行（没有函数为 0）。 */
  longestFunction: number;
  lines: number;
  lang: LangId;
  /** 索引版本（与 highlights / density 同为字符串形态），供前端缓存失效。 */
  revision: string;
  /** 模板化中文摘要句（不使用模型），如「导出 3 个符号（2 类 1 函数），依赖 4 个项目内模块…」。 */
  sentence: string;
}

export interface ApiError {
  error: string;
  message: string;
}

/** SSE 推送事件（/api/projects/:id/events）。 */
export type IndexEvent =
  | { type: 'status'; status: IndexStatus }
  | { type: 'file-changed'; file: string }
  | { type: 'file-deleted'; file: string }
  | { type: 'index-ready'; status: IndexStatus };

/**
 * 语义着色：区分「本项目符号」与「外部依赖 / 标准库符号」，供编辑器提亮 / 压暗。
 * 只标注能判定的符号；无法判定的（通常是需要类型推断的 obj.method）不出现在结果里，
 * 保持编辑器自身的语法色。
 */
export interface HighlightResult {
  file: string;
  /** 每 4 个一组：[line(1-based), col(1-based), length(UTF-16), kindIndex]，按位置升序。 */
  data: number[];
  /** kindIndex 的含义：0=本项目；1=外部依赖/标准库；2=局部变量/参数。 */
  kinds: ['project', 'external', 'local'];
  /** 索引版本，供前端缓存失效。 */
  revision: string;
}

// ---------------------------------------------------------------- 透镜（悬停）

/**
 * 悬停解释（02-lens）：只陈述索引里确定的事实，不做类型推断、不含任何写操作。
 * 位置一律 1-based、列按 UTF-16 code unit（与 Position 同口径）。
 */
export interface HoverRequest {
  file: string;
  line: number;
  col: number;
}

/**
 * 悬停结论：
 * - resolved：命中定义，或引用能解析到定义
 * - external：外部依赖 / 标准库 / 语言内置（只标注，不跳转）
 * - infer-needed：需要类型推断才能定位（如 `obj.method` 的 method）
 * - unresolved：有名字但解析不到定义
 * - no-symbol：光标处没有可解释的符号（空白 / 关键字 / 词外）
 * - indexing：索引尚未完成，暂不能下结论
 * - literal：命中的是字面量（值溯源）
 */
export type HoverReason =
  | 'resolved'
  | 'external'
  | 'infer-needed'
  | 'unresolved'
  | 'no-symbol'
  | 'indexing'
  | 'literal';

/** 一条定义：L3a–L3e 与 L4 / L5 / L7 的字段载体。 */
export interface HoverDefinition {
  name: string;
  kind: SymbolKind;
  /** 所属类 / 模块（L3b）。 */
  containerName?: string | null;
  /** 声明首行签名（L3d）；null 表示源码里没有可展示的签名。 */
  signature?: string | null;
  /** 定义位置（L3c），可点击跳转。 */
  location: Location;
  /** 局部变量 / 参数：卡片按最简形态展示。 */
  local?: boolean;
  /** 类型信息（L5），仅来自源码已写的注解，如 `["id: string", "→ Promise<User>"]`。 */
  types?: string[];
  /** 装饰器 / 注解原文（L7），如 `["@cache"]`。 */
  decorators?: string[];
  /** docstring 或紧邻注释（L4），已按行拆分并截断。 */
  doc?: string[];
  /** 引用处数（L3e，不含声明本身）。 */
  refCount?: number;
}

/** 字面量溯源（L6）：这个值是什么、从哪来。 */
export interface HoverLiteral {
  text: string;
  kind: 'number' | 'string' | 'other';
  /** 直接绑定到的常量 / 变量（若有）。 */
  boundTo?: { name: string; kind: SymbolKind; location: Location } | null;
  /** 全项目内同值出现处数（含本处）。 */
  sameValueCount?: number;
  /** 绑定名的其他引用处数。 */
  refCount?: number;
  /**
   * 该字符串被当作某个对象的下标键使用时的对象文本（如 `config["timeout"]` 的 `config`）。
   * 只陈述源码里写得下的事实，不假造「键的定义位置」，因此不给跳转。
   */
  keyOf?: string | null;
}

export interface HoverResult {
  reason: HoverReason;
  /** 光标处的词（供前端兜底展示）。 */
  symbol?: string | null;
  /** 定义清单；通常 1 条，同名多定义无法区分时全部列出。 */
  definitions?: HoverDefinition[];
  /** reason=literal 时的值溯源。 */
  literal?: HoverLiteral | null;
  /** 一句可直接展示的人话（失败态 / 兜底）。 */
  message?: string | null;
}

/** 整文件密度概览条（L10）：按固定行数分段统计。 */
export interface DensitySegment {
  startLine: number;
  endLine: number;
  /** 段内代码行占比 0~1。 */
  code: number;
  /** 段内注释行占比 0~1。 */
  comment: number;
  /** 段内空白行占比 0~1。 */
  blank: number;
  /** 段内主要符号名（最多 3 个，按位置顺序）。 */
  symbols: string[];
}

export interface FileDensity {
  file: string;
  totalLines: number;
  /** 每段行数（固定值；最后一段可能更短）。 */
  segmentSize: number;
  segments: DensitySegment[];
  /** 索引版本，供前端缓存失效。 */
  revision: string;
}

/** 服务自述，供 xchen 等外部宿主发现能力。 */
export interface IntegrationManifest {
  name: string;
  version: string;
  apiBase: string;
  /** 前端深链模板，宿主可用它直接打开某文件某行。 */
  viewerUrlTemplate: string;
  endpoints: Record<string, string>;
  /** 当前监听的 host（`127.0.0.1` = 仅本机）。 */
  host?: string;
  /** 同机同目录分享提示（S5a）；仅监听本机时为 null，如何放开见 shareNote。 */
  shareHint?: ShareHint | null;
  /** shareHint 为 null 时的放开说明。 */
  shareNote?: string;
  /** S8：agent 工具清单（只读，普通 HTTP 调用）。 */
  agentTools?: AgentToolSpec[];
  /** 工具清单端点。 */
  toolsEndpoint?: string;
  /** 工具语义的统一说明（解析不出如实返回，不猜）。 */
  toolsNote?: string;
  /** S9c：宿主收起面板时的释放端点（关 watcher / 断 SSE / 释放内存索引，保留注册）。 */
  disposeEndpoint?: string;
  /** S9c：资源视图端点（宿主自证「没有残留」）。 */
  resourcesEndpoint?: string;
  /** S9c：生命周期约定（何时清、清到什么程度）。 */
  lifecycleNote?: string;
}

/** Agent 工具参数描述（JSON Schema 子集，够表述 string / number / boolean / array）。 */
export interface AgentToolParams {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'array' | 'object';
      description?: string;
      default?: unknown;
      enum?: string[];
      items?: { type: string };
    }
  >;
  required?: string[];
}

/** 一个 agent 可调用的只读工具（S8）。 */
export interface AgentToolSpec {
  name: string;
  description: string;
  params: AgentToolParams;
  /** 调用方式：`POST /api/agent/:id/call { tool, args }`（全局工具 :id 传 `_`）。 */
  endpoint: string;
}

/** 「同机同目录分享」提示（S5a）：可分享的访问地址与只读承诺。 */
export interface ShareHint {
  /** 形如 `http://192.168.1.5:8787/?project={projectId}`（`{projectId}` 需替换成真实 id）。 */
  url: string;
  /** 只读承诺：打开即只读阅读，不会写被读目录。 */
  note: string;
}

// ------------------------------------------------------------ 项目地图（01 Map）

/**
 * 热点榜排序口径（M3.2）：files=被项目内不同文件引用数；refs=被引用条目总数；
 * symbols=定义的符号被引用次数；defined=该文件定义的项目级符号数；
 * unique=独有依赖（唯独它能提供的符号，其上游文件数）；recent=新近度加权。
 */
export type HotMetric = 'files' | 'refs' | 'symbols' | 'defined' | 'unique' | 'recent';

/** 数字口径（01-map §4 对底座的硬约束①：所有数字必须注明口径）。 */
export interface MetricNote {
  label: string;
  unit: string;
  /** 是否含测试 / 示例文件。 */
  includesTests: boolean;
  scope: 'file' | 'dir' | 'symbol' | 'ref' | 'byte' | 'line';
}

export interface LangStat {
  lang: LangId;
  /** 该语言的全部文件数（含测试 / 示例）。 */
  files: number;
  /** 其中测试 / 示例文件数，供「不含测试」口径使用。 */
  tests: number;
  bytes: number;
  lines: number;
}

export interface DirStat {
  dir: string;
  files: number;
  bytes: number;
  /** 依赖该目录的项目内其它目录数。 */
  inbound: number;
  /** 该目录依赖的项目内其它目录数。 */
  outbound: number;
}

/** 「从哪看起」列表项：入口候选或热点。 */
export interface OverviewEntry {
  file: string;
  kind: 'entry' | 'hot';
  score: number;
  /** 命中的依据（如「文件名像入口」「被 12 个文件引用」）。 */
  reasons: string[];
  inbound: number;
  lines: number;
}

/** 概览里出现的单个文件事实（热点 / 孤立 / 复杂 / 最大文件共用）。 */
export interface OverviewFile {
  file: string;
  lang: LangId;
  size: number;
  lines: number;
  /** 该文件定义的项目级符号数（不含局部变量）。 */
  defs: number;
  /** 被项目内不同文件引用的数量（去重）。 */
  inDegree: number;
  /** 引用了项目内不同文件的数量（去重）。 */
  outDegree: number;
  /** 指向它的引用/导入条目总数。 */
  inbound: number;
  /** 最大嵌套深度（近似）。 */
  nesting: number;
  /** 分支节点数（近似圈复杂度）。 */
  branches: number;
  dir: string;
  test: boolean;
  /** 顶层导出（非 local 的项目级定义）数。M11.4。 */
  exports: number;
  /** 最长函数 / 方法的行数。M11.2。 */
  longestFunction: number;
  /** 函数 / 方法的平均行数。M11.2。 */
  avgFunction: number;
  /** 独有依赖：唯独这个文件能提供的符号，其上游文件数（去重）。M3.2。 */
  uniqueUpstream: number;
  /** 改动新鲜度 0~1（今天=1、3 天内=0.75、7 天内=0.5、更早=0.25）。M3.2。 */
  freshness: number;
  mtimeMs: number;
}

/** 单个文件的全量事实（`?files=1` 按需返回，供「点数字列出构成」）。 */
export interface FileFact extends OverviewFile {
  /** 是否已进符号索引（false = 只读了正文）。 */
  indexed: boolean;
}

/** 目录的职责信息（M4.2 分层 + M4.3 职责一句话）。 */
export interface DirDuty {
  dir: string;
  files: number;
  bytes: number;
  layer: GraphLayer;
  /** 分层依据（可核对的事实，不是推断）。 */
  layerReason: string;
  /** 「这个目录管什么」——原文截取或事实句。 */
  duty: string;
  /** duty 的出处文件；null = 这是事实句而非原文。 */
  dutyFrom: string | null;
  inboundDirs: string[];
  outboundDirs: string[];
  inboundRefs: number;
  outboundRefs: number;
  keyFiles: string[];
}

export interface ProjectOverview {
  project: { id: string; name: string; root: string; createdAt: number };
  status: IndexStatus;
  identity: {
    files: number;
    dirs: number;
    bytes: number;
    lines: number;
    indexedFiles: number;
    /** 测试 / 示例文件数（「不含测试」口径的输入）。 */
    testFiles: number;
    langs: LangStat[];
  };
  meta: {
    kind: 'npm' | 'go' | 'python' | 'java' | 'rust' | 'unknown';
    name: string | null;
    modulePath: string | null;
    scripts: string[];
    /** 包清单里声明的入口文件（package.json 的 main / bin / scripts）。 */
    declaredEntries: string[];
  };
  readme: { path: string; excerpt: string; truncated: boolean } | null;
  /** 入口候选 + 热点合并后的「从哪看起」列表。 */
  entries: OverviewEntry[];
  hot: Array<OverviewFile & { score: number }>;
  hotMetric: HotMetric;
  orphans: OverviewFile[];
  largestFiles: Array<{ file: string; size: number; lines: number; lang: LangId }>;
  largestDirs: DirStat[];
  complex: OverviewFile[];
  /** 循环依赖（文件级，SCC > 1）。 */
  cycles: string[][];
  recent: {
    today: number;
    last3d: number;
    last7d: number;
    older: number;
    newest: Array<{ file: string; mtimeMs: number }>;
  };
  /** 目录职责与分层（M4.2 / M4.3）。 */
  dirs: DirDuty[];
  /** 共同约束：索引未完成时给「部分地图 + 进度」而不是空白，也绝不显示假 0 值。 */
  partial: {
    indexing: boolean;
    filesIndexed: number;
    filesTotal: number;
    progress: number;
    /** 人话说明当前能信什么、还不能信什么。 */
    notes: string[];
  };
  /** 数字口径表（§4 硬约束①）：键与 identity / recent 字段同名。 */
  notes: Record<string, MetricNote>;
  /** 宿主上报的 agent 产出（M10.1 / M10.2）：文件 + 可选行范围。 */
  agentMarks: Array<{ file: string; at: number; lines: Array<[number, number]> }>;
  /** 按需（`?files=1`）返回的全量文件事实；未请求时为 undefined。 */
  files?: FileFact[];
}

// --------------------------------------------------------- 依赖图 / 反向依赖

/**
 * 目录职责分层（M4.2）：按职责而非依赖度数分。
 * entry=入口层；domain=领域层；infra=基础设施层；utility=工具层；isolated=既不被依赖也不依赖别人。
 */
export type GraphLayer = 'entry' | 'domain' | 'infra' | 'utility' | 'isolated';

export interface GraphNode {
  /** 目录：`src/`；文件：相对路径；外部依赖：`ext:react`。 */
  id: string;
  label: string;
  kind: 'dir' | 'file' | 'external';
  /** 目录层级（/ 的个数），文件为 0。 */
  depth: number;
  /** 目录子树内的文件数。 */
  files: number;
  lang?: LangId;
  /** 图上入边数（已聚合到当前粒度）。 */
  inbound: number;
  /** 图上出边数。 */
  outbound: number;
  /** 入口候选。 */
  entry?: boolean;
  /** 测试目录 / 文件。 */
  test?: boolean;
  /** 被提到文件级展示的入口 / 热点（两级并存）。 */
  focus?: boolean;
  /** 该目录已被展开到文件级。 */
  expanded?: boolean;
  /** 仅目录：职责分层（M4.2）。 */
  layer?: GraphLayer;
  /** 仅目录：职责一句话（M4.3，原文截取或事实句）。 */
  duty?: string;
  /** 仅目录：duty 的出处文件，null 表示事实句。 */
  dutyFrom?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** 该边聚合了多少条 import 语句。 */
  imports: number;
  /** 聚合了多少个解析成功的符号引用。 */
  refs: number;
}

export interface DependencyGraph {
  level: 'dir' | 'file';
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 当前粒度下的循环依赖（SCC 大小 > 1）。 */
  cycles: string[][];
  /** 项目依赖的第三方包（按被引用次数降序，只给前 N 个）。 */
  externals: Array<{ name: string; inbound: number; files: number }>;
  /** 因规模上限被略去的节点数（0 表示完整）。 */
  truncated: number;
  totalFiles: number;
  /** 泳道分组（M4.2）：按职责分层把目录节点分回四层，供前端泳道布局。 */
  lanes: Array<{ layer: GraphLayer; label: string; nodes: string[] }>;
  /** 目录职责（M4.3），键为目录 id（`src/` 形式）。 */
  duties: Record<string, { duty: string; from: string | null; layerReason: string }>;
}

/** 反依赖：文件级「谁引用了它」+ N 跳传递上游（M6.1/M6.3/M6.4）。 */
export interface DependentsResult {
  file: string;
  direct: Array<{ file: string; imports: number; refs: number; test: boolean }>;
  transitive: Array<{ file: string; depth: number }>;
  /** 直接上游里的测试文件 —— 「改坏了谁会红」。 */
  tests: Array<{ file: string; imports: number; refs: number }>;
  total: number;
}

/** 目录级反向依赖（M6.2）：我动的这块，外面有几个入口依赖。 */
export interface DirDependentsResult {
  /** 目录 id（`src/` 形式）。 */
  dir: string;
  /** 直接依赖它的目录。 */
  direct: Array<{ dir: string; files: number; imports: number; refs: number; tests: number }>;
  /** 它直接依赖的目录。 */
  outbound: Array<{ dir: string; files: number; imports: number; refs: number }>;
  /** N 跳传递上游目录。 */
  transitive: Array<{ dir: string; depth: number }>;
  files: number;
  /** 目录里被引用最多的文件（改动的实际爆点）。 */
  keyFiles: Array<{ file: string; inbound: number }>;
}

// ---------------------------------------------------------- 时间与来源（M9/M10）

/** 文件来源：宿主上报 / 最近改动 / 项目原有。 */
export type FileOrigin = 'agent' | 'recent' | 'project';

export interface TimelineFile {
  file: string;
  mtimeMs: number;
  size: number;
  lang: LangId;
  origin: FileOrigin;
  /** 0~1：宿主上报 = 1；启发式按新鲜度与 git 改动状态给分。 */
  confidence: number;
}

export interface TimelineBatch {
  /** 批次时间（git 提交时间；无 git 时退化为该批最新 mtime）。 */
  at: number;
  /** git 提交摘要（fs 模式为 null）。 */
  label: string | null;
  files: string[];
}

export interface ProjectTimeline {
  /** git = 读了只读 git 历史；fs = 只有文件系统时间。 */
  source: 'git' | 'fs';
  git: {
    branch: string | null;
    /** 最近一次提交时间。 */
    committedAt: number | null;
    /** 未提交 / 未跟踪的文件（相对路径）。 */
    dirty: string[];
  };
  counts: { today: number; last3d: number; last7d: number; older: number };
  /** 按 mtime 降序的全部文件（含 origin 判定）。 */
  files: TimelineFile[];
  /** 最近若干批改动（git 提交批次；无 git 时按天聚合）。 */
  batches: TimelineBatch[];
}

// ---------------------------------------------------------- 底座（06-platform）

/** 未索引 / 降级的归类原因（P9：把「工具坏了」翻译成「这个文件为什么没进来」）。 */
export type SkipReason =
  | 'too-large'      // 超过降级阈值且连顶层符号都没取
  | 'binary'         // 含 NUL 字节，判为二进制
  | 'parse-failed'   // 语法包解析失败
  | 'read-error'     // 读盘失败（权限 / 竞态删除）
  | 'ignored'        // 被忽略规则排除
  | 'not-source';    // 不是被索引的源码扩展名

/** 忽略规则现状（P8）：生效来源与命中数，供界面显示「规则真的生效了」。 */
export interface IgnoreInfo {
  /** 生效的规则文件（相对项目根）；没有则为空数组。 */
  sources: Array<{ path: string; rules: number }>;
  builtinDirs: number;
  builtinPatterns: number;
  /** 被忽略规则排除的文件数（相对项目根，不含目录）。 */
  ignored: number;
  /** 被 `!` 重新纳入的路径（最多 20 条）。 */
  overridden: string[];
}

/** 索引快照状态（P4）：冷启动秒开是否命中。 */
export interface SnapshotStatus {
  exists: boolean;
  /** 快照写入时间（毫秒）；不存在为 null。 */
  savedAt: number | null;
  /** 快照里的文件数。 */
  fileCount: number;
  /** 快照 schema 版本。 */
  schema: number;
  /** 加载时指纹是否与磁盘一致（null = 本次进程还没校验过）。 */
  fresh: boolean | null;
  /** 落盘目录（供排障；不暴露给非本机用户无隐私问题——本就是本机服务）。 */
  dir: string;
}

/** 对账结果（P7）：索引与磁盘的差异。 */
export interface VerifyResult {
  checkedAt: number;
  added: string[];
  changed: string[];
  deleted: string[];
  /** 差异是否已自动修复。 */
  healed: boolean;
}

// ------------------------------------------ 向导（04 Guide · W3 变更感知 / G8）

/** 变更快照里一个文件的现状（前端 `wcr:readsnapshot:<id>` 的条目口径）。 */
export interface ChangeSnapshotFile {
  mtimeMs: number;
  size: number;
  /** 文本行数（按 `\n` 切分计数；前端写入时与后端同一口径）。 */
  lines: number;
}

/** 一次阅读快照（G8.2 的输入）：只存索引内源码文件，外加笔记锚点。 */
export interface ChangeSnapshotInput {
  /** 快照时间（毫秒）。 */
  at: number;
  files: Record<string, ChangeSnapshotFile>;
  /** 笔记 id → 它当前锚在哪个文件的哪一行（用于「你标注过的地方被改了」）。 */
  noteLocs?: Record<string, { file: string; line: number }>;
}

/** 变更类型：修改 / 新增 / 删除。 */
export type ChangeStatus = 'M' | 'A' | 'D';

/** 变更清单里的一项：状态 + 行数增减 + 来源判定 + 与笔记的关系。 */
export interface ChangeFile {
  file: string;
  status: ChangeStatus;
  /** git 模式下来自 `diff --numstat`；快照模式恒为 null（不编造）。 */
  addedLines?: number | null;
  removedLines?: number | null;
  /** 二进制文件（numstat 报 `-`），此时增删行不可知。 */
  binary?: boolean;
  /** 快照里的样子（新增文件没有）。 */
  before?: ChangeSnapshotFile;
  /** 磁盘现状（删除文件没有）。 */
  after?: ChangeSnapshotFile;
  /** 来源判定，口径与 01 地图 timeline 的 classify 同源。 */
  origin: FileOrigin;
  originConfidence: number;
  /** 快照里锚在该文件的笔记条数。 */
  notes: number;
  /** 有笔记且该文件出现在本次变更清单里（笔记可能已过期）。 */
  noteStale: boolean;
}

/** `POST /api/projects/:id/changes` 的结果。 */
export interface ChangeSummary {
  /** 快照时间（对比的「上次」）。 */
  at: number;
  /** 本次对比时间。 */
  now: number;
  /** git = 用了 `diff --numstat`；snapshot = 无 git，只做 mtime/size/行数对比。 */
  source: 'git' | 'snapshot';
  /**
   * `source === 'snapshot'` 时进一步说清原因，界面才能写准话：
   * `'no-head'` = 目录是 git 仓库但还没有任何提交（刚 `git init`）；`'no-repo'` = 不是 git 仓库 / 没装 git。
   * `source === 'git'` 时恒为 `'ok'`。
   */
  git: 'ok' | 'no-head' | 'no-repo';
  files: ChangeFile[];
  counts: {
    added: number;
    modified: number;
    deleted: number;
    /** git 模式下是增删行之和；快照模式恒为 0（界面须标注「无 git，仅行数对比」）。 */
    addedLines: number;
    removedLines: number;
    /** 所在文件被改动的笔记条数。 */
    noteStale: number;
  };
}

/**
 * 阅读快照的数据源（G8.2）：`GET /api/projects/:id/readmap`。
 * 只含索引里的源码文件；`lines` 与变更对比（changes.ts）同一口径（按 `\n` 切分）。
 */
export interface ReadmapFile {
  /** 相对项目根的 POSIX 路径。 */
  file: string;
  mtimeMs: number;
  size: number;
  lines: number;
}

/** `GET /api/projects/:id/readmap` 的结果：写「阅读快照」的原料（不新扫描磁盘）。 */
export interface ReadmapResult {
  /** 服务端取数时间（毫秒）。 */
  at: number;
  files: ReadmapFile[];
}

/** 只读 diff 结果（G7.2 / G7.5）：git 不可用时 diff=null 并给 reason。 */
export interface FileDiffResult {
  file: string;
  /** 对比的版本（rev 缺省 = HEAD，即工作区 vs HEAD）。 */
  rev: string;
  /** 原始 diff 文本（不解析，交给前端展示）；null = 拿不到。 */
  diff: string | null;
  /** diff 过长被截断。 */
  truncated?: boolean;
  /** diff 为 null 的原因（'no-git' / 'bad-rev' / 'path-escape'）。 */
  reason?: string;
}

/** 行级 blame 的一行（G7.3）。 */
export interface BlameLine {
  /** 1-based 行号（当前文件的行号）。 */
  line: number;
  /** 提交 sha（完整 40 位）。 */
  rev: string;
  author: string;
  email: string;
  /** 作者时间（毫秒）。 */
  at: number;
  /** 该次提交的摘要。 */
  summary: string;
}

/** `GET /api/projects/:id/blame` 的结果（G7.3）：无 git → 空数组 + reason。 */
export interface BlameResult {
  file: string;
  lines: BlameLine[];
  /** 文件过大（超过后端上限）被截断，只给出前若干行。 */
  truncated?: boolean;
  /** lines 为空的原因（'no-git' / 'too-large'）。 */
  reason?: string;
}

/** 文件级提交历史的一项（G7.4）。 */
export interface FileHistoryEntry {
  rev: string;
  /** 提交时间（毫秒）。 */
  at: number;
  author: string;
  summary: string;
  /** 该次提交对这个文件的改动（`R` = 重命名 / 复制后的新路径）。 */
  changes: Array<{ status: 'M' | 'A' | 'D' | 'R'; path: string }>;
}

/** `GET /api/projects/:id/file-history` 的结果（G7.4）：无 git → 空数组 + reason。 */
export interface FileHistoryResult {
  file: string;
  commits: FileHistoryEntry[];
  reason?: string;
}

/** `GET /api/projects/:id/git-show` 的结果（G7.5）：历史版本正文（只读，不落盘）。 */
export interface GitShowResult {
  file: string;
  rev: string;
  text: string;
}

// ------------------------------ 向导（04 Guide · W4 结构性解释 / G5.2、G5.3）

/** 解释范围：光标处一小段 / 整个符号（默认）/ 连带调用方。 */
export type ExplainScope = 'selection' | 'symbol' | 'callers';

/** 解释里提到的项目内符号引用（每条都有出处）。 */
export interface ExplainRef {
  name: string;
  file: string;
  line: number;
  kind: SymbolKind;
}

/** `POST /api/projects/:id/explain` 的结果（纯静态，不使用模型）。 */
export interface ExplainResult {
  scope: ExplainScope;
  target: {
    name: string;
    kind: SymbolKind;
    file: string;
    /** 定义名的行 / 列（1-based）。 */
    line: number;
    col: number;
    containerName?: string | null;
    /** 声明首行（签名）原文，取自索引。 */
    signature?: string | null;
    /** 定义上的 docstring / 紧邻注释原文。 */
    doc?: string | null;
  };
  /** 谁调用了它（直接调用方；callers 档扩展到两层）。 */
  callers: CallNode[];
  /** 它调用了谁（直接被调方 + 模块级 / 外部 / 未解析聚合项）。 */
  callees: CallNode[];
  /** 它引用了本项目哪些定义（名字 / 出处 / 种类）。 */
  projectRefs: ExplainRef[];
  /** 它引用了哪些外部模块（含标准库内置符号，module 为空串）。 */
  externalModules: Array<{ module: string; file: string; line: number }>;
  /** 顶层未解析计数（= coverage.unresolved，单独提出便于展示）。 */
  unresolved: number;
  /** 诚实上报的覆盖率：解析到的调用 / 未解析 / 外部依赖。 */
  coverage: { resolved: number; unresolved: number; external: number };
  /** 目标符号覆盖的行范围（selection 档 = 光标处 token 的范围）。 */
  lines: { start: number; end: number };
  /** 由上面这些结构化字段确定性拼装的文本层（不使用模型）。 */
  summary?: string;
}

// ------------------------------------ 向导（04 Guide · W5 流视图 / G9.1–G9.3）

/** 流视图方向：我调用了谁 / 谁调用我 / 数据流（名字级近似）。 */
export type FlowKind = 'calls' | 'callers' | 'data';

/** 流视图节点（id = `file:line`；聚合的未解析 / 外部节点用 `~` 前缀）。 */
export interface FlowNode {
  id: string;
  name: string;
  kind: SymbolKind;
  /** 项目内文件（外部 / 未解析聚合节点为空串）。 */
  file: string;
  line: number;
  col: number;
  /** 距焦点的层数（焦点为 0）。 */
  depth: number;
  /** 外部依赖聚合节点（不展开）。 */
  external?: boolean;
  /** 未解析聚合节点（需要类型信息，不展开）。 */
  unresolved?: boolean;
  isEntry?: boolean;
  isTest?: boolean;
}

/** 流视图的边。`data` 边一律 `approx: true`（名字级近似，不做类型推断）。 */
export interface FlowEdge {
  id: string;
  /** 源节点 id。 */
  source: string;
  /** 目标节点 id。 */
  target: string;
  kind: FlowKind;
  /** 该关系上的调用处数（data 边为匹配到的实参个数）。 */
  count: number;
  /** data 边的名字级标签，如「实参 value → 形参 value」。 */
  label?: string;
  approx?: boolean;
}

/** `POST /api/projects/:id/flow` 的结果。 */
export interface FlowResult {
  kind: FlowKind;
  focus: { name: string; kind: SymbolKind; file: string; line: number };
  nodes: FlowNode[];
  edges: FlowEdge[];
  coverage: { resolved: number; unresolved: number; external: number };
  /** 节点数触到 300 上限被截断。 */
  truncated: boolean;
  /** data 档 = true（名字级近似）。 */
  approximate?: boolean;
  note?: string;
}
