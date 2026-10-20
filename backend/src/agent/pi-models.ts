/**
 * 把本项目「模型」配置同步进 pi 自己的凭证与模型目录（FR-0013 需求 5）。
 *
 * 为什么需要：本项目「模型」（`DATA_DIR/model-config.json`）与 pi 的凭证
 * （`~/.pi/agent/auth.json` + `~/.pi/agent/models.json`）互不相识 —— 用户在阅读器里
 * 配好的 provider，pi 会话用不上，得去 pi 里再配一遍。
 *
 * 口径（不替用户做主，也不污染 pi 的配置）：
 * - 只动**我们写过的** provider key（名单记在 `DATA_DIR/pi-sync.json`），pi 自己的
 *   provider / apiKey / modelOverrides 一律原样保留；
 * - `apiKey` 写进 `auth.json`（pi 认这一份），`baseUrl` / `api` / `models` 写进 `models.json`；
 * - 内容没变就不写盘（幂等），保存模型配置、启动、"同步到 pi" 按钮走的是同一个函数。
 *
 * 刻意不做：不改 pi 的默认模型（`settings.json.defaultModel` —— 那是用户的全局偏好，
 * 要用哪个模型在 pi 里 `/model` 选）；不做反向同步（pi → 本项目）。
 */
import fss from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { readAgentRuntimeConfig } from './runtime-config';
import { piCandidates } from './runtime';
import type { ModelConfig, ModelProvider } from './model-config';
import type { ApiType } from './types';

/** 本项目的 apiType → pi 的 `api` 取值（取自 pi 1.0.1 产物里的取值集合）。 */
const PI_API: Record<ApiType, string> = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
  'openai-responses': 'openai-responses',
  gemini: 'google-generative-ai',
};

/** pi 的配置目录：`READER_PI_AGENT_DIR`（测试/覆盖）→ `PI_CODING_AGENT_DIR`（pi 自己的口径）→ `~/.pi/agent`。 */
export function piAgentDir(): string {
  const override = process.env.READER_PI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), '.pi', 'agent');
}

export function piModelsPath(): string {
  return path.join(piAgentDir(), 'models.json');
}

export function piAuthPath(): string {
  return path.join(piAgentDir(), 'auth.json');
}

/** 「我们写过哪些 key」的账本，落在本项目自己的数据目录（不混进 pi 的配置）。 */
export function piSyncManifestPath(): string {
  return path.join(DATA_DIR, 'pi-sync.json');
}

export interface PiSyncOutcome {
  ok: boolean;
  /** pi 的配置目录。 */
  dir: string;
  /** 本次写进 pi 的 provider key。 */
  synced: string[];
  /** 本项目已删、本次从 pi 摘掉的 key。 */
  removed: string[];
  /** 盘上内容真的变了（幂等调用时为 false）。 */
  changed: boolean;
  error?: string;
}

export interface PiSyncStatus {
  dir: string;
  /** pi 是否可用（定位链落到真实文件，或它的配置目录已存在）。 */
  installed: boolean;
  /** 账本里记着的 key（= 已同步过的 provider 数量）。 */
  keys: string[];
}

/** 同步状态（「模型」面板的状态行用）：不写盘，只看一眼。 */
export async function piSyncStatus(): Promise<PiSyncStatus> {
  const manifest = await readManifest();
  return {
    dir: piAgentDir(),
    installed: await piInstalled(),
    keys: Object.values(manifest.keys),
  };
}

/** pi 是否可用：定位链找到真实文件，或它已经跑过（配置目录存在）。 */
export async function piInstalled(): Promise<boolean> {
  const config = await readAgentRuntimeConfig();
  if (piCandidates(config).some((candidate) => candidate.resolved)) return true;
  try {
    return (await fsp.stat(piAgentDir())).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 同步：`config` 里每个 provider 写进 pi 的 `models.json`（baseUrl / api / models）
 * 与 `auth.json`（apiKey）；本项目已删的 provider 从 pi 摘掉。幂等。
 */
export async function syncModelsToPi(config: ModelConfig): Promise<PiSyncOutcome> {
  const dir = piAgentDir();
  const empty = { dir, synced: [], removed: [], changed: false };
  if (!(await piInstalled())) {
    return {
      ...empty,
      ok: false,
      error: '没找到 pi：先在 pi 会话的「在终端安装」里装上，或到「设置 → Code Agent 后端」填它的路径',
    };
  }

  try {
    const manifest = await readManifest();
    // 本项目一个 provider 都没有、又没同步过什么：不写盘（别在人家 pi 目录里造出一个空文件）
    if (config.providers.length === 0 && Object.keys(manifest.keys).length === 0) {
      return { ...empty, ok: true };
    }
    const models = await readJson(piModelsPath());
    const auth = await readJson(piAuthPath());
    const providers = asRecord(models.providers);
    const credentials = asRecord(auth);

    const synced: string[] = [];
    const nextKeys: Record<string, string> = {};
    const used = new Set(Object.keys(providers));

    for (const provider of config.providers) {
      const key = keyFor(provider, manifest.keys[provider.id], used);
      used.add(key);
      nextKeys[provider.id] = key;
      providers[key] = {
        baseUrl: provider.baseUrl,
        api: PI_API[provider.apiType] ?? PI_API.openai,
        models: provider.models.map((id) => ({ id })),
      };
      if (provider.apiKey) credentials[key] = { type: 'api_key', key: provider.apiKey };
      else delete credentials[key];
      synced.push(key);
    }

    // 本项目里已经删掉的 provider：把当初写进去的那条摘掉（别人的条目不动）
    const removed: string[] = [];
    for (const [providerId, key] of Object.entries(manifest.keys)) {
      if (nextKeys[providerId]) continue;
      delete providers[key];
      delete credentials[key];
      removed.push(key);
    }

    models.providers = providers;
    const modelsChanged = await writeJsonIfChanged(piModelsPath(), models);
    const authChanged = await writeJsonIfChanged(piAuthPath(), credentials);
    await writeManifest(nextKeys);

    return { dir, ok: true, synced, removed, changed: modelsChanged || authChanged };
  } catch (error) {
    return { ...empty, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 会话里换模型时用：本项目的 provider id → 写进 pi 的 key（账本）。
 * 没同步过（不在账本里）就返回 undefined，调用方回退用原值交给 pi 报错。
 */
export async function piKeyForProvider(providerId: string): Promise<string | undefined> {
  const manifest = await readManifest();
  return manifest.keys[providerId];
}

/**
 * 反查：pi 报回来的 provider key → 本项目的 provider id。
 * 界面统一显示本项目的 provider id，而不是 pi 内部用的 slug key（如 `deek-2`）。
 */
export async function providerIdForPiKey(key: string): Promise<string | undefined> {
  const manifest = await readManifest();
  for (const [id, piKey] of Object.entries(manifest.keys)) {
    if (piKey === key) return id;
  }
  return undefined;
}

// ------------------------------------------------------------------ 内部

interface SyncManifest {
  version: 1;
  /** 本项目 provider id → 写进 pi 的 key（名字改了就靠它保持稳定）。 */
  keys: Record<string, string>;
}

/**
 * 定 key：账本里有就沿用（provider 改名不会在 pi 里留下孤儿），
 * 否则用名字的 slug；与 pi 已有条目撞名则加序号，绝不覆盖别人的条目。
 */
function keyFor(provider: ModelProvider, existing: string | undefined, used: Set<string>): string {
  if (existing) return existing;
  const base =
    provider.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || provider.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}-${n++}`;
  return key;
}

async function readManifest(): Promise<SyncManifest> {
  const raw = await readJson(piSyncManifestPath());
  const keys = asRecord(raw.keys);
  const clean: Record<string, string> = {};
  for (const [id, key] of Object.entries(keys)) {
    if (typeof key === 'string' && key) clean[id] = key;
  }
  return { version: 1, keys: clean };
}

async function writeManifest(keys: Record<string, string>): Promise<void> {
  await writeJsonIfChanged(piSyncManifestPath(), { version: 1, keys } satisfies SyncManifest);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // 不存在 / 坏 JSON 都当空 —— 我们要写的是「合并后的结果」，起点为空是安全的
    return {};
  }
}

/** 内容没变就不写盘（幂等）；变了则 tmp + rename 原子落盘。返回是否真的改了。 */
async function writeJsonIfChanged(file: string, value: unknown): Promise<boolean> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if ((await fsp.readFile(file, 'utf8')) === text) return false;
  } catch {
    /* 还没这个文件 */
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
  // pi 的 auth.json 里有明文 key，只有本用户可读（Windows 上 chmod 基本是空操作）
  try {
    fss.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
