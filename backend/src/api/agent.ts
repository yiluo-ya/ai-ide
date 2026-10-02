/**
 * S8：把已有的索引 / 解析能力包装成 agent 可调用的工具。
 *
 * 协议选择：普通 HTTP（用户已拍板，不做 MCP）——
 *   GET  /api/agent/tools                 → 工具清单（JSON Schema 风格的参数）
 *   POST /api/agent/:id/call { tool, args } → 按名字路由到下面各工具
 *
 * 全部工具只读：不写文件、不执行命令、不新造解析（一律复用 store / resolver 的既有语义）。
 * 解析不出时如实返回 unresolved / external / no-symbol，绝不编造位置。
 */
import type { AgentToolSpec, SearchOptions } from '../types';
import { documentSymbols, findReferences, gotoDefinition, workspaceSymbols } from '../indexer/resolver';
import { isTestFile } from '../indexer/insight';
import type { ProjectIndex } from '../indexer/store';
import type { ProjectRegistry } from '../registry';

/** 所有工具共用的说明，随工具清单一并返回。 */
export const AGENT_TOOLS_NOTE =
  '工具全部只读（不写文件、不执行命令）；位置一律 1-based、列按 UTF-16。解析不出时返回 unresolved / no-symbol / external，不猜、不编造；调用返回的字段即事实。';

/** 单次 read_file 最多返回的行数，超出截断并在 truncated 标注。 */
export const MAX_READ_LINES = 400;

/** index_project 等待索引完成的默认 / 最大毫秒数。 */
const DEFAULT_INDEX_WAIT_MS = 30_000;
const MAX_INDEX_WAIT_MS = 120_000;

/** 工具参数不合理 / 项目不存在：由调度器转成对应的 HTTP 状态与错误体。 */
export class AgentToolError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

type Args = Record<string, unknown>;

interface ToolContext {
  registry: ProjectRegistry;
  /** 全局工具（list_projects / index_project）为 null。 */
  project: ProjectIndex | null;
}

interface AgentTool {
  spec: AgentToolSpec;
  /** 全局工具不依赖 :id 指向已注册项目。 */
  global?: boolean;
  run: (ctx: ToolContext, args: Args) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------- 参数读取

function strArg(args: Args, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

function numArg(args: Args, key: string): number | null {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function intArg(args: Args, key: string): number | null {
  const n = numArg(args, key);
  return n === null ? null : Math.trunc(n);
}

/** 位置参数：缺省 1（与现有 go-to-definition 端点一致），但必须 >= 1。 */
function positionArg(args: Args, key: string): number {
  const n = intArg(args, key) ?? 1;
  if (n < 1) throw new AgentToolError(400, 'bad_request', `${key} 必须是 >= 1 的整数`);
  return n;
}

function needProject(ctx: ToolContext): ProjectIndex {
  if (!ctx.project) throw new AgentToolError(400, 'bad_request', '该项目级工具需要一个已注册的项目 id');
  return ctx.project;
}

/** 取 file 参数并做项目根校验（越界 400），返回校验通过的项目与相对路径。 */
function needProjectFile(ctx: ToolContext, args: Args, key = 'file'): { project: ProjectIndex; file: string } {
  const project = needProject(ctx);
  const file = strArg(args, key);
  if (!file) throw new AgentToolError(400, 'bad_request', `${key} is required`);
  if (!project.resolveInside(file)) throw new AgentToolError(400, 'path_escape', `路径越界：${file}`);
  return { project, file };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- 工具实现

const findSymbol: AgentTool = {
  spec: {
    name: 'find_symbol',
    description: '按名字查项目内的符号定义（模糊匹配，按匹配度排序）；支持 kind 过滤与 limit。',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '符号名或名字片段，如 login、AuthService' },
        kind: {
          type: 'string',
          description: '符号类型过滤（function / class / method / interface / variable …）',
        },
        limit: { type: 'number', description: '返回条数上限（1~500，默认 50）', default: 50 },
      },
      required: ['name'],
    },
    endpoint: 'POST /api/agent/:id/call',
  },
  run: (ctx, args) => {
    const project = needProject(ctx);
    const name = strArg(args, 'name') ?? strArg(args, 'q');
    if (!name) throw new AgentToolError(400, 'bad_request', 'name is required');
    const kind = strArg(args, 'kind');
    const limit = Math.max(1, Math.min(intArg(args, 'limit') ?? 50, 500));
    const symbols = workspaceSymbols(project, name, kind, limit).map((s) => ({
      file: s.location.file,
      line: s.location.range.start.line,
      col: s.location.range.start.col,
      name: s.name,
      kind: s.kind,
      container: s.containerName ?? null,
      signature: s.detail ?? null,
      isTest: isTestFile(s.location.file),
      reason: 'resolved' as const,
    }));
    return { query: name, symbols };
  },
};

const gotoTool: AgentTool = {
  spec: {
    name: 'goto_definition',
    description:
      '位置 → 定义位置（复用 go-to-definition 语义）。reason=resolved 时 locations 是定义处；external 是依赖 / 内置；unresolved / no-symbol 表示解析不出（如实返回，不猜）。',
    params: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '项目内相对路径' },
        line: { type: 'number', description: '1-based 行号（缺省 1）', default: 1 },
        col: { type: 'number', description: '1-based 列号（UTF-16，缺省 1）', default: 1 },
      },
      required: ['file', 'line', 'col'],
    },
    endpoint: 'POST /api/agent/:id/call',
  },
  run: (ctx, args) => {
    const { project, file } = needProjectFile(ctx, args);
    const line = positionArg(args, 'line');
    const col = positionArg(args, 'col');
    const out = gotoDefinition(project, file, line, col);
    return {
      locations: out.locations,
      symbol: out.symbol,
      reason: out.reason,
      ...(out.external ? { external: out.external } : {}),
    };
  },
};

const findRefsTool: AgentTool = {
  spec: {
    name: 'find_references',
    description: '位置 → 指向该符号定义的引用位置（含 isTest 标注与 declaration 声明处）。',
    params: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '项目内相对路径' },
        line: { type: 'number', description: '1-based 行号（缺省 1）', default: 1 },
        col: { type: 'number', description: '1-based 列号（UTF-16，缺省 1）', default: 1 },
        includeDeclaration: { type: 'boolean', description: '是否把声明处也算进 locations（缺省 false）', default: false },
      },
      required: ['file', 'line', 'col'],
    },
    endpoint: 'POST /api/agent/:id/call',
  },
  run: (ctx, args) => {
    const { project, file } = needProjectFile(ctx, args);
    const line = positionArg(args, 'line');
    const col = positionArg(args, 'col');
    const includeDeclaration = args.includeDeclaration === true;
    const out = findReferences(project, file, line, col, includeDeclaration);
    return {
      locations: out.locations.map((loc) => ({ ...loc, isTest: isTestFile(loc.file) })),
      symbol: out.symbol,
      reason: out.reason,
      declaration: out.declaration ?? null,
    };
  },
};

const outlineTool: AgentTool = {
  spec: {
    name: 'file_outline',
    description: '文件符号大纲（复用 document-symbols）：符号树，含 name / kind / range / 签名。',
    params: {
      type: 'object',
      properties: { file: { type: 'string', description: '项目内相对路径' } },
      required: ['file'],
    },
    endpoint: 'POST /api/agent/:id/call',
  },
  run: (ctx, args) => {
    const { project, file } = needProjectFile(ctx, args);
    if (!project.files.has(file)) {
      return {
        file,
        symbols: [],
        reason: 'not-indexed' as const,
        message: '文件不在符号索引内（不存在 / 非源码 / 超 1MB）',
      };
    }
    return { file, symbols: documentSymbols(project, file), reason: 'resolved' as const };
  },
};

const searchTool: AgentTool = {
  spec: {
    name: 'search_text',
    description: '全项目文本搜索（复用现有搜索，支持 regex / caseSensitive / wholeWord / filePattern / dirs），结果按文件分组。',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的文本或正则' },
        options: {
          type: 'object',
          description: 'SearchOptions：{ regex?, caseSensitive?, wholeWord?, filePattern?, maxResults?, files?, dirs? }',
        },
      },
      required: ['query'],
    },
    endpoint: 'POST /api/agent/:id/call',
  },
  run: async (ctx, args) => {
    const project = needProject(ctx);
    const query = strArg(args, 'query');
    if (!query) throw new AgentToolError(400, 'bad_request', 'query is required');
    const rawOptions = args.options;
    const options: SearchOptions =
      rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
        ? (rawOptions as SearchOptions)
        : {};
    let result;
    try {
      result = await project.searchText(query, options);
    } catch (e) {
      throw new AgentToolError(400, 'bad_query', e instanceof Error ? e.message : String(e));
    }
    const groups = new Map<string, Array<{ line: number; col: number; endCol: number; text: string }>>();
    for (const m of result.matches) {
      const list = groups.get(m.file) ?? [];
      list.push({ line: m.range.start.line, col: m.range.start.col, endCol: m.range.end.col, text: m.lineText });
      groups.set(m.file, list);
    }
    return {
      query: result.query,
      total: result.matches.length,
      fileCount: result.fileCount,
      truncated: result.truncated,
      files: [...groups.entries()].map(([file, matches]) => ({ file, isTest: isTestFile(file), matches })),
    };
  },
};

const readFileTool: AgentTool = {
  spec: {
    name: 'read_file',
    description: `读文件正文的指定行范围（1-based，含行号）；单次最多 ${MAX_READ_LINES} 行，超出截断并置 truncated。`,
    params: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '项目内相对路径' },
        start: { type: 'number', description: '起始行（1-based，缺省 1）', default: 1 },
        end: { type: 'number', description: '结束行（含；缺省到文件末）' },
      },
      required: ['file'],
    },
    endpoint: 'POST /api/agent/:id/call',
  },
  run: async (ctx, args) => {
    const { project, file } = needProjectFile(ctx, args);
    const start = intArg(args, 'start') ?? 1;
    const rawEnd = intArg(args, 'end');
    if (start < 1) throw new AgentToolError(400, 'bad_request', 'start 必须是 >= 1 的整数');
    if (rawEnd !== null && rawEnd < start) {
      throw new AgentToolError(400, 'bad_request', 'end 必须 >= start');
    }
    const text = await project.readText(file);
    if (!text) {
      throw new AgentToolError(404, 'file_not_found', `无法读取（不存在 / 二进制 / 过大）：${file}`);
    }
    const lines = text.text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const totalLines = lines.length;
    const lastRequested = rawEnd === null ? totalLines : Math.min(rawEnd, totalLines);
    const limitedLast = Math.min(lastRequested, start + MAX_READ_LINES - 1);
    const out: Array<{ line: number; text: string }> = [];
    for (let n = start; n <= limitedLast; n++) out.push({ line: n, text: lines[n - 1] ?? '' });
    return {
      file,
      lang: text.lang,
      startLine: start,
      endLine: limitedLast,
      totalLines,
      truncated: limitedLast < lastRequested,
      lines: out,
    };
  },
};

const listProjectsTool: AgentTool = {
  spec: {
    name: 'list_projects',
    description: '列出已注册（可读）的项目：id / name / root / 索引状态。',
    params: { type: 'object', properties: {} },
    endpoint: 'POST /api/agent/_/call',
  },
  global: true,
  run: (ctx) => ({ projects: ctx.registry.list() }),
};

const indexProjectTool: AgentTool = {
  spec: {
    name: 'index_project',
    description: '注册（打开）一个本机目录并等待索引完成（必要时）；返回 projectId / root / status。只读，不改动磁盘。',
    params: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '本机目录绝对路径' },
        name: { type: 'string', description: '展示名（缺省取目录名）' },
        timeoutMs: { type: 'number', description: '等待索引完成的毫秒数（缺省 30000，上限 120000）' },
      },
      required: ['root'],
    },
    endpoint: 'POST /api/agent/_/call',
  },
  global: true,
  run: async (ctx, args) => {
    const root = strArg(args, 'root');
    if (!root) throw new AgentToolError(400, 'bad_request', 'root is required');
    const name = strArg(args, 'name') ?? undefined;
    let opened: Awaited<ReturnType<ProjectRegistry['open']>>;
    try {
      opened = await ctx.registry.open(root, name);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOTDIR' || code === 'ENOENT') {
        throw new AgentToolError(400, 'not_a_directory', `目录不存在：${root}`);
      }
      throw e;
    }
    const timeoutMs = Math.max(0, Math.min(intArg(args, 'timeoutMs') ?? DEFAULT_INDEX_WAIT_MS, MAX_INDEX_WAIT_MS));
    const deadline = Date.now() + timeoutMs;
    while (opened.project.status.indexing && Date.now() < deadline) await sleep(20);
    return {
      projectId: opened.project.id,
      root: opened.project.root,
      created: opened.created,
      status: { ...opened.project.status },
    };
  },
};

const TOOLS: AgentTool[] = [
  findSymbol,
  gotoTool,
  findRefsTool,
  outlineTool,
  searchTool,
  readFileTool,
  listProjectsTool,
  indexProjectTool,
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.spec.name, t]));

/** 工具清单（可直接序列化进 manifest）。 */
export function agentToolSpecs(): AgentToolSpec[] {
  return TOOLS.map((t) => t.spec);
}

/** 可用工具名（错误信息与清单共用）。 */
export function agentToolNames(): string[] {
  return TOOLS.map((t) => t.spec.name);
}

export interface AgentCallResult {
  status: number;
  body: unknown;
}

/** 按名字路由一次工具调用；未知工具 400（列出可用工具名），项目不存在 404。 */
export async function callAgentTool(
  registry: ProjectRegistry,
  projectId: string,
  toolName: string,
  args: Args = {},
): Promise<AgentCallResult> {
  const tool = TOOL_INDEX.get(toolName);
  if (!tool) {
    return {
      status: 400,
      body: {
        error: 'unknown_tool',
        message: `未知工具：${toolName}；可用工具：${agentToolNames().join(', ')}`,
      },
    };
  }
  const project = tool.global ? null : (registry.get(projectId) ?? null);
  if (!tool.global && !project) {
    return { status: 404, body: { error: 'project_not_found', message: `项目不存在：${projectId}` } };
  }
  try {
    return { status: 200, body: await tool.run({ registry, project }, args ?? {}) };
  } catch (e) {
    if (e instanceof AgentToolError) {
      return { status: e.status, body: { error: e.error, message: e.message } };
    }
    return {
      status: 500,
      body: { error: 'agent_tool_failed', message: e instanceof Error ? e.message : String(e) },
    };
  }
}
