/** 运行配置：端口、监听地址、数据目录、前端产物目录、CORS 与「同机同目录分享」提示。 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShareHint } from '../../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
/** backend/src → 仓库根 */
export const REPO_ROOT = path.resolve(here, '..', '..');

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * 数据目录（项目列表 / 模型配置 / 索引快照 / 命令清单…）。
 * 2026-10-03 用户要求：默认放**用户主目录下的 `.ide/`**，不把状态写进被阅读的仓库。
 * 老版本的 `<仓库根>/data` 会在启动时自动复制过来（见 `bootstrap.migrateLegacyDataDir`，只复制不删）。
 */
export const DATA_DIR = process.env.READER_DATA_DIR
  ? path.resolve(process.env.READER_DATA_DIR)
  : path.join(os.homedir(), '.ide');

export const FRONTEND_DIST = process.env.READER_FRONTEND_DIST
  ? path.resolve(process.env.READER_FRONTEND_DIST)
  : path.join(REPO_ROOT, 'frontend', 'dist');

/** 关闭后不再起 chokidar 监听（测试或只读场景用）。 */
export const WATCH_ENABLED = process.env.READER_WATCH !== '0';

// ------------------------------------------------ 索引底座（06-platform P4/P5/P7/P8）

/** P4：索引快照持久化（`READER_PERSIST=0` 关闭，测试 / 排障用）。 */
export const PERSIST_ENABLED = process.env.READER_PERSIST !== '0';

/** P7：定期对账间隔（毫秒，`0` = 关闭；默认 10 分钟）。 */
export function parseVerifyIntervalMs(raw: string | undefined): number {
  const n = Number(raw ?? 600_000);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const VERIFY_INTERVAL_MS = parseVerifyIntervalMs(process.env.READER_VERIFY_MS);

/**
 * P5：并行解析 worker 数。`READER_PARSE_WORKERS=0` 强制串行；
 * 默认 `min(4, max(2, cpus-1))`（Q9）。worker 不可用时自动回落串行。
 */
export function parseWorkers(raw: string | undefined, cpus: number): number {
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return Math.min(4, Math.max(2, cpus - 1));
}

export const PARSE_WORKERS = parseWorkers(process.env.READER_PARSE_WORKERS, os.cpus().length);

/** P8：内置忽略黑名单开关（`READER_IGNORE_BUILTIN=0` 关闭，排障用；node_modules/.git 仍是硬保护）。 */
export const IGNORE_BUILTIN = process.env.READER_IGNORE_BUILTIN !== '0';

/**
 * CORS 来源白名单：逗号分隔（`a.com,b.com`）。未配置 / 全是空项 → `['*']`（放开）。
 * hono 的 cors 收到数组时只对命中的 Origin 回显对应值，不会把白名单本身发出去。
 */
export function parseCorsOrigins(raw: string | undefined | null): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length ? list : ['*'];
}

/** 解析后的 CORS 白名单（`['*']` = 默认放开；共享前应设 READER_CORS_ORIGIN 收紧）。 */
export const CORS_ORIGINS = parseCorsOrigins(process.env.READER_CORS_ORIGIN);

/** 仅本机可达的监听地址（共享模式 = 不在此集合内，此时按「不可信来源」处理）。 */
export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** 仅本机监听时的说明；也是 shareHint=null 时的「如何放开」。 */
export const SHARE_NOTE_LOCAL = '当前只监听 127.0.0.1，仅本机可访问；要同机同目录分享，用 HOST=0.0.0.0 重启';
/** 已放开监听时的分享说明。 */
export const SHARE_NOTE_SHARED = '同一局域网内的人打开链接即可阅读';

/** 本机局域网 IPv4（排除回环 / 内部地址），用于「同机同目录分享」提示。 */
export function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * 同机同目录分享提示：仅监听本机（127.0.0.1 / localhost / ::1）时返回 null。
 * 监听 `0.0.0.0` / `::` 时取第一个局域网 IPv4；取不到（无网卡）也返回 null。
 */
export function shareHintFor(host: string = HOST, port: number = PORT): ShareHint | null {
  if (LOCAL_HOSTS.has(host)) return null;
  const addresses = host === '0.0.0.0' || host === '::' ? lanIPv4Addresses() : [host];
  const address = addresses[0];
  if (!address) return null;
  return { url: `http://${address}:${port}/?project={projectId}`, note: SHARE_NOTE_SHARED };
}

// ------------------------------------------------ monorepo 说明符解析（06-platform P10）

/**
 * `ModuleHint` 的可选扩展：语言模块读项目内配置文件（tsconfig / go.work / pyproject.toml）的通道。
 *
 * 背景：`Walker` 的 `ModuleHint` 只保证 exists / files / classFiles / projectMeta，
 * 而 P10 的解析需要「项目根的绝对路径 + 读文件」。这里不改 `walker.ts` 的接口，
 * 改由运行时注入：`server.ts`（bootstrap 的 installProjectHint）给 `ProjectIndex.hint()`
 * 的返回值补一个 `root` 字段 —— 语言模块检测到就用，检测不到就退回纯路径启发式。
 * 若日后 store 自己在 hint() 里提供 root / readFile，本段与注入都可以删掉。
 */
interface HintWithRoot {
  root?: string;
  readFile?: (rel: string) => string | null;
}

const hintTextCache = new Map<string, { mtimeMs: number; text: string | null }>();

/** 从 hint 里取项目根（绝对路径）；没有就返回 null。 */
export function hintRoot(hint: unknown): string | null {
  const h = hint as HintWithRoot | null;
  return typeof h?.root === 'string' && h.root ? h.root : null;
}

/**
 * 读项目内某个相对路径的文本：优先用 `hint.root` 直接读（按 mtime 缓存），
 * 其次用 `hint.readFile`（若上游提供了），都不可用返回 null。失败一律不抛错。
 */
export function readHintFile(hint: unknown, rel: string): string | null {
  const h = hint as HintWithRoot | null;
  const root = hintRoot(hint);
  if (root) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      const hit = hintTextCache.get(abs);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
      const text = fs.readFileSync(abs, 'utf8');
      hintTextCache.set(abs, { mtimeMs: st.mtimeMs, text });
      return text;
    } catch {
      hintTextCache.set(abs, { mtimeMs: 0, text: null });
      return null;
    }
  }
  if (typeof h?.readFile === 'function') return h.readFile(rel);
  return null;
}

/** 读项目内 JSON 文件（容忍行注释 / 块注释与尾逗号，tsconfig 允许这些）。 */
export function readHintJson<T>(hint: unknown, rel: string): T | null {
  const text = readHintFile(hint, rel);
  if (text === null) return null;
  try {
    return JSON.parse(stripJsonComments(text)) as T;
  } catch {
    return null;
  }
}

/** 去掉 JSON 文本里的注释与尾逗号（字符串内的 // 不动）。 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
