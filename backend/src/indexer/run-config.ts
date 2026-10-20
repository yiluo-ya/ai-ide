/**
 * 运行配置与运行上下文装配（2026-10-20，第二、三层）。
 *
 * 三层里这层负责两件事：
 * 1) **配置**：`~/.ide/runs/<projectId>.json` —— 与 `projects.json` / 索引快照同处，
 *    不往被读目录里写状态（与 FR-0013 会话落盘同口径）。只有用户明确"锁定"的运行时
 *    才写进去；没锁的一律现场探测。
 * 2) **装配**：`resolveRunEnv()` 算出一次运行真正该带的环境 ——
 *    PATH 前插（`node_modules/.bin`、venv 的 Scripts、`<jdk>/bin`）、`JAVA_HOME` 与所选 JDK 配对、
 *    配置里的 env、显式声明的 envFile。终端 PTY 与命令面板（前台 / 后台 worker）共用它，
 *    这样在终端里手敲 `mvn` / `java` 也吃到同一套环境。
 *
 * 纪律：
 * - 不做"猜"：版本要求与实探测不符只给 warnings，不自动换运行时。
 * - 不读**未声明**的 `.env`（`envFile` 为空就不加载）—— 隐式加载会让人对"变量从哪来"失去判断。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config';
import type {
  RunConfig,
  RunConfigResult,
  RunProfile,
  RuntimeCandidate,
  RuntimeId,
  RuntimesResult,
} from '../../../shared/types';
import { detectRuntimes, RUNTIME_IDS } from './runtimes';

const RUN_CONFIG_VERSION = 1;
const isWin = process.platform === 'win32';

/** 空配置（读不到 / 坏数据都回落到它）。 */
export function emptyRunConfig(): RunConfig {
  return {
    version: RUN_CONFIG_VERSION,
    runtimes: {},
    toolchainRoots: [],
    env: {},
    pathPrepend: [],
    envFile: [],
    profiles: [],
  };
}

/** 运行配置目录；测试用 READER_RUNS_DIR 覆盖。 */
function runsDir(): string {
  return process.env.READER_RUNS_DIR ?? path.join(DATA_DIR, 'runs');
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function configFile(projectId: string): string {
  return path.join(runsDir(), `${safeId(projectId)}.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuntimeId(value: string): value is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(value);
}

function toStringMap(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}

/** 把任意来源的原始值收敛成合法配置（容错读的唯一入口）。 */
export function coerceRunConfig(raw: unknown): RunConfig {
  const src = isPlainObject(raw) ? raw : {};
  const runtimes: Partial<Record<RuntimeId, string>> = {};
  if (isPlainObject(src.runtimes)) {
    for (const [key, value] of Object.entries(src.runtimes)) {
      if (isRuntimeId(key) && typeof value === 'string' && value.trim()) runtimes[key] = value.trim();
    }
  }
  const profiles: RunProfile[] = [];
  if (Array.isArray(src.profiles)) {
    for (const item of src.profiles) {
      if (!isPlainObject(item)) continue;
      const command = typeof item.command === 'string' ? item.command.trim() : '';
      if (!command) continue;
      const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `user-${profiles.length}`;
      const kind = item.kind === 'build' || item.kind === 'run' || item.kind === 'test' ? item.kind : 'other';
      profiles.push({
        id,
        kind,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : command,
        command,
        source: 'user',
        ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim() } : {}),
        ...(item.background === true ? { background: true } : {}),
      });
    }
  }
  return {
    version: RUN_CONFIG_VERSION,
    runtimes,
    toolchainRoots: toStringArray(src.toolchainRoots).map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')),
    env: toStringMap(src.env),
    pathPrepend: toStringArray(src.pathPrepend),
    envFile: toStringArray(src.envFile),
    profiles,
  };
}

export async function loadRunConfig(projectId: string): Promise<RunConfig> {
  try {
    const raw = await fsp.readFile(configFile(projectId), 'utf8');
    return coerceRunConfig(JSON.parse(raw));
  } catch {
    return emptyRunConfig(); // 没有配置 / 坏 JSON 都回落空（不拿垃圾盖掉能救的）
  }
}

export async function saveRunConfig(projectId: string, config: RunConfig): Promise<RunConfig> {
  const next = coerceRunConfig(config);
  await fsp.mkdir(runsDir(), { recursive: true });
  await fsp.writeFile(configFile(projectId), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

// ---------------------------------------------------------------- env 文件

/**
 * 解析 env 文件（dotenv 的最小口径）：`KEY=VALUE`、`export KEY=VALUE`、`#` 注释、空行。
 * 值两侧的成对引号会被去掉；行内不做变量展开（少一层惊喜）。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- 运行档推断

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 在 src/main/java 下找带 `public static void main` 的类，拼成全限定名。 */
function findJavaMainClass(root: string): string | null {
  const base = path.join(root, 'src', 'main', 'java');
  if (!isDir(base)) return null;
  const stack = [base];
  let visited = 0;
  while (stack.length > 0 && visited < 2000) {
    const dir = stack.pop() as string;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      visited += 1;
      if (isDir(full)) {
        stack.push(full);
        continue;
      }
      if (!name.endsWith('.java')) continue;
      const text = readText(full);
      if (!text || !/static\s+void\s+main\s*\(/.test(text)) continue;
      const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
      const cls = name.slice(0, -'.java'.length);
      return pkg ? `${pkg}.${cls}` : cls;
    }
  }
  return null;
}

/** Java（Maven / Gradle）项目的运行档：构建与运行都交给构建工具。 */
function javaProfiles(root: string): RunProfile[] {
  const pom = readText(path.join(root, 'pom.xml'));
  const gradle = readText(path.join(root, 'build.gradle')) ?? readText(path.join(root, 'build.gradle.kts'));
  const out: RunProfile[] = [];

  if (pom !== null) {
    const mvn = isFile(path.join(root, 'mvnw.cmd')) || isFile(path.join(root, 'mvnw')) ? './mvnw' : 'mvn';
    const winMvn = process.platform === 'win32' && mvn === './mvnw' ? 'mvnw.cmd' : mvn;
    const springBoot = /spring-boot-maven-plugin/.test(pom);
    const execPlugin = /exec-maven-plugin/.test(pom);

    out.push({
      id: 'java-build',
      kind: 'build',
      label: '构建（mvn package）',
      command: `${winMvn} -q -DskipTests package`,
      source: 'inferred',
      note: 'pom.xml：mvn -DskipTests package',
    });

    if (springBoot) {
      out.push({
        id: 'java-run',
        kind: 'run',
        label: '运行（spring-boot:run）',
        command: `${winMvn} -q spring-boot:run`,
        source: 'inferred',
        note: 'pom.xml 声明了 spring-boot-maven-plugin',
        background: true,
      });
    } else {
      const mainClass = findJavaMainClass(root);
      if (mainClass) {
        out.push({
          id: 'java-run',
          kind: 'run',
          label: `运行（${mainClass}）`,
          command: `${winMvn} -q compile exec:java -Dexec.mainClass=${mainClass}`,
          source: 'inferred',
          note: execPlugin
            ? 'pom.xml 声明了 exec-maven-plugin'
            : '用 exec:java 跑主类；首次会由 Maven 自动解析插件（需要网络）',
          background: false,
        });
      }
    }

    out.push({
      id: 'java-test',
      kind: 'test',
      label: '测试（mvn test）',
      command: `${winMvn} -q test`,
      source: 'inferred',
      note: 'pom.xml：mvn test',
    });
    return out;
  }

  if (gradle !== null) {
    const gw = isFile(path.join(root, 'gradlew.bat')) || isFile(path.join(root, 'gradlew'))
      ? process.platform === 'win32'
        ? 'gradlew.bat'
        : './gradlew'
      : 'gradle';
    out.push({
      id: 'java-build',
      kind: 'build',
      label: '构建（gradle build）',
      command: `${gw} build -x test -q`,
      source: 'inferred',
      note: 'build.gradle：gradle build',
    });
    out.push({
      id: 'java-run',
      kind: 'run',
      label: '运行（gradle run）',
      command: `${gw} run -q`,
      source: 'inferred',
      note: '需要 application 插件；没有就跑不起来，可在配置里改写',
      background: true,
    });
    out.push({
      id: 'java-test',
      kind: 'test',
      label: '测试（gradle test）',
      command: `${gw} test -q`,
      source: 'inferred',
      note: 'build.gradle：gradle test',
    });
    return out;
  }
  return out;
}

/** Node 项目的运行档：直接读 package.json 的 scripts。 */
function nodeProfiles(root: string): RunProfile[] {
  const text = readText(path.join(root, 'package.json'));
  if (!text) return [];
  let scripts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    if (isPlainObject(parsed.scripts)) {
      scripts = Object.fromEntries(Object.entries(parsed.scripts).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
  } catch {
    return [];
  }
  const mgr = isFile(path.join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : isFile(path.join(root, 'yarn.lock'))
      ? 'yarn'
      : isFile(path.join(root, 'bun.lockb'))
        ? 'bun'
        : 'npm';
  const out: RunProfile[] = [];
  const add = (id: string, kind: RunProfile['kind'], label: string, script: string, background = false): void => {
    out.push({
      id,
      kind,
      label: `${label}（${mgr} run ${script}）`,
      command: `${mgr} run ${script}`,
      source: 'inferred',
      note: `package.json scripts.${script}`,
      ...(background ? { background: true } : {}),
    });
  };
  if (scripts.dev) add('node-dev', 'run', '启动开发', 'dev', true);
  else if (scripts.start) add('node-start', 'run', '启动', 'start', true);
  else if (scripts.serve) add('node-serve', 'run', '启动服务', 'serve', true);
  if (scripts.build) add('node-build', 'build', '构建', 'build');
  if (scripts.test) add('node-test', 'test', '测试', 'test');
  return out;
}

/** Go 项目的运行档。 */
function goProfiles(root: string): RunProfile[] {
  if (!isFile(path.join(root, 'go.mod'))) return [];
  return [
    { id: 'go-run', kind: 'run', label: '运行（go run .）', command: 'go run .', source: 'inferred', note: 'go.mod：go run .' },
    { id: 'go-build', kind: 'build', label: '构建（go build ./...）', command: 'go build ./...', source: 'inferred', note: 'go.mod：go build ./...' },
    { id: 'go-test', kind: 'test', label: '测试（go test ./...）', command: 'go test ./...', source: 'inferred', note: 'go.mod：go test ./...' },
  ];
}

/** Python 项目的运行档：只看约定入口，不猜框架。 */
function pythonProfiles(root: string): RunProfile[] {
  const hasPy =
    isFile(path.join(root, 'pyproject.toml')) ||
    isFile(path.join(root, 'requirements.txt')) ||
    isFile(path.join(root, 'setup.py'));
  const entry = ['main.py', 'app.py', 'manage.py', '__main__.py', 'run.py']
    .map((name) => path.join(root, name))
    .find((p) => isFile(p));
  if (!hasPy && !entry) return [];
  const out: RunProfile[] = [];
  if (entry) {
    const rel = path.relative(root, entry).split(path.sep).join('/');
    out.push({
      id: 'py-run',
      kind: 'run',
      label: `运行（${rel}）`,
      command: `python ${rel}`,
      source: 'inferred',
      note: `项目根入口 ${rel}；解释器按设置 / 探测结果代入`,
    });
  }
  if (hasPy) {
    out.push({
      id: 'py-test',
      kind: 'test',
      label: '测试（pytest）',
      command: 'python -m pytest',
      source: 'inferred',
      note: 'pyproject / requirements 项目；没装 pytest 会报错，可在配置里改写',
    });
  }
  return out;
}

/** 按项目里的构建文件推断运行档（不写盘，纯函数式读几个文件）。 */
export function inferProfiles(root: string): RunProfile[] {
  const out: RunProfile[] = [];
  out.push(...javaProfiles(root));
  out.push(...nodeProfiles(root));
  out.push(...goProfiles(root));
  out.push(...pythonProfiles(root));
  return out;
}

/** 用户自定义档覆盖同 id 的推断档；其余按顺序保留。 */
export function mergeProfiles(inferred: RunProfile[], user: RunProfile[]): RunProfile[] {
  const byId = new Map<string, RunProfile>();
  for (const p of inferred) byId.set(p.id, p);
  for (const p of user) byId.set(p.id, p);
  // 保持稳定顺序：推断档在前（它们的排列就是"先构建后运行"的自然顺序），用户新增的排在后面
  const ordered: RunProfile[] = [];
  const seen = new Set<string>();
  for (const p of inferred) {
    const merged = byId.get(p.id);
    if (merged && !seen.has(p.id)) {
      ordered.push(merged);
      seen.add(p.id);
    }
  }
  for (const p of user) {
    if (!seen.has(p.id)) {
      ordered.push(p);
      seen.add(p.id);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------- 装配

/**
 * 选定的运行时：优先配置里锁定的 home，否则用探测结果的第一个候选。
 *
 * 锁定的路径**失效时回落**到第一个候选（不拿一个不存在的路径去 spawn —— 那只会在终端里
 * 报一句莫名的错误）；回落由 `lockWarnings()` 明确告知。
 */
export function pickRuntime(
  id: RuntimeId,
  candidates: RuntimeCandidate[],
  config: RunConfig,
): RuntimeCandidate | null {
  const locked = config.runtimes[id];
  if (locked) {
    const hit = candidates.find((c) => c.home === locked || c.path === locked);
    if (hit) return hit;
    // 锁定的路径还在（只是探测没识别到）时，拿它兜底 —— 用户手填的绝对路径要生效
    if (isFile(locked)) {
      return { id, path: locked, home: path.dirname(locked), version: null, source: 'env', detail: '设置里锁定' };
    }
    const exe = runtimeExeIn(locked, id);
    if (exe) return { id, path: exe, home: locked, version: null, source: 'env', detail: '设置里锁定' };
  }
  return candidates[0] ?? null;
}

/** 在一个安装根里找 id 对应的可执行文件（Python 的 venv 用 Scripts，其余用 bin）。 */
function runtimeExeIn(home: string, id: RuntimeId): string | null {
  if (!isDir(home)) return null;
  const exe = isWin ? '.exe' : '';
  const names: Record<RuntimeId, string[]> = {
    java: ['java'],
    maven: isWin ? ['mvn.cmd'] : ['mvn'],
    gradle: isWin ? ['gradle.bat'] : ['gradle'],
    python: ['python'],
    node: ['node'],
    go: ['go'],
  };
  const dirs = id === 'python' && isDir(path.join(home, 'Scripts')) ? ['Scripts', 'bin'] : ['bin'];
  for (const dir of dirs) {
    for (const name of names[id]) {
      const full = path.join(home, dir, `${name}${exe}`);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** 锁定了但没生效时的提醒（设置里选的那个运行时已经不在了）。 */
export function lockWarnings(
  config: RunConfig,
  picked: Partial<Record<RuntimeId, RuntimeCandidate>>,
): string[] {
  const out: string[] = [];
  for (const [id, locked] of Object.entries(config.runtimes) as Array<[RuntimeId, string]>) {
    if (!locked) continue;
    const chosen = picked[id];
    if (chosen && (chosen.home === locked || chosen.path === locked)) continue;
    out.push(`设置里锁定的 ${id} 路径已不可用（${locked}），已回落到自动探测`);
  }
  return out;
}

/** 版本要求：`.python-version` / `.nvmrc` / `go.mod` / `pom.xml` 说要什么，实探测是什么。 */
export function versionWarnings(root: string, picked: Partial<Record<RuntimeId, RuntimeCandidate>>): string[] {
  const out: string[] = [];

  const pyWanted = readText(path.join(root, '.python-version'))?.trim().split(/\r?\n/)[0]?.trim();
  const py = picked.python;
  if (pyWanted && py?.version && !py.version.startsWith(pyWanted)) {
    out.push(`.python-version 要求 Python ${pyWanted}，实际用的是 ${py.version}（${py.detail}）`);
  }

  const nvmrc = readText(path.join(root, '.nvmrc'))?.trim();
  const node = picked.node;
  if (nvmrc && node?.version && !node.version.startsWith(nvmrc.replace(/^v/, ''))) {
    out.push(`.nvmrc 要求 Node ${nvmrc}，实际用的是 ${node.version}（${node.detail}）`);
  }

  const goMod = readText(path.join(root, 'go.mod'));
  const goWanted = goMod ? /^go\s+(\d+\.\d+)/m.exec(goMod)?.[1] : undefined;
  const go = picked.go;
  if (goWanted && go?.version && !go.version.startsWith(goWanted)) {
    out.push(`go.mod 要求 Go ${goWanted}，实际用的是 ${go.version}（${go.detail}）`);
  }

  const pom = readText(path.join(root, 'pom.xml'));
  const javaWanted =
    (pom ? /<(?:maven\.compiler\.(?:release|target)|java\.version|release)>\s*(\d+)/.exec(pom)?.[1] : undefined) ??
    undefined;
  const java = picked.java;
  if (javaWanted && java?.version && !java.version.startsWith(javaWanted)) {
    out.push(`pom.xml 要求 Java ${javaWanted}，实际用的是 ${java.version}（${java.detail}）`);
  }
  return out;
}

export interface ResolvedRunEnv {
  /** 完整环境（已含 process.env，可直接交给 spawn / PTY）。 */
  env: Record<string, string>;
  /** 实际选中的运行时（界面用）。 */
  picked: Partial<Record<RuntimeId, RuntimeCandidate>>;
  /** 加载过的 env 文件（相对路径）。 */
  loadedEnvFiles: string[];
}

/** 项目相对路径 → 绝对路径（绝对路径原样返回）。 */
function resolveFrom(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

/**
 * 装配一次运行的环境。
 *
 * 顺序（后者覆盖前者）：IDE 进程 env → envFile → 配置 env → 运行时配对变量（JAVA_HOME / GOROOT）；
 * PATH 则按「PATH 前插 + 运行时 bin 目录」整体前插，保证选中的运行时**优先命中**。
 */
export async function resolveRunEnv(
  root: string,
  options: { config?: RunConfig; candidates?: RuntimeCandidate[] } = {},
): Promise<ResolvedRunEnv> {
  const config = options.config ?? emptyRunConfig();
  const candidates = options.candidates ?? (await detectRuntimes(root, { extraRoots: config.toolchainRoots }));

  const byId = new Map<RuntimeId, RuntimeCandidate[]>();
  for (const c of candidates) {
    const list = byId.get(c.id) ?? [];
    list.push(c);
    byId.set(c.id, list);
  }
  const picked: Partial<Record<RuntimeId, RuntimeCandidate>> = {};
  for (const id of RUNTIME_IDS) {
    const chosen = pickRuntime(id, byId.get(id) ?? [], config);
    if (chosen) picked[id] = chosen;
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const loadedEnvFiles: string[] = [];
  for (const rel of config.envFile) {
    const abs = resolveFrom(root, rel);
    const text = readText(abs);
    if (text === null) continue;
    Object.assign(env, parseEnvFile(text));
    loadedEnvFiles.push(rel);
  }
  Object.assign(env, config.env);

  // 运行时配对变量：选了哪个 JDK，就让 JAVA_HOME 指向它（Maven 靠它找 JDK）
  if (picked.java) env.JAVA_HOME = picked.java.home;
  if (picked.go) env.GOROOT = picked.go.home;
  if (picked.python && picked.python.source === 'project') {
    // 项目 venv：VIRTUAL_ENV 让 `python -m pip` 之类的行为与 activate 后一致
    env.VIRTUAL_ENV = picked.python.home;
  }

  // PATH：配置里声明的前插目录 + 运行时 bin（venv 用 Scripts/bin，其余用 bin）
  const prepend: string[] = [];
  for (const rel of config.pathPrepend) prepend.push(resolveFrom(root, rel));
  const nodeBin = path.join(root, 'node_modules', '.bin');
  if (isDir(nodeBin)) prepend.push(nodeBin);
  for (const id of RUNTIME_IDS) {
    const cand = picked[id];
    if (!cand) continue;
    const dir = path.dirname(cand.path);
    if (!prepend.includes(dir)) prepend.push(dir);
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
  const existing = env[pathKey] ?? '';
  if (prepend.length > 0) {
    env[pathKey] = [...prepend, existing].filter(Boolean).join(path.delimiter);
  }

  return { env, picked, loadedEnvFiles };
}

/** `GET /runtimes` 的响应体：按 id 分组，找不到的给空数组。 */
export async function runtimesFor(root: string, toolchainRoots: readonly string[] = []): Promise<RuntimesResult> {
  const list = await detectRuntimes(root, { extraRoots: toolchainRoots });
  const out = {
    java: [],
    maven: [],
    gradle: [],
    python: [],
    node: [],
    go: [],
  } as RuntimesResult;
  for (const c of list) out[c.id].push(c);
  return out;
}

/** `GET /run-config` 的响应体：生效配置 + 合并后的运行档 + 探测摘要 + 提醒。 */
export async function runConfigFor(projectId: string, root: string): Promise<RunConfigResult> {
  const config = await loadRunConfig(projectId);
  const candidates = await detectRuntimes(root, { extraRoots: config.toolchainRoots });
  const { picked } = await resolveRunEnv(root, { config, candidates });
  const inferred = inferProfiles(root);
  const profiles = mergeProfiles(inferred, config.profiles);

  const runtimes = (Object.entries(picked) as Array<[RuntimeId, RuntimeCandidate]>).map(([id, c]) => ({
    id,
    version: c.version,
    path: c.path,
    source: c.source,
  }));

  return { config, profiles, runtimes, warnings: [...lockWarnings(config, picked), ...versionWarnings(root, picked)] };
}
