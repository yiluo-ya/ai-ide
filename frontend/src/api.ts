/** 后端 API 客户端（与 shared/types.ts 的契约一一对应）。 */
import type {
  AgentRuntimeStatus,
  CallDirection,
  CallHierarchyResult,
  CallNode,
  CommitChange,
  CommitInfo,
  CommandKind,
  CommandPlan,
  CommandRisk,
  CommandRun,
  DefinitionResult,
  DeleteEntryResult,
  DensitySegment,
  ExternalSource,
  FileConflictDetail,
  FileDensity,
  FileDiffResult,
  FileNode,
  FindReferencesRequest,
  GitChangesResult,
  GitHistoryWriteRequest,
  GitRefName,
  GitRunResult,
  GitWriteAction,
  HighlightResult,
  HoverDefinition,
  HoverLiteral,
  HoverReason,
  HoverResult,
  ImplementationsResult,
  IndexStatus,
  IntegrationManifest,
  Location,
  Position,
  ProjectInfo,
  ReferenceLocation,
  ReferenceResult,
  RepoLogResult,
  SaveFileResult,
  SearchMatch,
  SearchResult,
  SearchOptions,
  ServiceStatus,
  SymbolInfo,
  SymbolKind,
  TypeHierarchyResult,
  TypeNode,
} from '../../shared/types';
import type { LanguagesPayload } from './languages';

export type {
  AgentRuntimeStatus,
  ProjectInfo,
  IndexStatus,
  SymbolInfo,
  FileNode,
  SearchResult,
  SaveFileResult,
  DeleteEntryResult,
  FileConflictDetail,
  Position,
  HighlightResult,
  // 透镜（02-lens）：悬停卡片与密度条
  HoverResult,
  HoverDefinition,
  HoverLiteral,
  HoverReason,
  FileDensity,
  DensitySegment,
  Location,
  SymbolKind,
  // 导航（03-navigator）
  DefinitionResult,
  ReferenceResult,
  ReferenceLocation,
  ExternalSource,
  CallDirection,
  CallHierarchyResult,
  CallNode,
  TypeHierarchyResult,
  TypeNode,
  ImplementationsResult,
  SearchMatch,
  SearchOptions,
};

const BASE = '/api';

/**
 * 后端返回非 2xx 时抛出的错误：message 仍是给人看的那句，
 * 另带 `status` 与解析后的 body —— 保存冲突（409）要靠它把磁盘现状取出来。
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    let body: unknown = null;
    try {
      body = await res.json();
      const parsed = body as { message?: string; error?: string };
      detail = parsed.message ?? parsed.error ?? detail;
    } catch {
      /* 保底用状态码 */
    }
    throw new ApiRequestError(detail, res.status, body);
  }
  return (await res.json()) as T;
}

export const api = {
  manifest: () => request<IntegrationManifest>('/integration/manifest'),

  /** 语言清单（07-languages-plugin）：前端据此建语言映射，不再硬编码（见 languages.ts）。 */
  languages: () => request<LanguagesPayload>('/languages'),

  /** 设置里的自定义忽略规则（存后端 data 目录，对所有项目生效）。 */
  customIgnore: () => request<{ text: string }>('/settings/ignore'),

  /** 保存自定义忽略规则；保存后需重建索引才生效。 */
  saveCustomIgnore: (text: string) =>
    request<{ ok: true; text: string }>('/settings/ignore', { method: 'POST', body: JSON.stringify({ text }) }),

  /**
   * Code Agent 后端的定位状态（FR-0007）：pi 的解析来源 / 版本 / 落点与安装命令。
   * GET 共享模式下也能读（只读）；保存（POST）只在监听本机时可用。
   */
  agentRuntime: () => request<AgentRuntimeStatus>('/settings/agent'),

  /** 保存手填的 pi 路径（文件或目录；空串 = 清掉，回到落点与 PATH），保存后立即重探。 */
  saveAgentRuntime: (piPath: string) =>
    request<AgentRuntimeStatus & { ok: true }>('/settings/agent', {
      method: 'POST',
      body: JSON.stringify({ piPath }),
    }),

  listProjects: () => request<{ projects: ProjectInfo[] }>('/projects').then((r) => r.projects),

  lookupByRoot: (root: string) =>
    request<{ project: ProjectInfo }>(`/projects/lookup?root=${encodeURIComponent(root)}`).then(
      (r) => r.project,
    ),

  openProject: (root: string, name?: string) =>
    request<{ project: ProjectInfo; created: boolean }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ root, name }),
    }),

  forgetProject: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),

  reindex: (id: string) => request<{ ok: boolean }>(`/projects/${id}/reindex`, { method: 'POST' }),

  status: (id: string) => request<{ status: IndexStatus }>(`/projects/${id}/status`).then((r) => r.status),

  fileTree: (id: string) =>
    request<{ tree: FileNode; status: IndexStatus }>(`/projects/${id}/files`),

  /** 2026-10-03：文件树要显示项目的所有文件（含二进制与规则忽略的）。 */
  allFiles: (id: string) =>
    request<{ tree: FileNode; status: IndexStatus }>(`/projects/${id}/all-files`),

  /** 变更（2026-10-03）：以 git 为准的工作区改动清单。 */
  gitChanges: (id: string) => request<GitChangesResult>(`/projects/${id}/git-changes`),

  /** 变更栏的写操作（2026-10-03）：add all / commit / pull / push 四个；push 要 confirm=1。 */
  gitWrite: (id: string, action: GitWriteAction, message?: string) =>
    request<GitRunResult>(`/projects/${id}/git-write${action === 'push' ? '?confirm=1' : ''}`, {
      method: 'POST',
      body: JSON.stringify({ action, message }),
    }),

  /** SCM commits 视图（2026-10-09）：仓库最近 limit 条提交。 */
  gitLog: (id: string, limit = 50) => request<RepoLogResult>(`/projects/${id}/git-log?limit=${limit}`),

  /** 单条提交改动的文件清单（展开提交看 change list）。 */
  gitCommitChanges: (id: string, rev: string) =>
    request<{ rev: string; changes: CommitChange[] }>(`/projects/${id}/git-commit-changes?rev=${encodeURIComponent(rev)}`),

  /** 单条提交详情（hover / 详情面板）。 */
  gitCommit: (id: string, rev: string) =>
    request<CommitInfo>(`/projects/${id}/git-commit?rev=${encodeURIComponent(rev)}`),

  /** 两提交之间某个文件的差异（commits 视图点文件看 diff）。base 缺省 = rev 的父提交。 */
  gitCommitFileDiff: (id: string, rev: string, file: string, base?: string) =>
    request<FileDiffResult>(
      `/projects/${id}/git-commit-file-diff?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(file)}${base ? `&base=${encodeURIComponent(base)}` : ''}`,
    ),

  /** 仓库所有引用（分支 / 标签 / 远程）。 */
  gitRefs: (id: string) => request<{ refs: Array<GitRefName & { commit: string }>; headBranch: string | null }>(`/projects/${id}/git-refs`),

  /** 提交历史视图的写操作（checkout / cherry-pick / 建删分支标签），固定 ?confirm=1。 */
  gitHistoryWrite: (id: string, body: GitHistoryWriteRequest) =>
    request<GitRunResult>(`/projects/${id}/git-history-write?confirm=1`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 命令管理（2026-10-03）：服务状态与启停（重启 / 停止都要 confirm=1）。 */
  serviceStatus: () => request<ServiceStatus>('/service/status'),
  serviceRestart: () =>
    request<{ ok: boolean; restartedBy: string; note?: string }>('/service/restart?confirm=1', { method: 'POST' }),
  serviceStop: () => request<{ ok: boolean; pid: number; note?: string }>('/service/stop?confirm=1', { method: 'POST' }),

  /**
   * 项目命令（FR-0005）：一句话让 code agent 读本项目，得出编译 / 启动 / 停止 / 测试命令。
   * discover 很慢（要等 agent 读完项目），signal 用来「停止等待」。
   */
  projectCommands: (id: string) => request<{ plan: CommandPlan | null }>(`/projects/${id}/commands`),
  discoverCommands: (id: string, prompt: string, signal?: AbortSignal) =>
    request<{ plan: CommandPlan; sessionId: string }>(`/projects/${id}/commands/discover`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
      ...(signal ? { signal } : {}),
    }),
  commandRisk: (id: string, command: string) =>
    request<{ risk: CommandRisk; reason?: string }>(
      `/projects/${id}/commands/risk?command=${encodeURIComponent(command)}`,
    ),
  /** 跑一条命令（cwd 一律是项目根）；confirm=1 是后端的二次确认要求。 */
  runCommand: (id: string, input: { command: string; kind?: CommandKind; background?: boolean }) =>
    request<{ run: CommandRun }>(`/projects/${id}/commands/run?confirm=1`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  stopCommand: (id: string, runId: string) =>
    request<{ run: CommandRun }>(`/projects/${id}/commands/stop`, {
      method: 'POST',
      body: JSON.stringify({ runId }),
    }),
  commandRuns: (id: string) => request<{ runs: CommandRun[] }>(`/projects/${id}/commands/runs`),

  /** 目录选择器：列本机目录（共享模式下后端会 403）。 */
  fsDirs: (path?: string) =>
    request<{ path: string | null; parent: string | null; dirs: Array<{ name: string; path: string }> }>(
      path ? `/fs/dirs?path=${encodeURIComponent(path)}` : '/fs/dirs',
    ),

  fileText: (id: string, path: string) =>
    request<{ file: string; lang: string; text: string; size: number; mtimeMs: number | null }>(
      `/projects/${id}/file?path=${encodeURIComponent(path)}`,
    ),

  /**
   * 2026-10-10：把编辑器里的正文写回磁盘。
   * `baseMtimeMs` 是打开文件时拿到的 mtime：磁盘在编辑期间被改过 → 409（看 `ApiRequestError.status`）。
   */
  saveFile: (id: string, path: string, text: string, baseMtimeMs?: number | null) =>
    request<SaveFileResult>(`/projects/${id}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, text, baseMtimeMs: baseMtimeMs ?? undefined }),
    }),

  /** 2026-10-10：删除文件 / 目录（移到系统回收站）。 */
  deleteEntry: (id: string, path: string) =>
    request<DeleteEntryResult>(`/projects/${id}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),

  gotoDefinition: (id: string, file: string, line: number, col: number) =>
    request<DefinitionResult>(`/projects/${id}/goto-definition`, {
      method: 'POST',
      body: JSON.stringify({ file, line, col }),
    }),

  findReferences: (id: string, args: FindReferencesRequest) =>
    request<ReferenceResult>(`/projects/${id}/find-references`, {
      method: 'POST',
      body: JSON.stringify(args),
    }),

  documentSymbols: (id: string, file: string) =>
    request<{ symbols: SymbolInfo[] }>(
      `/projects/${id}/document-symbols?file=${encodeURIComponent(file)}`,
    ).then((r) => r.symbols),

  workspaceSymbols: (id: string, q: string, kind?: string) =>
    request<{ symbols: SymbolInfo[] }>(
      `/projects/${id}/workspace-symbols?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`,
    ).then((r) => r.symbols),

  /** 语义着色：本项目符号 vs 外部依赖/标准库符号。 */
  highlights: (id: string, file: string) =>
    request<HighlightResult>(`/projects/${id}/highlights?file=${encodeURIComponent(file)}`),

  /** 悬停解释（02-lens §3.1）：光标处是什么、从哪来、被谁用。 */
  hover: (id: string, file: string, line: number, col: number) =>
    request<HoverResult>(`/projects/${id}/hover`, {
      method: 'POST',
      body: JSON.stringify({ file, line, col }),
    }),

  /** 整文件密度概览（02-lens §3.4）：按固定行数分段统计代码/注释/空白占比。 */
  density: (id: string, file: string) =>
    request<FileDensity>(`/projects/${id}/density?file=${encodeURIComponent(file)}`),

  search: (
    id: string,
    query: string,
    options: {
      regex?: boolean;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      filePattern?: string;
      maxResults?: number;
      /** N14：只在指定目录（前缀匹配）内搜索。 */
      dirs?: string[];
    } = {},
    /** N12：中止请求（后端会停止扫描）。 */
    signal?: AbortSignal,
  ) =>
    request<SearchResult>(`/projects/${id}/search`, {
      method: 'POST',
      body: JSON.stringify({ query, options }),
      signal,
    }),

  /**
   * N12：流式搜索（SSE）。每收到一个文件分组的命中就回调一次，客户端可随时 abort。
   * 返回值在 `done` 事件后 resolve。
   */
  searchStream: async (
    id: string,
    query: string,
    options: SearchOptions,
    onChunk: (matches: SearchMatch[], truncated: boolean) => void,
    signal?: AbortSignal,
  ): Promise<{ fileCount: number; truncated: boolean; total: number }> => {
    const res = await fetch(`${BASE}/projects/${id}/search-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, options }),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `search-stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let summary = { fileCount: 0, truncated: false, total: 0 };
    let failure: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (event === 'chunk') {
          onChunk(
            (parsed.matches as SearchMatch[]) ?? [],
            Boolean(parsed.truncated),
          );
        } else if (event === 'done') {
          summary = {
            fileCount: Number(parsed.fileCount ?? 0),
            truncated: Boolean(parsed.truncated),
            total: Number(parsed.total ?? 0),
          };
        } else if (event === 'error') {
          failure = String(parsed.message ?? 'search failed');
        }
      }
    }
    if (failure) throw new Error(failure);
    return summary;
  },

  /** N16：调用层级（in=谁调用我 / out=我调用了谁）。 */
  callHierarchy: (
    id: string,
    args: { file: string; line: number; col: number; direction: CallDirection; depth?: number },
  ) =>
    request<CallHierarchyResult>(`/projects/${id}/call-hierarchy`, {
      method: 'POST',
      body: JSON.stringify(args),
    }),

  /** N17：类型层级（显式继承 / 实现）。 */
  typeHierarchy: (id: string, file: string, line: number, col: number) =>
    request<TypeHierarchyResult>(`/projects/${id}/type-hierarchy`, {
      method: 'POST',
      body: JSON.stringify({ file, line, col }),
    }),

  /** N15：跳到实现（接口 → 实现类 / 实现方法）。 */
  implementations: (id: string, file: string, line: number, col: number) =>
    request<ImplementationsResult>(`/projects/${id}/implementations`, {
      method: 'POST',
      body: JSON.stringify({ file, line, col }),
    }),
};

/** 订阅索引事件（SSE）。返回取消函数。 */
export function subscribeEvents(
  id: string,
  onEvent: (event: { type: string; [k: string]: unknown }) => void,
): () => void {
  const source = new EventSource(`${BASE}/projects/${id}/events`);
  const handler = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(e.data) as { type: string });
    } catch {
      /* 忽略坏事件 */
    }
  };
  for (const type of ['status', 'file-changed', 'file-deleted', 'index-ready']) {
    source.addEventListener(type, handler as EventListener);
  }
  return () => source.close();
}
