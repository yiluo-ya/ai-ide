/**
 * 项目命令（FR-0005，2026-10-03 用户要求）：
 * 「在命令面板说一句话 → code agent 读本项目 → 得出编译 / 后台启动 / 后台停止 / 测试命令
 *  （仓库里没有的给建议）→ 点一下真跑」。
 *
 * 三块：
 * 1) **发现** `discoverCommands`：起一个**只读**的 builtin 会话（不给写文件工具，见 agent/builtin.ts），
 *    提示词要求它最后只输出一个 JSON 代码块；这里等它 settled，取最后一条 assistant 文本、
 *    解析、校验、落盘。会话本身留在 AgentSessions 里（名字「命令分析 · <项目名>」），
 *    想看过程去 Agent 面板打开它。
 * 2) **执行** `runCommand`：前台一次跑完把输出带回来；后台 detached + 日志文件，pid 记在内存里。
 * 3) **危险分级** `classifyRisk`：warn 交给前端红框 + 额外勾选；block 在这里直接拒绝。
 *
 * 安全边界（与 services.ts 同口径）：
 * - 一律在**项目根**执行（cwd 固定，不接受前端传目录）；
 * - 共享模式（HOST 非本机）整层禁用 —— 由路由里的 serviceGuarded 拒绝；
 * - block 级命令不执行；
 * - 前台命令有时限（60s）与输出上限（200KB）；长任务用后台运行。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config';
import { logInfo } from './log';
import { messageText } from './agent/types';
import type { AgentSessions } from './agent/sessions';
import type { ProjectRegistry } from './registry';
import type { CommandKind, CommandPlan, CommandRisk, CommandRun, ProjectCommand } from './types';

/** 一次发现最多等这么久（agent 要读若干文件 + 多轮工具调用）。 */
const DISCOVER_TIMEOUT_MS = Number(process.env.READER_COMMAND_TIMEOUT_MS ?? 180_000);
/** 前台命令的时限与输出上限；超时的命令提示改用后台运行。 */
const FOREGROUND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;
/** 后台日志回给前端的尾部长度。 */
const LOG_TAIL_CHARS = 8_000;
/** 每个项目最多留多少条运行记录。 */
const MAX_RUNS_PER_PROJECT = 20;

const KIND_VALUES: readonly CommandKind[] = ['build', 'start', 'stop', 'test', 'other'];

/** block：自毁级，直接拒绝执行。 */
const BLOCK_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+\/(\s|$|\*)/i, why: '删除根目录' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: 'fork 炸弹' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, why: '格式化文件系统' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化盘符' },
  { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
  { re: /\bdd\s+[^\n]*of=\/dev\//i, why: '直接写块设备' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: '关机 / 重启' },
];

/** warn：常见危险操作，前端红框 + 确认框里额外勾选。 */
const WARN_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+-[a-z]*[rf]/i, why: '递归 / 强制删除' },
  { re: /\b(del|rmdir)\s+\/[sq]/i, why: '递归删除' },
  { re: /\bgit\s+push\b/i, why: '推送到远端' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: '丢弃本地改动' },
  { re: /\b(npm|yarn|pnpm)\s+publish\b/i, why: '发布包' },
  { re: /\b(cargo|docker|podman)\s+(publish|push)\b/i, why: '发布 / 推送镜像' },
  { re: /\b(sudo|runas)\b/i, why: '提权执行' },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sh|bash|iex|Invoke-Expression)/i, why: '下载即执行' },
  { re: /\b(kubectl|helm)\s+(delete|uninstall)\b/i, why: '删除集群资源' },
  { re: /\bterraform\s+(apply|destroy)\b/i, why: '变更基础设施' },
  { re: /\bnpm\s+(i|install)\s+-g\b/i, why: '全局安装' },
  { re: /\bchmod\s+-R\s+777\b/i, why: '放开全部权限' },
];

/** 危险级别（只判级别；原因用于 block 时的报错文案）。 */
export function classifyRisk(command: string): CommandRisk {
  if (blockReason(command)) return 'block';
  if (WARN_PATTERNS.some(({ re }) => re.test(command))) return 'warn';
  return 'none';
}

function blockReason(command: string): string | null {
  for (const { re, why } of BLOCK_PATTERNS) if (re.test(command)) return why;
  return null;
}

/** 危险提示文案（前端红框用；没有则 undefined）。 */
export function riskReason(command: string): string | undefined {
  const block = blockReason(command);
  if (block) return block;
  return WARN_PATTERNS.find(({ re }) => re.test(command))?.why;
}

// ------------------------------------------------------------------ 发现

export interface DiscoverInput {
  registry: ProjectRegistry;
  sessions: AgentSessions;
  projectId: string;
  /** 用户那句话（默认「获取本项目的命令」）。 */
  prompt: string;
}

export interface DiscoverResult {
  plan: CommandPlan;
  sessionId: string;
}

/** 提示词：把「读哪些文件、怎么标注来源、输出什么 JSON」说死。 */
function buildDiscoveryPrompt(userPrompt: string): string {
  return [
    '请**只读**分析这个项目，找出「怎么编译 / 怎么后台启动 / 怎么后台停止 / 怎么跑测试」这些命令。',
    '',
    '先看这些地方再定论（有什么看什么）：',
    '- package.json 的 scripts、Makefile / justfile / Taskfile；',
    '- pyproject.toml / requirements.txt / manage.py、go.mod、Cargo.toml、pom.xml / build.gradle；',
    '- 脚本目录（scripts/、tools/、bin/）、CI 配置（.github/workflows/ 等）；',
    '- README 里「开发 / 运行 / 测试」章节。',
    '',
    '规则：',
    '1. 每条命令必须能在**项目根目录直接执行**（不要出现 cd 到项目外的路径）。',
    '2. 仓库里确实有的命令：source 写 "script"，note 里写出处（哪个文件、哪个字段/哪一行）。',
    '3. 仓库里没有的：可以给建议命令，source 写 "generated"，note 里说明依据与前置条件。',
    '4. 不要写、改、删任何文件。',
    '5. kind 只能取 build / start / stop / test / other；后台启动与后台停止各最多一条。',
    '6. 后台启动的命令给 background: true。',
    '7. summary 用一句话说明你怎么得出的。',
    '',
    `用户这次的要求：${userPrompt.trim() || '获取本项目的命令'}`,
    '',
    '最后只输出一个 JSON 代码块，不要输出别的文字：',
    '```json',
    '{"summary":"…","commands":[{"kind":"build","label":"编译","command":"npm run build","source":"script","note":"package.json scripts.build","background":false}]}',
    '```',
  ].join('\n');
}

export async function discoverCommands(input: DiscoverInput): Promise<DiscoverResult> {
  const project = input.registry.get(input.projectId);
  if (!project) throw new Error(`项目不存在：${input.projectId}`);

  const session = await input.sessions.create({
    projectId: input.projectId,
    name: `命令分析 · ${project.name}`,
    readOnly: true,
  });
  const adapter = input.sessions.get(session.id);
  if (!adapter) throw new Error('会话创建后立刻消失了（内部错误）');

  await new Promise<void>((resolve, reject) => {
    let off: (() => void) | null = null;
    const timer = setTimeout(() => {
      off?.();
      reject(new Error(`分析超时（${Math.round(DISCOVER_TIMEOUT_MS / 1000)} 秒），可以重试或换种说法`));
    }, DISCOVER_TIMEOUT_MS);
    off = input.sessions.subscribe(session.id, (event) => {
      if (event.type !== 'agent_settled') return;
      clearTimeout(timer);
      off?.();
      resolve();
    });
    adapter.prompt(buildDiscoveryPrompt(input.prompt)).catch((error: unknown) => {
      clearTimeout(timer);
      off?.();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const messages = await adapter.getMessages();
  const parsed = parsePlanJson(lastAssistantText(messages));
  if (!parsed) {
    throw new Error('模型没有给出可解析的命令 JSON；可以重试，或去 Agent 面板看那条会话卡在哪');
  }
  const commands = normalizeCommands(parsed.commands);
  if (commands.length === 0) throw new Error('模型没有给出任何命令；可以重试，或把要求说得更具体');

  const plan: CommandPlan = {
    projectId: input.projectId,
    createdAt: Date.now(),
    prompt: input.prompt,
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    model: session.model ? { provider: session.model.provider, modelId: session.model.id } : null,
    sessionId: session.id,
    commands,
  };
  await savePlan(plan);
  logInfo('commands.discovered', { projectId: input.projectId, count: commands.length, sessionId: session.id });
  return { plan, sessionId: session.id };
}

/** 最后一条有文字的 assistant 消息。 */
function lastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const text = messageText(msg as Parameters<typeof messageText>[0]).trim();
    if (text) return text;
  }
  return '';
}

/** 从回复里抠出 JSON：优先取最后一个 ```json 代码块，其次取首尾大括号之间。 */
export function parsePlanJson(text: string): { summary?: string; commands: unknown[] } | null {
  let candidate: string | null = null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    if (/[{[]/.test(match[1])) candidate = match[1];
  }
  if (!candidate) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) candidate = text.slice(start, end + 1);
  }
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate.trim()) as { summary?: unknown; commands?: unknown };
    if (!Array.isArray(parsed.commands)) return null;
    return {
      ...(typeof parsed.summary === 'string' && parsed.summary.trim() ? { summary: parsed.summary.trim() } : {}),
      commands: parsed.commands,
    };
  } catch {
    return null;
  }
}

/** 校验并补齐模型给的每条命令；不合格的直接丢掉。 */
export function normalizeCommands(raw: unknown[]): ProjectCommand[] {
  const out: ProjectCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const command = typeof rec.command === 'string' ? rec.command.trim().replace(/\s*\r?\n+\s*/g, ' ') : '';
    if (!command) continue;
    const kind: CommandKind = KIND_VALUES.includes(rec.kind as CommandKind) ? (rec.kind as CommandKind) : 'other';
    const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : command.slice(0, 40);
    const note = typeof rec.note === 'string' && rec.note.trim() ? rec.note.trim() : undefined;
    // start 类默认后台跑（除非模型显式说 false）。
    const background = rec.background === true || (kind === 'start' && rec.background !== false);
    out.push({
      id: randomUUID(),
      kind,
      label,
      command,
      source: rec.source === 'script' ? 'script' : 'generated',
      ...(note ? { note } : {}),
      ...(background ? { background: true } : {}),
      risk: classifyRisk(command),
    });
  }
  return out;
}

// ------------------------------------------------------------------ 落盘

const plansDir = () => path.join(commandDir(), 'plans');
const planFile = (projectId: string) => path.join(plansDir(), `${safeId(projectId)}.json`);

/** 命令数据（清单 + 日志）的落盘根目录；测试用 READER_COMMAND_DIR 覆盖。 */
const commandDir = (): string => process.env.READER_COMMAND_DIR ?? path.join(DATA_DIR, 'commands');

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function loadPlan(projectId: string): Promise<CommandPlan | null> {
  try {
    const raw = await fsp.readFile(planFile(projectId), 'utf8');
    const parsed = JSON.parse(raw) as CommandPlan;
    return parsed && Array.isArray(parsed.commands) ? parsed : null;
  } catch {
    return null;
  }
}

export async function savePlan(plan: CommandPlan): Promise<void> {
  await fsp.mkdir(plansDir(), { recursive: true });
  await fsp.writeFile(planFile(plan.projectId), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

// ------------------------------------------------------------------ 执行

export interface RunInput {
  registry: ProjectRegistry;
  projectId: string;
  command: string;
  kind?: CommandKind;
  background?: boolean;
}

/** 内存里的运行记录（IDE 后端一重启就清；不假装跨重启还活着）。 */
const runs = new Map<string, CommandRun>();
/** 后台运行对应的 worker pid（停止时杀它，整棵树一起带走）。 */
const workers = new Map<string, number>();

/** 后台命令 worker 脚本（与本文件同仓：bin/run-with-log.mjs；backend/src → 仓库根）。 */
const workerFile = () => path.resolve(import.meta.dirname, '../../bin/run-with-log.mjs');

export async function runCommand(input: RunInput): Promise<CommandRun> {
  const project = input.registry.get(input.projectId);
  if (!project) throw new Error(`项目不存在：${input.projectId}`);
  const command = input.command.trim();
  if (!command) throw new Error('命令为空');
  const blocked = blockReason(command);
  if (blocked) throw new Error(`这条命令被拒绝执行（${blocked}）：${command}`);

  const kind: CommandKind = KIND_VALUES.includes(input.kind as CommandKind) ? (input.kind as CommandKind) : 'other';
  const run: CommandRun = {
    id: randomUUID(),
    projectId: project.id,
    command,
    kind,
    background: input.background === true,
    startedAt: Date.now(),
    status: 'running',
  };
  if (run.background) await runInBackground(run, project.root);
  else await runInForeground(run, project.root);
  remember(run);
  return { ...run };
}

/** 平台 shell：Windows 走 cmd.exe /c，其余走 /bin/sh -c。 */
function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

async function runInForeground(run: CommandRun, cwd: string): Promise<void> {
  const { file, args } = shellCommand(run.command);
  const child = spawn(file, args, { cwd, windowsHide: true, env: process.env });
  let output = '';
  let overflowed = false;
  const collect = (chunk: Buffer): void => {
    if (overflowed) return;
    output += chunk.toString('utf8');
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS);
      overflowed = true;
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, FOREGROUND_TIMEOUT_MS);
  timer.unref?.();

  const code = await new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (exitCode) => resolve(exitCode));
  });
  clearTimeout(timer);

  run.endedAt = Date.now();
  run.exitCode = code;
  run.status = timedOut ? 'failed' : code === 0 ? 'done' : 'failed';
  run.output =
    output +
    (overflowed ? `\n…（输出超过 ${MAX_OUTPUT_CHARS} 字符，已截断）` : '') +
    (timedOut ? `\n…（超过 ${FOREGROUND_TIMEOUT_MS / 1000} 秒仍未结束，已终止；这种长任务请用「后台运行」）` : '');
}

async function runInBackground(run: CommandRun, cwd: string): Promise<void> {
  const dir = path.join(commandDir(), 'logs');
  await fsp.mkdir(dir, { recursive: true });
  const logPath = path.join(dir, `${run.id}.log`);
  await fsp.writeFile(logPath, '');
  // 真正干活的是独立 worker（bin/run-with-log.mjs）：它用 pipe 收输出、自己写日志。
  // 这样 IDE 后端重启不会带走用户起的服务，日志也不会撞上 cmd 的缓冲 / 重定向丢输出。
  const child = spawn(process.execPath, [workerFile(), JSON.stringify({ command: run.command, cwd, logPath })], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const childPid = await new Promise<number | null>((resolve) => {
    let buffer = '';
    const timer = setTimeout(() => resolve(null), 3000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const pid = (JSON.parse(buffer.slice(0, newline)) as { childPid?: number }).childPid;
        resolve(typeof pid === 'number' && pid > 0 ? pid : null);
      } catch {
        resolve(null);
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  child.unref();
  // worker 只在启动时写那一行，之后不再碰 stdout；关掉读端免得占着事件循环。
  child.stdout?.destroy();

  run.pid = childPid ?? child.pid ?? undefined;
  run.logPath = logPath;
  workers.set(run.id, child.pid ?? 0);
  logInfo('commands.run.background', { pid: run.pid ?? 0, worker: child.pid ?? 0, log: logPath });
}

/** 杀进程树（Windows 用 taskkill，其它平台 SIGTERM）。与 services.ts 同款。 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function remember(run: CommandRun): void {
  runs.set(run.id, run);
  const mine = [...runs.values()].filter((item) => item.projectId === run.projectId);
  if (mine.length <= MAX_RUNS_PER_PROJECT) return;
  mine.sort((a, b) => b.startedAt - a.startedAt);
  for (const stale of mine.slice(MAX_RUNS_PER_PROJECT)) {
    if (stale.status === 'running') continue;
    runs.delete(stale.id);
  }
}

/** 某个项目的运行记录（新的在前）。running 的后台任务顺手探活 + 带日志尾部。 */
export async function listRuns(projectId: string): Promise<CommandRun[]> {
  const mine = [...runs.values()].filter((run) => run.projectId === projectId);
  for (const run of mine) {
    if (run.status === 'running' && run.background && run.pid && !isAlive(run.pid)) {
      // worker 退出时会写 exit.json；有它就按真实退出码收尾，没有就是被强杀 / 后端重启过。
      const exit = await readExit(run.logPath);
      if (exit) {
        run.status = exit.exitCode === 0 ? 'done' : 'failed';
        run.exitCode = exit.exitCode ?? null;
        run.endedAt = exit.endedAt ?? Date.now();
      } else {
        run.status = 'lost';
        run.endedAt = run.endedAt ?? Date.now();
      }
      workers.delete(run.id);
    }
  }
  mine.sort((a, b) => b.startedAt - a.startedAt);
  const top = mine.slice(0, MAX_RUNS_PER_PROJECT);
  const out: CommandRun[] = [];
  for (const run of top) {
    const copy = { ...run };
    if (copy.status === 'running' && copy.background) copy.output = await readLogTail(copy.logPath);
    out.push(copy);
  }
  return out;
}

export function stopRun(projectId: string, runId: string): CommandRun {
  const run = runs.get(runId);
  if (!run || run.projectId !== projectId) throw new Error(`没有这条运行记录：${runId}`);
  if (run.status !== 'running') throw new Error('这条命令已经结束了');
  // 杀 worker 整棵树（worker 是本进程的子进程，树杀会带上 shell 与真正的命令）。
  killTree(workers.get(runId) ?? run.pid);
  workers.delete(runId);
  run.status = 'stopped';
  run.endedAt = Date.now();
  return { ...run };
}

/** 读 worker 留下的退出记录（后台命令结束时写）。 */
async function readExit(logPath?: string): Promise<{ exitCode: number | null; endedAt?: number } | null> {
  if (!logPath) return null;
  try {
    return JSON.parse(await fsp.readFile(`${logPath}.exit.json`, 'utf8')) as {
      exitCode: number | null;
      endedAt?: number;
    };
  } catch {
    return null;
  }
}

/** 读日志尾部若干字符（不整文件读进来）。 */
async function readLogTail(logPath?: string): Promise<string | undefined> {
  if (!logPath) return undefined;
  try {
    const stat = await fsp.stat(logPath);
    const size = Math.min(stat.size, LOG_TAIL_CHARS);
    const handle = await fsp.open(logPath, 'r');
    try {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
      const text = buffer.toString('utf8');
      return stat.size > LOG_TAIL_CHARS ? `…（只显示最后 ${LOG_TAIL_CHARS} 字符）\n${text}` : text;
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/** 仅供测试：清掉内存里的运行记录。 */
export function resetRunsForTest(): void {
  runs.clear();
  workers.clear();
}
