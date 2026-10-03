/** HTTP 路由：项目 / 文件 / 代码智能 / 文本搜索 / SSE 事件。 */
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import type {
  ApiError,
  ChangeSnapshotInput,
  ChangeSummary,
  DependencyGraph,
  DependentsResult,
  DirDependentsResult,
  ExplainResult,
  ExplainScope,
  FileDensity,
  FileDiffResult,
  FileHistoryEntry,
  FileSummary,
  GitChangeEntry,
  GitChangesResult,
  FindReferencesRequest,
  FlowKind,
  FlowResult,
  GotoDefinitionRequest,
  GuideRoutesResult,
  HotMetric,
  HoverRequest,
  HoverResult,
  IndexEvent,
  IntegrationManifest,
  HighlightResult,
  BlameLine,
  ReadmapResult,
  ProjectTimeline,
  RegisterProjectRequest,
  SearchOptions,
  SearchResult,
} from '../types';
import type { ProjectRegistry } from '../registry';
import {
  documentSymbols,
  fileDensity,
  findReferences,
  gotoDefinition,
  highlightSpans,
  hover,
  workspaceSymbols,
} from '../indexer/resolver';
import { buildOverview, isTestFile } from '../indexer/insight';
import { callHierarchy, implementationsOf, typeHierarchy } from '../indexer/callgraph';
import { buildGraph, dependentsOf, dirDependentsOf } from '../indexer/graph';
import { buildRoutes } from '../indexer/guide';
import { fileSummary } from '../indexer/summary';
import { buildTimeline, DEFAULT_RECENT_WINDOW_MS, hostLinesFor, markHostOrigins } from '../indexer/timeline';
import { compareSnapshot, readmap } from '../indexer/changes';
import { explainAt } from '../indexer/explain';
import { flowGraph } from '../indexer/flow';
import {
  BLAME_MAX_LINES,
  blame,
  DIFF_MAX_CHARS,
  diffNumstat,
  fileDiff,
  fileHistory,
  isValidRev,
  showFile,
  worktreeChanges,
} from '../indexer/gitread';
import {
  CORS_ORIGINS,
  DATA_DIR,
  FRONTEND_DIST,
  HOST,
  LOCAL_HOSTS,
  PORT,
  SHARE_NOTE_LOCAL,
  SHARE_NOTE_SHARED,
  shareHintFor,
} from '../config';
import { buildIndexReport } from '../indexer/index-report';
import { AGENT_TOOLS_NOTE, agentToolNames, agentToolSpecs, callAgentTool, type AgentCallResult } from './agent';
import { restartService, serviceStatus, stopService } from '../services';

const VERSION = '0.1.0';

/** 热点口径的合法取值（与 shared/types.ts 的 HotMetric 保持一致）。 */
const HOT_METRICS: HotMetric[] = ['files', 'refs', 'symbols', 'defined', 'unique', 'recent'];

const fail = (
  c: Context,
  status: 400 | 403 | 404 | 413 | 415 | 500,
  error: string,
  message?: string,
  extra?: Record<string, unknown>,
) => c.json({ error, message: message ?? error, ...(extra ?? {}) } satisfies ApiError, status);

export function createApp(
  registry: ProjectRegistry,
  frontendDist = FRONTEND_DIST,
  corsOrigins: string[] = CORS_ORIGINS,
): Hono {
  const app = new Hono();

  // CORS 白名单：含 `*` = 默认放开；否则只对命中的 Origin 回显对应值。
  const corsOrigin = corsOrigins.includes('*') ? '*' : corsOrigins;
  app.use('/api/*', cors({ origin: corsOrigin, allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));

  // 同机同目录分享提示（S5a）：仅监听本机时为 null，如何放开见 shareNote。
  const shareHint = shareHintFor();
  const shareNote = shareHint ? SHARE_NOTE_SHARED : SHARE_NOTE_LOCAL;

  const manifest: IntegrationManifest = {
    name: 'web-code-reader',
    version: VERSION,
    apiBase: '/api',
    viewerUrlTemplate: '/?project={projectId}&file={path}&line={line}&col={col}',
    endpoints: {
      openProject: 'POST /api/projects { root, name?, id? }',
      listProjects: 'GET /api/projects',
      lookupProject: 'GET /api/projects/lookup?root=<abs path>',
      projectStatus: 'GET /api/projects/:id/status',
      fileTree: 'GET /api/projects/:id/files',
      fileText: 'GET /api/projects/:id/file?path=<rel path>',
      gotoDefinition: 'POST /api/projects/:id/goto-definition { file, line, col }',
      findReferences: 'POST /api/projects/:id/find-references { file, line, col, includeDeclaration? }',
      documentSymbols: 'GET /api/projects/:id/document-symbols?file=<rel path>',
      workspaceSymbols: 'GET /api/projects/:id/workspace-symbols?q=<query>&kind=&limit=',
      searchText: 'POST /api/projects/:id/search { query, options }',
      searchStream: 'POST /api/projects/:id/search-stream { query, options } (SSE)',
      callHierarchy: 'POST /api/projects/:id/call-hierarchy { file, line, col, direction, depth }',
      typeHierarchy: 'POST /api/projects/:id/type-hierarchy { file, line, col }',
      implementations: 'POST /api/projects/:id/implementations { file, line, col }',
      overview: 'GET /api/projects/:id/overview?hot=files|refs|symbols|defined|unique|recent&denoise=1&limit=&files=1',
      dependencyGraph: 'GET /api/projects/:id/graph?level=dir|file&expand=<dir>&external=<n>',
      dependents: 'GET /api/projects/:id/dependents?file=<rel path>&depth=2',
      dirDependents: 'GET /api/projects/:id/dir-dependents?dir=<dir>&depth=2',
      guideRoutes: 'GET /api/projects/:id/routes',
      fileSummary: 'GET /api/projects/:id/file-summary?file=<rel path>',
      changes: 'POST /api/projects/:id/changes { at, files, noteLocs? }',
      readmap: 'GET /api/projects/:id/readmap',
      fileDiff: 'GET /api/projects/:id/file-diff?path=<rel path>&rev=HEAD',
      blame: 'GET /api/projects/:id/blame?path=<rel path>',
      fileHistory: 'GET /api/projects/:id/file-history?path=<rel path>&limit=20',
      gitShow: 'GET /api/projects/:id/git-show?rev=<sha|HEAD~n>&path=<rel path>',
      explain: 'POST /api/projects/:id/explain { file, line, col, scope }',
      flow: "POST /api/projects/:id/flow { file, line, col, kind: 'calls'|'callers'|'data', depth }",
      timeline: 'GET /api/projects/:id/timeline?window=<minutes>',
      markOrigin: 'POST /api/projects/:id/origin { files: [rel path] | [{ file, lines: [[start,end]] }], clear? }',
      agentLines: 'GET /api/projects/:id/agent-lines?file=<rel path>',
      highlights: 'GET /api/projects/:id/highlights?file=<rel path>',
      hover: 'POST /api/projects/:id/hover { file, line, col }',
      density: 'GET /api/projects/:id/density?file=<rel path>',
      events: 'GET /api/projects/:id/events (SSE)',
      dispose: 'POST /api/projects/:id/dispose',
      resources: 'GET /api/projects/:id/resources',
      agentTools: 'GET /api/agent/tools',
      agentCall: 'POST /api/agent/:id/call { tool, args }',
      agentSymbols: 'GET /api/agent/:id/symbols?q=&kind=&limit=',
      agentOutline: 'GET /api/agent/:id/outline?file=',
      agentFile: 'GET /api/agent/:id/file?path=&start=&end=',
      indexReport: 'GET /api/projects/:id/index-report',
      ignoreRules: 'GET /api/projects/:id/ignore',
      snapshot: 'GET /api/projects/:id/snapshot',
      verify: 'POST /api/projects/:id/verify',
    },
    host: HOST,
    shareHint,
    shareNote,
    agentTools: agentToolSpecs(),
    toolsEndpoint: 'GET /api/agent/tools · POST /api/agent/:id/call { tool, args }',
    toolsNote: AGENT_TOOLS_NOTE,
    disposeEndpoint: 'POST /api/projects/:id/dispose',
    resourcesEndpoint: 'GET /api/projects/:id/resources',
    lifecycleNote:
      '宿主收起面板（iframe 卸载 / wcr:dispose）时调用 dispose：关 watcher、断 SSE、释放内存索引，保留注册表条目；被读目录不受影响。',
    // P17：隐私承诺（可追证：说清读什么 / 写哪里 / 传什么 / 谁在用）
    privacy: {
      network: 'none',
      host: HOST,
      port: PORT,
      writesSource: false,
      dataDir: DATA_DIR,
      reads: '你打开的本机目录里的源码文件（按忽略规则筛选）',
    },
  };

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      name: manifest.name,
      version: VERSION,
      host: HOST,
      network: 'none',
      shareHint,
      shareNote,
    }),
  );
  app.get('/api/integration/manifest', (c) => c.json(manifest));

  // -------------------------------------------------------- agent 只读工具（S8）

  /** 工具清单：每个工具给 name / description / params（JSON Schema 风格）/ endpoint。 */
  app.get('/api/agent/tools', (c) => c.json({ note: AGENT_TOOLS_NOTE, tools: agentToolSpecs() }));

  /** 统一调用入口：body { tool, args }；未知工具 400（附可用工具名），项目不存在 404。 */
  app.post('/api/agent/:id/call', async (c) => {
    const body = await readJson<{ tool?: string; args?: Record<string, unknown> }>(c);
    if (!body?.tool || typeof body.tool !== 'string') {
      return fail(c, 400, 'bad_request', `tool is required；可用工具：${agentToolNames().join(', ')}`);
    }
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    const result = await callAgentTool(registry, c.req.param('id'), body.tool, args);
    return agentResponse(c, result);
  });

  /** 便捷只读入口：与 find_symbol 同一实现，不分叉语义。 */
  app.get('/api/agent/:id/symbols', async (c) => {
    const result = await callAgentTool(registry, c.req.param('id'), 'find_symbol', {
      name: c.req.query('q') ?? c.req.query('name') ?? '',
      kind: c.req.query('kind') ?? null,
      limit: queryNum(c, 'limit'),
    });
    return agentResponse(c, result);
  });

  /** 便捷只读入口：与 file_outline 同一实现。 */
  app.get('/api/agent/:id/outline', async (c) => {
    const result = await callAgentTool(registry, c.req.param('id'), 'file_outline', {
      file: c.req.query('file') ?? '',
    });
    return agentResponse(c, result);
  });

  /** 便捷只读入口：与 read_file 同一实现（path 参数名沿用现有文件端点）。 */
  app.get('/api/agent/:id/file', async (c) => {
    const result = await callAgentTool(registry, c.req.param('id'), 'read_file', {
      file: c.req.query('path') ?? '',
      start: queryNum(c, 'start'),
      end: queryNum(c, 'end'),
    });
    return agentResponse(c, result);
  });

  // ------------------------------------------------------------ 项目管理

  app.get('/api/projects', (c) => c.json({ projects: registry.list() }));

  app.get('/api/projects/lookup', (c) => {
    const root = c.req.query('root');
    if (!root) return fail(c, 400, 'bad_request', 'root is required');
    const project = registry.find(root);
    if (!project) return fail(c, 404, 'not_found', `no project registered for ${root}`);
    return c.json({ project: registry.info(project) });
  });

  app.post('/api/projects', async (c) => {
    let body: RegisterProjectRequest & { path?: string };
    try {
      body = (await c.req.json()) as RegisterProjectRequest;
    } catch {
      return fail(c, 400, 'bad_request', 'invalid JSON body');
    }
    const root = body.root ?? body.path;
    if (!root || typeof root !== 'string') return fail(c, 400, 'bad_request', 'root is required');
    try {
      const { project, created } = await registry.open(root, body.name, body.id);
      return c.json({ project: registry.info(project), created }, created ? 201 : 200);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOTDIR' || code === 'ENOENT') {
        return fail(c, 400, 'not_a_directory', `目录不存在：${root}`);
      }
      return fail(c, 500, 'open_failed', e instanceof Error ? e.message : String(e));
    }
  });

  app.get('/api/projects/:id', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    return c.json({ project: registry.info(project) });
  });

  app.delete('/api/projects/:id', async (c) => {
    const removed = await registry.forget(c.req.param('id'));
    if (!removed) return fail(c, 404, 'project_not_found');
    return c.json({ ok: true });
  });

  app.post('/api/projects/:id/reindex', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    void project.reindexAll();
    return c.json({ ok: true, status: { ...project.status, indexing: true } });
  });

  /** P9：索引报告 —— 哪些文件没进索引 / 为什么 / 编码分布。 */
  app.get('/api/projects/:id/index-report', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    return c.json(buildIndexReport(project));
  });

  /** P8：生效的忽略规则与命中统计。 */
  app.get('/api/projects/:id/ignore', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    return c.json(project.ignoreInfo());
  });

  /** P4：索引快照状态（是否存在 / 写入时间 / 指纹是否匹配）。 */
  app.get('/api/projects/:id/snapshot', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    return c.json(project.snapshotStatus());
  });

  /** P7：立即对账一次，返回差异清单（并自动修复）。 */
  app.post('/api/projects/:id/verify', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const result = await project.verify();
    return c.json(result);
  });

  app.get('/api/projects/:id/status', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    return c.json({ status: project.status });
  });

  // -------------------------------------------------------------- 命令管理（2026-10-03）

  /**
   * 服务状态：pid / 端口 / 运行时长 / 日志路径。
   * 只在**本机模式**下可见可用 —— 共享出去以后不给看机器的运行信息。
   */
  const serviceGuarded = (c: Context): Response | null => {
    if (!LOCAL_HOSTS.has(HOST)) {
      return fail(c, 403, 'disabled_in_share_mode', '共享模式下不提供命令管理（只读阅读）');
    }
    return null;
  };

  app.get('/api/service/status', async (c) => {
    const denied = serviceGuarded(c);
    if (denied) return denied;
    return c.json(await serviceStatus());
  });

  /** 重启：交给独立 worker（自己杀自己之后没人能把它拉起来）。需要 ?confirm=1。 */
  app.post('/api/service/restart', async (c) => {
    const denied = serviceGuarded(c);
    if (denied) return denied;
    if (c.req.query('confirm') !== '1') {
      return fail(c, 400, 'confirm_required', '重启需要二次确认（?confirm=1）');
    }
    const { via } = await restartService();
    return c.json({ ok: true, restartedBy: via, note: '本服务将在约 0.5 秒后退出，由 worker 拉起新进程' });
  });

  /** 停止：同样需要 ?confirm=1。 */
  app.post('/api/service/stop', async (c) => {
    const denied = serviceGuarded(c);
    if (denied) return denied;
    if (c.req.query('confirm') !== '1') {
      return fail(c, 400, 'confirm_required', '停止需要二次确认（?confirm=1）');
    }
    const { pid } = await stopService();
    return c.json({ ok: true, pid, note: '服务正在退出；重新启动请看 README 的 `npm start`' });
  });

  // -------------------------------------------------------------- 命令管理结束

  // -------------------------------------------------------------- 文件

  /**
   * 目录选择器（2026-10-03 用户要求：打开本机目录不能只靠手输路径）。
   * 只列目录名，不读任何文件内容；不传 path 时给「起点」（Windows 给盘符，其余给 $HOME 与 /）。
   * 共享模式（HOST 不是本机）下禁用：那等于把整台机器的目录树暴露给局域网。
   */
  app.get('/api/fs/dirs', async (c) => {
    if (!LOCAL_HOSTS.has(HOST)) {
      return fail(c, 403, 'disabled_in_share_mode', '共享模式下禁用了目录浏览（只读已知项目）');
    }
    const raw = (c.req.query('path') ?? '').trim();
    if (!raw) {
      const roots: Array<{ name: string; path: string }> = [];
      if (process.platform === 'win32') {
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          const drive = `${letter}:\\`;
          try {
            await fsp.access(drive);
            roots.push({ name: drive, path: drive });
          } catch {
            /* 不存在的盘符跳过 */
          }
        }
      } else {
        roots.push({ name: '/', path: '/' });
      }
      roots.push({ name: '主目录', path: os.homedir() });
      return c.json({ path: null, parent: null, dirs: roots });
    }
    const abs = path.resolve(raw);
    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return fail(c, 404, 'dir_not_found', `目录不可读：${abs}`);
    }
    const dirs = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    return c.json({ path: abs, parent: parent === abs ? null : parent, dirs });
  });

  app.get('/api/projects/:id/files', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    return c.json({ tree: project.buildFileTree(), status: project.status });
  });

  /**
   * 2026-10-03 用户要求：文件树要显示项目的**所有**文件，不只是能检索的那些。
   * 这条端点连二进制、资源、被规则忽略的文件一并给出（仅跳过 node_modules/.git 这类噪声目录）。
   */
  app.get('/api/projects/:id/all-files', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    return c.json({ tree: project.buildAllFileTree(), status: project.status });
  });

  app.get('/api/projects/:id/file', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const rel = c.req.query('path');
    if (!rel) return fail(c, 400, 'bad_request', 'path is required');
    if (!project.resolveInside(rel)) return fail(c, 400, 'path_escape', '路径越界');
    const file = await project.readText(rel);
    // 读不到时给「为什么」：二进制与过大是两回事，前端要分别说清楚
    if (!file) {
      const info = project.fileStatus(rel);
      if (info?.binary) return fail(c, 415, 'binary_file', `二进制 / 资源文件，不支持预览：${rel}`);
      if (info && info.size > 0) {
        return fail(c, 413, 'file_too_large', `文件太大，不支持预览：${rel}（${info.size} 字节）`, {
          size: info.size,
        });
      }
      return fail(c, 404, 'file_not_found', `无法读取：${rel}`);
    }
    return c.json({ file: rel, lang: file.lang, text: file.text, size: file.size });
  });

  // ---------------------------------------------------------------- 项目地图

  /** 概览：身份卡 / 语言分布 / 从哪看起 / 热点 / 孤立 / 指标 / 环 / 最近改动。 */
  app.get('/api/projects/:id/overview', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const raw = c.req.query('hot');
    const hot: HotMetric = HOT_METRICS.includes(raw as HotMetric) ? (raw as HotMetric) : 'files';
    const denoise = c.req.query('denoise') !== '0';
    const limit = Number(c.req.query('limit') ?? 12);
    const files = c.req.query('files') === '1';
    const overview = await buildOverview(project, {
      hot,
      denoise,
      limit: Number.isFinite(limit) ? limit : 12,
      files,
    });
    return c.json(overview);
  });

  /** 依赖图：目录级聚合（可展开到文件级）+ 外部依赖 + 环 + 职责泳道（M4.2/M4.3）。 */
  app.get('/api/projects/:id/graph', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const level = c.req.query('level') === 'file' ? 'file' : 'dir';
    const rawExpand = c.req.query('expand') ?? '';
    // `expand=.` 表示展开根目录（空串），`expand=` 不带任何目录
    const expand = rawExpand
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter((s) => s === '.' || (s.length > 0 && !s.includes('..')))
      .map((s) => (s === '.' ? '' : s));
    const rawExternal = Number(c.req.query('external') ?? 20);
    const external = Number.isFinite(rawExternal) ? Math.max(0, Math.min(rawExternal, 100)) : 20;
    // focus：是否把入口 / 热点提到文件级。传 `focus=-` 或不传即「不提升」（目录级视图更干净）。
    const rawFocus = c.req.query('focus');
    const focus =
      rawFocus === undefined || rawFocus === '-'
        ? []
        : rawFocus
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    // 目录职责与分层复用概览的同一次计算，避免重复 IO
    const overview = await buildOverview(project, { limit: 3 });
    const graph: DependencyGraph = buildGraph(project, {
      level,
      expand,
      external,
      focus,
      duties: overview.dirs,
    });
    return c.json(graph);
  });

  /** 目录级反向依赖（M6.2）：我动的这块，外面有几个入口依赖。 */
  app.get('/api/projects/:id/dir-dependents', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const raw = c.req.query('dir');
    if (raw === undefined) return fail(c, 400, 'bad_request', 'dir is required（根目录传 .）');
    const dir = raw === '.' ? '' : raw.replace(/\/+$/, '');
    if (dir.includes('..') || (dir && !project.entries.has(dir))) {
      return fail(c, 400, 'bad_request', `目录不存在：${raw}`);
    }
    const rawDepth = Number(c.req.query('depth') ?? 2);
    const depth = Number.isFinite(rawDepth) ? rawDepth : 2;
    const result: DirDependentsResult = dirDependentsOf(project, dir, depth);
    return c.json(result);
  });

  /** 反向依赖：谁引用了它（文件级）+ N 跳传递上游 + 覆盖它的测试。 */
  app.get('/api/projects/:id/dependents', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('file');
    if (!file) return fail(c, 400, 'bad_request', 'file is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    const rawDepth = Number(c.req.query('depth') ?? 2);
    const depth = Number.isFinite(rawDepth) ? rawDepth : 2;
    const result: DependentsResult = dependentsOf(project, file, depth);
    return c.json(result);
  });

  // ---------------------------------------------------------------- 向导（04 Guide）

  /** G2.1–G2.4：四条阅读路线（依赖序 / 入口向下 / 热度序 / 新鲜度序）一次算全。 */
  app.get('/api/projects/:id/routes', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const result: GuideRoutesResult = buildRoutes(project);
    return c.json(result);
  });

  /** G6.1 / G6.3 / G6.4：文件级结构性摘要（导出 / 依赖 / 被引用 + 模板化中文句）。 */
  app.get('/api/projects/:id/file-summary', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('file');
    if (!file) return fail(c, 400, 'bad_request', 'file is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    // 非源码 / 过大 / 不存在的文件没进符号索引 —— 如实 404，不编一份空摘要
    const summary: FileSummary | null = fileSummary(project, file);
    if (!summary) return fail(c, 404, 'not_indexed', `不在符号索引内：${file}`);
    return c.json(summary);
  });

  /** G8.2：阅读快照的数据源（只列索引内源码文件的 mtime / size / 行数，不重扫磁盘）。 */
  app.get('/api/projects/:id/readmap', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const result: ReadmapResult = readmap(project);
    return c.json(result);
  });

  /** G8.1–G8.3：`{snapshot}` → 变更清单（M/A/D + 增删行 + 「笔记所在文件被改动」标记）。 */
  app.post('/api/projects/:id/changes', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<ChangeSnapshotInput>(c);
    if (!body || typeof body.at !== 'number' || !Number.isFinite(body.at) || !body.files || typeof body.files !== 'object') {
      return fail(c, 400, 'bad_request', 'at / files are required');
    }
    const result: ChangeSummary = await compareSnapshot(project, body);
    return c.json(result);
  });

  /**
   * 变更（2026-10-03 用户要求：以 git 为基础，不自记录）：
   * `git status` 的改动清单 + `git diff --numstat HEAD` 的增删行数。
   * 非 git 仓库如实返回 isRepo=false，不用「自记录快照」凑数字。
   */
  app.get('/api/projects/:id/git-changes', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const changes = await worktreeChanges(project.root);
    const numstat = changes.isRepo ? await diffNumstat(project.root, 'HEAD') : null;
    const statByFile = new Map((numstat ?? []).map((n) => [n.file, n]));
    const LIMIT = 500;
    const entries: GitChangeEntry[] = changes.entries.slice(0, LIMIT).map((e) => {
      const st = statByFile.get(e.file);
      return {
        file: e.file,
        status: e.status,
        ...(e.from ? { from: e.from } : {}),
        added: st?.added ?? null,
        removed: st?.removed ?? null,
        binary: st?.binary ?? false,
        isTest: isTestFile(e.file),
      };
    });
    const result: GitChangesResult = {
      isRepo: changes.isRepo,
      branch: changes.branch,
      entries,
      truncated: Math.max(0, changes.entries.length - LIMIT),
    };
    return c.json(result);
  });

  /** G7.2：只读 diff（rev 缺省 = 工作区 vs HEAD）；无 git → 200 + diff:null + reason。 */
  app.get('/api/projects/:id/file-diff', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('path');
    if (!file) return fail(c, 400, 'bad_request', 'path is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    const rev = (c.req.query('rev') ?? 'HEAD').trim() || 'HEAD';
    if (!isValidRev(rev)) return fail(c, 400, 'bad_rev', `非法 rev：${rev}`);
    const diff = await fileDiff(project.root, file, rev);
    if (diff === null) {
      const missing: FileDiffResult = { file, rev, diff: null, reason: 'no-git' };
      return c.json(missing);
    }
    const truncated = diff.length > DIFF_MAX_CHARS;
    const result: FileDiffResult = {
      file,
      rev,
      diff: truncated ? diff.slice(0, DIFF_MAX_CHARS) : diff,
      truncated,
    };
    return c.json(result);
  });

  /** G7.3：行级 blame。超大文件（> 5000 行）不展开，如实给 truncated 说明，不假装没有 git。 */
  app.get('/api/projects/:id/blame', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('path');
    if (!file) return fail(c, 400, 'bad_request', 'path is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    const lines = await blame(project.root, file);
    if (lines === null) {
      const fi = project.files.get(file);
      const fileLines = fi ? fi.source.split('\n').length : 0;
      const tooLarge = fileLines > BLAME_MAX_LINES;
      return c.json({
        file,
        lines: [] as BlameLine[],
        truncated: tooLarge,
        reason: tooLarge ? 'too-large' : 'no-git',
      });
    }
    return c.json({ file, lines, truncated: false });
  });

  /** G7.4：文件级提交历史（`--follow`）；无 git → 空清单 + reason。 */
  app.get('/api/projects/:id/file-history', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('path');
    if (!file) return fail(c, 400, 'bad_request', 'path is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    const rawLimit = Number(c.req.query('limit') ?? 20);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    const commits = await fileHistory(project.root, file, limit);
    const result = {
      file,
      commits: (commits ?? []) as FileHistoryEntry[],
      ...(commits === null ? { reason: 'no-git' } : {}),
    };
    return c.json(result);
  });

  /** G7.5：历史版本正文（只读快照，不落盘）；rev / path 非法 → 400。 */
  app.get('/api/projects/:id/git-show', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const rev = c.req.query('rev');
    const file = c.req.query('path');
    if (!rev || !file) return fail(c, 400, 'bad_request', 'rev / path are required');
    if (!isValidRev(rev)) return fail(c, 400, 'bad_rev', `非法 rev：${rev}`);
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    const text = await showFile(project.root, rev, file);
    if (text === null) return fail(c, 400, 'bad_revision', `该版本里读不到这个文件：${rev}:${file}`);
    return c.json({ file, rev, text });
  });

  /** G5.2 / G5.3：结构性解释（纯静态）；定位不到项目内符号 → 404 `no-symbol`。 */
  app.post('/api/projects/:id/explain', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{ file?: string; line?: number; col?: number; scope?: string }>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    const line = Number(body.line ?? 1);
    const col = Number(body.col ?? 1);
    if (!Number.isFinite(line) || !Number.isFinite(col) || line < 1 || col < 1) {
      return fail(c, 400, 'bad_request', 'line/col must be positive numbers');
    }
    const scope: ExplainScope =
      body.scope === 'selection' || body.scope === 'callers' ? body.scope : 'symbol';
    const result: ExplainResult | null = explainAt(project, { file: body.file, line, col, scope });
    if (!result) return fail(c, 404, 'no-symbol', '光标处没有可解释的项目内符号');
    return c.json(result);
  });

  /** G9.1–G9.3：流视图图数据（calls / callers / data）；定位不到 → 404 `no-symbol`。 */
  app.post('/api/projects/:id/flow', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{
      file?: string;
      line?: number;
      col?: number;
      kind?: string;
      depth?: number;
    }>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    const line = Number(body.line ?? 1);
    const col = Number(body.col ?? 1);
    if (!Number.isFinite(line) || !Number.isFinite(col) || line < 1 || col < 1) {
      return fail(c, 400, 'bad_request', 'line/col must be positive numbers');
    }
    const kind: FlowKind = body.kind === 'callers' || body.kind === 'data' ? body.kind : 'calls';
    const rawDepth = Number(body.depth ?? 1);
    const result: FlowResult | null = flowGraph(project, {
      file: body.file,
      line,
      col,
      kind,
      depth: Number.isFinite(rawDepth) ? rawDepth : 1,
    });
    if (!result) return fail(c, 404, 'no-symbol', '光标处没有可解释的项目内符号');
    return c.json(result);
  });

  // ------------------------------------------------------------ 时间与来源

  /** 改动时间轴：mtime 分组 + 只读 git 批次 + 来源判定（带置信度）。 */
  app.get('/api/projects/:id/timeline', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const minutes = Number(c.req.query('window') ?? 30);
    const windowMs =
      Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_RECENT_WINDOW_MS;
    const timeline: ProjectTimeline = await buildTimeline(project, { windowMs });
    return c.json(timeline);
  });

  /** 宿主（xchen 等）上报本轮 agent 产出的文件清单 —— 「AI 生成标记」的可信来源。 */
  app.post('/api/projects/:id/origin', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{
      files?: Array<string | { file: string; lines?: Array<[number, number]> }>;
      clear?: boolean;
    }>(c);
    if (!Array.isArray(body?.files) && body?.clear !== true) {
      return fail(c, 400, 'bad_request', 'files 或 clear 至少给一个');
    }
    const entries = (body?.files ?? []).filter(
      (f): f is string | { file: string; lines?: Array<[number, number]> } =>
        typeof f === 'string' || (typeof f === 'object' && f !== null && typeof f.file === 'string'),
    );
    const count = markHostOrigins(project.id, entries, body?.clear === true);
    return c.json({ ok: true, tracked: count });
  });

  /**
   * 某个文件被宿主声明的 agent 变更行（M10.2）：编辑器用它画行内标记。
   * 没上报过行范围时返回空数组 —— 绝不把「文件级标记」当成「全部行都改了」。
   */
  app.get('/api/projects/:id/agent-lines', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('file');
    if (!file) return fail(c, 400, 'bad_request', 'file is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    return c.json({ file, lines: hostLinesFor(project.id, file) });
  });

  // ---------------------------------------------------------- 代码智能

  app.post('/api/projects/:id/goto-definition', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<GotoDefinitionRequest>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    const result = gotoDefinition(project, body.file, body.line ?? 1, body.col ?? 1);
    return c.json(result);
  });

  app.post('/api/projects/:id/find-references', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<FindReferencesRequest>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    const result = findReferences(
      project,
      body.file,
      body.line ?? 1,
      body.col ?? 1,
      body.includeDeclaration ?? false,
    );
    // 测试文件标注在后端做（03-navigator Q11）：口径与 01 地图降噪共用 insight.isTestFile
    return c.json({
      ...result,
      locations: result.locations.map((loc) => ({ ...loc, isTest: isTestFile(loc.file) })),
    });
  });

  app.get('/api/projects/:id/document-symbols', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('file');
    if (!file) return fail(c, 400, 'bad_request', 'file is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    return c.json({ symbols: documentSymbols(project, file) });
  });

  app.get('/api/projects/:id/workspace-symbols', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const q = c.req.query('q') ?? '';
    const kind = c.req.query('kind') ?? null;
    const limit = Number(c.req.query('limit') ?? 100);
    // 测试文件来源的符号单独标注（N8），判定与 01 地图降噪同源
    const symbols = workspaceSymbols(project, q, kind, limit).map((s) => ({
      ...s,
      isTest: isTestFile(s.location.file),
    }));
    return c.json({ symbols });
  });

  app.post('/api/projects/:id/search', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{ query?: string; options?: SearchOptions }>(c);
    const query = (body?.query ?? '').toString();
    if (!query) return fail(c, 400, 'bad_request', 'query is required');
    try {
      const result: SearchResult = await project.searchText(query, body?.options ?? {}, c.req.raw.signal);
      // 测试文件标注在后端做（N11）：口径与 01 地图降噪共用 insight.isTestFile
      return c.json({
        ...result,
        matches: result.matches.map((m) => ({ ...m, isTest: isTestFile(m.file) })),
      });
    } catch (e) {
      return fail(c, 400, 'bad_query', e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * N12：流式搜索。按文件推 chunk（结果边出边看），客户端断开即停止扫描。
   * 事件：chunk = { matches, truncated } / done = { fileCount, truncated, total }。
   */
  app.post('/api/projects/:id/search-stream', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{ query?: string; options?: SearchOptions }>(c);
    const query = (body?.query ?? '').trim();
    if (!query) return fail(c, 400, 'bad_request', 'query is required');
    const abort = new AbortController();
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abort.abort());
      try {
        const result = await project.searchText(query, body?.options ?? {}, abort.signal, (matches, truncated) => {
          void stream.writeSSE({
            event: 'chunk',
            data: JSON.stringify({ matches: matches.map((m) => ({ ...m, isTest: isTestFile(m.file) })), truncated }),
          });
        });
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            fileCount: result.fileCount,
            truncated: result.truncated,
            total: result.matches.length,
          }),
        });
      } catch (e) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: e instanceof Error ? e.message : String(e) }),
        });
      }
    });
  });

  // ---------------------------------------------------- 调用层级 / 类型层级（N16/N17/N15）

  /** 调用层级：in=谁调用我，out=我调用了谁；depth 1~3。 */
  app.post('/api/projects/:id/call-hierarchy', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{ file?: string; line?: number; col?: number; direction?: string; depth?: number }>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    const direction = body.direction === 'out' ? 'out' : 'in';
    const depth = Number.isFinite(body.depth) ? Number(body.depth) : 1;
    return c.json(callHierarchy(project, body.file, body.line ?? 1, body.col ?? 1, direction, depth));
  });

  /** 类型层级：显式继承 / 实现的双向列表。 */
  app.post('/api/projects/:id/type-hierarchy', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{ file?: string; line?: number; col?: number }>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    return c.json(typeHierarchy(project, body.file, body.line ?? 1, body.col ?? 1));
  });

  /** 跳到实现：接口 / 抽象方法 → 实现它的类或同名方法。 */
  app.post('/api/projects/:id/implementations', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<{ file?: string; line?: number; col?: number }>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    return c.json(implementationsOf(project, body.file, body.line ?? 1, body.col ?? 1));
  });

  // ---------------------------------------------------------- 语义着色

  /** 本项目符号 vs 外部依赖符号：供前端提亮 / 压暗。 */
  app.get('/api/projects/:id/highlights', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('file');
    if (!file) return fail(c, 400, 'bad_request', 'file is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    const result: HighlightResult = {
      file,
      data: highlightSpans(project, file),
      kinds: ['project', 'external', 'local'],
      revision: String(project.indexVersion),
    };
    return c.json(result);
  });

  // ---------------------------------------------------------------- 透镜（悬停）

  /** 悬停解释（02-lens）：定义 / 字面量 / 失败态，只陈述索引里确定的事实。 */
  app.post('/api/projects/:id/hover', async (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const body = await readJson<HoverRequest>(c);
    if (!body?.file) return fail(c, 400, 'bad_request', 'file/line/col are required');
    if (!project.resolveInside(body.file)) return fail(c, 400, 'path_escape', '路径越界');
    const line = Number(body.line ?? 1);
    const col = Number(body.col ?? 1);
    if (!Number.isFinite(line) || !Number.isFinite(col) || line < 1 || col < 1) {
      return fail(c, 400, 'bad_request', 'line/col must be positive numbers');
    }
    const result: HoverResult = hover(project, body.file, line, col);
    return c.json(result);
  });

  /** 整文件密度（L10）：按固定行数分段的代码 / 注释 / 空白占比。 */
  app.get('/api/projects/:id/density', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const file = c.req.query('file');
    if (!file) return fail(c, 400, 'bad_request', 'file is required');
    if (!project.resolveInside(file)) return fail(c, 400, 'path_escape', '路径越界');
    const result: FileDensity = fileDensity(project, file);
    return c.json(result);
  });

  // ---------------------------------------------------------------- SSE

  /**
   * S9c：按项目登记 SSE 连接的关闭把手。
   * 宿主收起面板时要能**立即**断开，而不是等 15 秒的 ping 周期或浏览器自己超时。
   */
  const sseStreams = new Map<string, Set<() => void>>();

  app.get('/api/projects/:id/events', (c) => {
    const project = registry.get(c.req.param('id'));
    if (!project) return fail(c, 404, 'project_not_found');
    const projectId = project.id;
    return streamSSE(c, async (stream) => {
      const send = (event: IndexEvent) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      };
      send({ type: 'status', status: { ...project.status } });
      const unsubscribe = project.subscribe(send);
      let closed = false;
      const close = () => {
        closed = true;
        void stream.close();
      };
      const closers = sseStreams.get(projectId) ?? new Set<() => void>();
      sseStreams.set(projectId, closers);
      closers.add(close);
      stream.onAbort(() => unsubscribe());
      // ping 周期 15 秒，但按 500ms 切片等：dispose 最多 0.5 秒就能断开
      while (!closed && !stream.aborted) {
        let waited = 0;
        while (waited < 15000 && !closed && !stream.aborted) {
          await stream.sleep(500);
          waited += 500;
        }
        if (closed || stream.aborted) break;
        await stream.writeSSE({ event: 'ping', data: '{}' });
      }
      closers.delete(close);
      if (closers.size === 0) sseStreams.delete(projectId);
      unsubscribe();
    });
  });

  // --------------------------------------------------- S9c 资源视图 / 释放

  /** 资源视图：宿主用来自证「收起面板后没有残留」。peek 不触发索引。 */
  app.get('/api/projects/:id/resources', (c) => {
    const id = c.req.param('id');
    if (!registry.peek(id)) return fail(c, 404, 'project_not_found');
    return c.json(registry.resources(id, sseStreams.get(id)?.size ?? 0));
  });

  /**
   * 释放一个项目的运行资源：关 watcher、断该项目的 SSE、释放内存索引。
   * 注册表条目保留（再次打开会自动重建索引），磁盘上的文件一个都不动；重复调用幂等。
   */
  app.post('/api/projects/:id/dispose', async (c) => {
    const id = c.req.param('id');
    if (!registry.peek(id)) return fail(c, 404, 'project_not_found');
    const closers = sseStreams.get(id);
    const closedStreams = closers?.size ?? 0;
    closers?.forEach((close) => close());
    closers?.clear();
    sseStreams.delete(id);
    const info = await registry.dispose(id);
    return c.json({ ok: true, ...info, closedStreams });
  });

  // ------------------------------------------------------ 前端静态资源

  const relDist = path.relative(process.cwd(), frontendDist).split(path.sep).join('/');
  app.use('/*', serveStatic({ root: relDist }));
  app.get('*', serveStatic({ path: `${relDist}/index.html` }));

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'internal_error', message }, 500);
  });

  return app;
}

/** 读一个数字查询参数（缺省 / 非数字返回 undefined，由工具层用默认值）。 */
function queryNum(c: Context, key: string): number | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** agent 工具结果 → HTTP：200 原样返回工具输出，其余透传错误体与状态。 */
function agentResponse(c: Context, result: AgentCallResult) {
  const status = result.status === 200 ? 200 : (result.status as 400 | 404 | 500);
  return c.json(result.body, status);
}

async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}
