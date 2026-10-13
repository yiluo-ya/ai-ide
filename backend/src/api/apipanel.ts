/**
 * API 面板（FR-0001）：`.api/` 目录的读写、接口树、请求转发与导出。
 *
 * 数据以项目根下的 `.api/` 目录为唯一事实源（方便 code agent / 其他项目直接读文件）：
 *
 *   <项目根>/.api/
 *     README.md           给 AI / 人读的协议说明
 *     environments.json   多套环境 + 当前选中（见 ApiEnvironments）
 *     collections/        接口按目录递归存放，`*.json` 是一个接口
 *
 * 接口 json 遵循 `ApiRequestDef`（name / method / url / headers / body / description）。
 * 变量用 `{{key}}` 引用，替换由调用方完成；`sendRequest` 只做纯 HTTP 转发（绕过浏览器 CORS）。
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import type {
  ApiDeleteRequest,
  ApiEnvironments,
  ApiExportResult,
  ApiRenameRequest,
  ApiRequestDef,
  ApiSaveRequest,
  ApiSendRequest,
  ApiSendResult,
  ApiTreeNode,
  ApiTreeResult,
} from '../types';

/** `.api` 目录名。 */
const API_DIR = '.api';
/** 接口集合目录（`.api` 下）。 */
const COLLECTIONS_DIR = 'collections';
/** 环境文件（`.api` 下）。 */
const ENV_FILE = 'environments.json';
/** 说明文件（`.api` 下）。 */
const README_FILE = 'README.md';

/** 默认 README 内容：讲清目录布局、字段约定、变量替换、如何新增接口（AI 读它即可自主产出）。 */
export const API_README = `# .api 接口约定

本目录是「精简 Post 工具」的数据源：接口与环境都以 JSON 文件形式存在，
人、code agent 或任意脚本都能直接读写，无需经过某个服务。

## 目录布局

\`\`\`
.api/
  README.md          本文件
  environments.json  环境（可多套，见下）
  collections/       接口，递归目录树；每个 .json 是一个接口
\`\`\`

## environments.json

\`\`\`json
{
  "environments": [
    { "name": "开发环境", "variables": { "baseUrl": "http://localhost:8080", "token": "dev-123" } },
    { "name": "生产环境", "variables": { "baseUrl": "https://api.example.com", "token": "" } }
  ],
  "active": "开发环境"
}
\`\`\`

字段：\`environments\` 是多套环境，\`active\` 是当前选中那套的名字。

## 接口文件（collections/ 下任意层级的 *.json）

\`\`\`json
{
  "name": "创建用户",
  "method": "POST",
  "url": "{{baseUrl}}/users",
  "headers": { "Content-Type": "application/json" },
  "body": { "name": "{{userName}}" },
  "description": "创建一个用户"
}
\`\`\`

字段：
- \`name\`（必填）接口名，也是树里的展示名；
- \`method\`（必填）HTTP 方法：GET / POST / PUT / DELETE / PATCH 等；
- \`url\`（必填）完整地址，可用 \`{{key}}\` 引用环境变量；
- \`headers\`（可选）请求头对象；
- \`body\`（可选）请求体（对象或字符串都可以）；
- \`description\`（可选）备注。

## 变量替换

请求里（url / headers / body）出现 \`{{key}}\` 时，替换成 \`active\` 环境下 \`variables[key]\` 的值；
找不到 \`key\` 时保留原样（不报错）。切环境 = 改 \`environments.json\` 的 \`active\` 字段。

## 怎么新增一个接口

在 \`collections/\` 下任意层级建一个 \`.json\` 文件（文件名随意），按上面的字段填好即可。
目录可任意多级嵌套：\`collections/订单/创建订单.json\` 会渲染成「订单」目录下的「创建订单」。

后端也暴露了等价 REST 端点（供 agent / 脚本用，见 README 所在项目后端）：

- \`GET  /api/projects/:id/apis/tree\`     读整棵 \`.api\` 树
- \`POST /api/projects/:id/apis/save\`     写一个接口 / 目录 / 环境
- \`POST /api/projects/:id/apis/delete\`   删一个接口 / 目录
- \`POST /api/projects/:id/apis/send\`     转发一次真实 HTTP 请求（返回响应）
- \`GET  /api/projects/:id/apis/export\`   导出 postman / swagger
`;

/** `.api` 根的绝对路径。 */
export function apiRoot(projectRoot: string): string {
  return path.join(projectRoot, API_DIR);
}

/** 把「相对 `.api` 的路径」安全解析成绝对路径；越界返回 null。 */
function resolveInside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const norm = path.resolve(root);
  if (abs !== norm && !abs.startsWith(norm + path.sep)) return null;
  return abs;
}

/** 读单个 `.json`（容错：坏 JSON 返回 null）。 */
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 把接口文件内容解析成 ApiRequestDef；读不到 / 坏 JSON 返回 null。 */
async function readRequestDef(file: string): Promise<ApiRequestDef | null> {
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as ApiRequestDef;
    if (typeof parsed?.name !== 'string' || typeof parsed?.method !== 'string' || typeof parsed?.url !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 递归构建 `collections/` 的目录树。 */
async function buildTree(dir: string, relBase: string): Promise<ApiTreeNode[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: ApiTreeNode[] = [];
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        path: rel,
        type: 'dir',
        children: await buildTree(abs, rel),
      });
    } else if (e.isFile() && e.name.endsWith('.json')) {
      const def = await readRequestDef(abs);
      nodes.push({
        name: def?.name ?? e.name,
        path: rel,
        type: def ? 'request' : 'file',
        method: def?.method,
      });
    } else if (e.isFile()) {
      nodes.push({ name: e.name, path: rel, type: 'file' });
    }
  }
  // 目录在前、文件在后，各自按名排序
  const kind = (n: ApiTreeNode) => (n.type === 'dir' ? 0 : 1);
  nodes.sort((a, b) => kind(a) - kind(b) || a.name.localeCompare(b.name));
  return nodes;
}

/** 读整棵 `.api` 树（环境 + 集合树 + README）。 */
export async function readApiTree(projectRoot: string): Promise<ApiTreeResult> {
  const root = apiRoot(projectRoot);
  const envPath = path.join(root, ENV_FILE);
  const collPath = path.join(root, COLLECTIONS_DIR);
  const readmePath = path.join(root, README_FILE);

  let environments: ApiEnvironments | null = null;
  const envRaw = await readJson<ApiEnvironments>(envPath);
  if (envRaw && Array.isArray(envRaw.environments)) {
    environments = { ...envRaw, active: typeof envRaw.active === 'string' ? envRaw.active : '' };
    if (!environments.environments.some((e) => e.name === environments!.active)) {
      environments.active = environments.environments[0]?.name ?? '';
    }
  }

  let initialized = true;
  try {
    await fsp.access(root);
  } catch {
    initialized = false;
  }

  const tree = initialized ? await buildTree(collPath, '') : [];
  const readme = await fsp.readFile(readmePath, 'utf8').catch(() => null);

  return { root, initialized, environments, tree, readme };
}

/** 确保 `.api` 目录存在；首次创建时写入 README 与空的 environments.json。 */
export async function ensureApi(projectRoot: string): Promise<{ initialized: boolean; root: string }> {
  const root = apiRoot(projectRoot);
  const collPath = path.join(root, COLLECTIONS_DIR);
  const existed = await fsp.access(root).then(
    () => true,
    () => false,
  );

  await fsp.mkdir(collPath, { recursive: true });

  if (!existed) {
    await fsp.writeFile(path.join(root, README_FILE), API_README, 'utf8');
    const defaultEnv: ApiEnvironments = {
      environments: [{ name: '开发环境', variables: { baseUrl: 'http://localhost:8080' } }],
      active: '开发环境',
    };
    await fsp.writeFile(path.join(root, ENV_FILE), JSON.stringify(defaultEnv, null, 2) + '\n', 'utf8');
  }

  // 若项目是 git 仓库，把 `.api/` 加进 `.gitignore`，避免接口/env 被提交（敏感值会跟着漏出去）。
  await ignoreApiInGit(projectRoot);

  return { initialized: existed, root };
}

/** 项目是 git 仓库时，把 `.api/` 追加进 `.gitignore`（已存在则不动）。 */
async function ignoreApiInGit(projectRoot: string): Promise<void> {
  const gitDir = path.join(projectRoot, '.git');
  const isRepo = await fsp.stat(gitDir).then(
    (s) => s.isDirectory() || s.isFile(),
    () => false,
  );
  if (!isRepo) return;

  const gitignore = path.join(projectRoot, '.gitignore');
  const text = await fsp.readFile(gitignore, 'utf8').catch(() => '');
  const lines = text.split(/\r?\n/);
  // 已含 `.api/`（或精确 `.api`）就不再追加
  if (lines.some((l) => l.trim() === '.api/' || l.trim() === '.api')) return;

  const entry = text && !text.endsWith('\n') ? '\n.api/\n' : '.api/\n';
  await fsp.appendFile(gitignore, entry, 'utf8').catch(() => {
    /* 写 .gitignore 失败不阻断主流程 */
  });
}

/** 写接口 / 目录 / 环境（`ApiSaveRequest`）。目录以 `/` 结尾。 */
export async function saveApi(projectRoot: string, body: ApiSaveRequest): Promise<void> {
  const root = apiRoot(projectRoot);
  await ensureApi(projectRoot);

  if (body.environments) {
    await fsp.writeFile(path.join(root, ENV_FILE), JSON.stringify(body.environments, null, 2) + '\n', 'utf8');
  }

  const rel = body.path.trim();
  if (!rel) return;
  const isDir = rel.endsWith('/');
  const cleanRel = (isDir ? rel.slice(0, -1) : rel).replace(/[/]+$/, '');
  const abs = resolveInside(root, path.join(COLLECTIONS_DIR, cleanRel));
  if (!abs) throw new Error(`path 越界：${rel}`);

  if (isDir) {
    await fsp.mkdir(abs, { recursive: true });
  } else {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // 写前做一次纯 JSON 校验，坏内容直接报错不落盘
    JSON.parse(body.content);
    await fsp.writeFile(abs, body.content.endsWith('\n') ? body.content : body.content + '\n', 'utf8');
  }
}

/** 删接口 / 目录（递归删目录）。 */
export async function deleteApi(projectRoot: string, body: ApiDeleteRequest): Promise<void> {
  const root = apiRoot(projectRoot);
  const rel = body.path.trim().replace(/[/]+$/, '');
  if (!rel) return;
  const abs = resolveInside(root, path.join(COLLECTIONS_DIR, rel));
  if (!abs) throw new Error(`path 越界：${rel}`);
  await fsp.rm(abs, { recursive: true, force: true });
}

/**
 * 重命名接口 / 目录：旧路径 → 新路径（`fs.rename`）。
 * 接口文件重命名后，读出 JSON 改 `name` 字段再写回。
 */
export async function renameApi(projectRoot: string, body: ApiRenameRequest): Promise<void> {
  const root = apiRoot(projectRoot);
  await ensureApi(projectRoot);
  const fromRel = body.from.trim().replace(/[/]+$/, '');
  const toRel = body.to.trim().replace(/[/]+$/, '');
  if (!fromRel || !toRel) throw new Error('from / to 不能为空');
  if (fromRel === toRel) return;

  const fromAbs = resolveInside(root, path.join(COLLECTIONS_DIR, fromRel));
  if (!fromAbs) throw new Error(`from 越界：${body.from}`);
  const toAbs = resolveInside(root, path.join(COLLECTIONS_DIR, toRel));
  if (!toAbs) throw new Error(`to 越界：${body.to}`);

  // 确保目标父目录存在
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);

  // 接口文件：同步更新 name 字段
  const stat = await fsp.stat(toAbs).catch(() => null);
  if (stat?.isFile() && toAbs.endsWith('.json')) {
    const text = await fsp.readFile(toAbs, 'utf8');
    try {
      const def = JSON.parse(text) as ApiRequestDef;
      // 用新文件名（不含扩展名）更新接口 name 字段
      const baseName = path.basename(toRel, '.json');
      def.name = baseName;
      await fsp.writeFile(toAbs, JSON.stringify(def, null, 2) + '\n', 'utf8');
    } catch {
      // 非 JSON 或格式坏，不动内容（重命名已成功）
    }
  }
}

/**
 * 纯 HTTP 转发：后端同机发请求，返回响应（绕过浏览器 CORS）。
 * 变量替换由调用方完成（url / headers / body 里已无 `{{...}}`）。
 */
export async function sendRequest(body: ApiSendRequest): Promise<ApiSendResult> {
  const method = (body.method ?? 'GET').toUpperCase();
  const url = body.url ?? '';
  if (!url) throw new Error('url 不能为空');

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const headers: Record<string, string> = { ...(body.headers ?? {}) };
    let payload: string | URLSearchParams | undefined;
    if (body.body !== undefined && body.body !== null) {
      const ct = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
      if (typeof body.body === 'string') {
        payload = body.body;
      } else if (ct && ct.toLowerCase().includes('x-www-form-urlencoded')) {
        payload = new URLSearchParams(body.body as Record<string, string>).toString();
      } else {
        payload = JSON.stringify(body.body);
        if (!ct) headers['Content-Type'] = 'application/json';
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : payload,
      signal: controller.signal,
      redirect: 'follow',
    });

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const text = await res.text();

    return {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      body: text,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      status: 0,
      statusText: '',
      headers: {},
      body: '',
      durationMs: Date.now() - started,
      error: (e as Error).message ?? String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 读 collections 下所有接口（扁平列表，供导出用）。 */
async function collectRequests(root: string): Promise<Array<{ def: ApiRequestDef; rel: string }>> {
  const out: Array<{ def: ApiRequestDef; rel: string }> = [];
  const walk = async (dir: string, relBase: string) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        const def = await readRequestDef(abs);
        if (def) out.push({ def, rel });
      }
    }
  };
  await walk(path.join(root, COLLECTIONS_DIR), '');
  return out;
}

/** 导出接口为 Postman Collection v2.1 或 OpenAPI 3.0。 */
export async function exportApis(
  projectRoot: string,
  format: 'postman' | 'swagger',
): Promise<ApiExportResult> {
  const root = apiRoot(projectRoot);
  const requests = await collectRequests(root);
  const envRaw = await readJson<ApiEnvironments>(path.join(root, ENV_FILE));
  // 当前 active 环境的变量表（swagger 导出用它把 `{{key}}` 解析成真实地址）。
  const activeVars =
    envRaw?.environments.find((e) => e.name === envRaw.active)?.variables ??
    envRaw?.environments[0]?.variables ??
    {};
  const replaceVars = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (w, k: string) => (k in activeVars ? activeVars[k] : w));

  if (format === 'postman') {
    const items = requests.map(({ def, rel }) => {
      const folderPath = rel.slice(0, Math.max(0, rel.lastIndexOf('/')));
      const rawBody = def.body !== undefined ? (typeof def.body === 'string' ? def.body : JSON.stringify(def.body)) : '';
      return {
        folder: folderPath,
        name: def.name,
        request: {
          method: def.method.toUpperCase(),
          header: Object.entries(def.headers ?? {}).map(([k, v]) => ({ key: k, value: String(v) })),
          body: rawBody
            ? {
                mode: 'raw',
                raw: rawBody,
                options: { raw: { language: 'json' } },
              }
            : undefined,
          url: def.url,
          description: def.description ?? '',
        },
      };
    });
    const content = JSON.stringify(
      {
        info: { name: 'api', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: items,
      },
      null,
      2,
    );
    return { format, filename: 'collection.postman.json', content };
  }

  // OpenAPI 3.0：把每个接口映射成一个 path。
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { def, rel } of requests) {
    const method = def.method.toLowerCase();
    if (!['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method)) continue;
    const resolved = replaceVars(def.url);
    // OpenAPI 的 path 须是相对路径：去掉 scheme://host，只留 pathname（含 query）。
    let key = resolved;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(resolved)) {
      try {
        const u = new URL(resolved);
        key = u.pathname + u.search;
      } catch {
        key = resolved;
      }
    }
    if (!key.startsWith('/')) key = '/' + key;
    paths[key] = paths[key] ?? {};
    paths[key][method] = {
      operationId: `${method}_${rel.replace(/[^a-zA-Z0-9]+/g, '_')}`,
      summary: def.name,
      description: def.description ?? '',
      ...(Object.keys(def.headers ?? {}).length
        ? { parameters: Object.entries(def.headers ?? {}).map(([k, v]) => ({ name: k, in: 'header', schema: { type: 'string' }, example: v })) }
        : {}),
      ...(def.body !== undefined
        ? {
            requestBody: {
              content: { 'application/json': { schema: { example: def.body } } },
            },
          }
        : {}),
      responses: { '200': { description: 'ok' } },
    };
  }

  const content = JSON.stringify(
    {
      openapi: '3.0.0',
      info: { title: 'api', version: '1.0.0' },
      servers:
        envRaw && envRaw.active
          ? [{ url: envRaw.environments.find((e) => e.name === envRaw.active)?.variables?.baseUrl ?? '' }]
          : undefined,
      paths,
    },
    null,
    2,
  );
  return { format, filename: 'openapi.swagger.json', content };
}