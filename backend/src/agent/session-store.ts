/**
 * Code Agent 会话记录的落盘（FR-0013）。
 *
 * 布局：`<DATA_DIR>/sessions/<projectId>/<sessionId>.json` —— 元数据（谁、哪个后端、哪个模型）
 * 加上**内置 agent 的完整消息**；pi 的原始会话写在同目录的 `pi/` 下（由 `--session-dir` 指定），
 * 这里不再抄一份 —— 同一份历史只留一个真相，避免两边对不上。
 *
 * 为什么落在 `DATA_DIR`（默认 `~/.ide`）而不是被读的项目目录：沿用「不把状态写进被阅读的仓库」
 * 的既有口径（见 `config.ts` 的 DATA_DIR 注释）；再按 `projectId` 分目录，会话仍然是「跟随项目」的。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config';
import type { AgentMessage, BackendKind } from './types';

/** 一条落盘的会话记录。 */
export interface StoredSession {
  version: 1;
  id: string;
  name: string;
  projectId: string;
  backend: BackendKind;
  createdAt: number;
  updatedAt: number;
  /** 会话选的模型（恢复时用它重建适配器）。 */
  provider?: string;
  modelId?: string;
  messageCount: number;
  /** 内置 agent 的历史；pi 为 undefined（消息在 pi 自己的会话文件里）。 */
  messages?: AgentMessage[];
}

/** 会话记录根目录（`READER_SESSION_DIR` 可覆盖，测试用）。 */
export function sessionsRoot(): string {
  return process.env.READER_SESSION_DIR
    ? path.resolve(process.env.READER_SESSION_DIR)
    : path.join(DATA_DIR, 'sessions');
}

/** 一个项目的会话目录。 */
export function projectSessionsDir(projectId: string): string {
  return path.join(sessionsRoot(), safeSegment(projectId));
}

/** pi 的会话目录（`--session-dir`）：`<项目会话目录>/pi/`。 */
export function piSessionDir(projectId: string): string {
  return path.join(projectSessionsDir(projectId), 'pi');
}

/** 会话记录文件。 */
export function sessionFile(projectId: string, id: string): string {
  return path.join(projectSessionsDir(projectId), `${safeSegment(id)}.json`);
}

export async function readSession(projectId: string, id: string): Promise<StoredSession | null> {
  return readFile(sessionFile(projectId, id));
}

/**
 * 只凭 id 找记录：`GET/POST /sessions/:id/*` 这些路由手上只有 id，
 * 而会话目录按项目分片 —— 会话数量是「人聊过的条数」，遍历代价可忽略。
 */
export async function findStored(id: string): Promise<StoredSession | null> {
  const safe = safeSegment(id);
  for (const dir of await projectDirs()) {
    const record = await readFile(path.join(dir, `${safe}.json`));
    if (record) return record;
  }
  return null;
}

/** 列出全部记录（可按项目过滤），按创建时间升序。 */
export async function listStored(projectId?: string): Promise<StoredSession[]> {
  const dirs = projectId ? [projectSessionsDir(projectId)] : await projectDirs();
  const out: StoredSession[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const record = await readFile(path.join(dir, name));
      if (record) out.push(record);
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** 写一条记录（tmp + rename 原子落盘，中途失败不会留下半个 JSON）。 */
export async function writeSession(record: StoredSession): Promise<void> {
  const file = sessionFile(record.projectId, record.id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

/** 删除记录 + pi 那边的会话文件（`<目录>/pi/**\/*_<id>.jsonl`）。 */
export async function removeSession(projectId: string, id: string): Promise<void> {
  await fsp.rm(sessionFile(projectId, id), { force: true });
  const dir = piSessionDir(projectId);
  const safe = safeSegment(id);
  for (const file of await jsonlFiles(dir)) {
    if (path.basename(file).includes(safe)) await fsp.rm(file, { force: true });
  }
}

// ------------------------------------------------------------------ 内部

async function projectDirs(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(sessionsRoot(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(sessionsRoot(), e.name));
  } catch {
    return [];
  }
}

/** 递归收集 `.jsonl`（pi 的会话文件按 cwd 再分一层子目录）。 */
async function jsonlFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsonlFiles(full)));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

async function readFile(file: string): Promise<StoredSession | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.projectId !== 'string') return null;
    if (parsed.backend !== 'builtin' && parsed.backend !== 'pi' && parsed.backend !== 'openhands') return null;
    return {
      version: 1,
      id: parsed.id,
      name: typeof parsed.name === 'string' ? parsed.name : parsed.id,
      projectId: parsed.projectId,
      backend: parsed.backend,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
      ...(typeof parsed.modelId === 'string' ? { modelId: parsed.modelId } : {}),
      messageCount: typeof parsed.messageCount === 'number' ? parsed.messageCount : 0,
      ...(Array.isArray(parsed.messages) ? { messages: parsed.messages as AgentMessage[] } : {}),
    };
  } catch {
    // 坏记录（半写 / 手改坏）当不存在：会话列表少一条，不影响其它会话
    return null;
  }
}

/** 目录 / 文件名安全片段：projectId 与 sessionId 都是我们自己生成的，这里只防手改出的路径穿越。 */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
