/**
 * 内置 agent 用的模型配置：provider 列表（base URL + key + 模型 id）+ 默认模型。
 *
 * 为什么不复用别的配置：
 * - 阅读器本身没有「模型」概念（它只读代码，不需要 LLM）；
 * - pi 的凭证在 `~/.pi/agent/auth.json`，属于 pi 自己的地盘，这里不碰。
 *
 * 落地在 `DATA_DIR/model-config.json`，权限 0o600（里面有明文 key）。
 * 对外只给打码视图；解析出的 key 仅在服务端内存里传给适配器。
 */
import fss from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config';
import type { ModelRef, ResolvedLlm } from './types';

export interface ModelProvider {
  id: string;
  name: string;
  /** OpenAI 兼容 base URL，如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** 这个 provider 下可选的模型 id。 */
  models: string[];
}

export interface ModelConfig {
  version: 1;
  providers: ModelProvider[];
  /** 没显式选模型的会话用它。 */
  default?: ModelRef;
}

/** 打码后的 provider（发给前端）。 */
export interface PublicModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  /** 形如 `sk-abc…1234`，只用于让人认出是哪把 key。 */
  keyHint?: string;
}

export interface PublicModelConfig {
  providers: PublicModelProvider[];
  default: ModelRef | null;
  path: string;
}

export function modelConfigPath(): string {
  // 允许覆盖：测试用临时文件，避免写进真实的 data/
  return process.env.READER_MODEL_CONFIG ?? path.join(DATA_DIR, 'model-config.json');
}

let cache: ModelConfig | null = null;

export async function loadModelConfig(): Promise<ModelConfig> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(modelConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ModelConfig>;
    cache = {
      version: 1,
      providers: Array.isArray(parsed.providers) ? parsed.providers.filter(isProvider) : [],
      ...(isModelRef(parsed.default) ? { default: parsed.default } : {}),
    };
  } catch {
    cache = { version: 1, providers: [] };
  }
  return cache;
}

export async function saveModelConfig(next: ModelConfig): Promise<void> {
  cache = next;
  const file = modelConfigPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  // key 是明文，只有本用户可读（Windows 上 chmod 基本是空操作，失败也不影响功能）
  try {
    fss.chmodSync(file, 0o600);
  } catch {
    /* 忽略 */
  }
}

export function publicModelConfig(config: ModelConfig): PublicModelConfig {
  return {
    providers: config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models,
      hasKey: Boolean(provider.apiKey),
      ...(provider.apiKey ? { keyHint: maskKey(provider.apiKey) } : {}),
    })),
    default: config.default ?? null,
    path: modelConfigPath(),
  };
}

/** 新增或更新一个 provider：不传 id 就新建；不传 apiKey 就沿用原值（前端不必回传密钥）。 */
export async function upsertProvider(input: {
  id?: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  models?: string[];
}): Promise<ModelProvider> {
  const config = await loadModelConfig();
  const existing = input.id ? config.providers.find((p) => p.id === input.id) : undefined;
  const provider: ModelProvider = {
    id: existing?.id ?? input.id ?? `p-${Date.now().toString(36)}`,
    name: input.name?.trim() || existing?.name || input.baseUrl,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey?.trim() || existing?.apiKey || '',
    models: (input.models ?? existing?.models ?? []).map((m) => m.trim()).filter(Boolean),
  };
  const providers = existing
    ? config.providers.map((p) => (p.id === provider.id ? provider : p))
    : [...config.providers, provider];
  await saveModelConfig({ ...config, providers });
  return provider;
}

export async function removeProvider(id: string): Promise<void> {
  const config = await loadModelConfig();
  const providers = config.providers.filter((p) => p.id !== id);
  const keepDefault = config.default && providers.some((p) => p.id === config.default?.provider);
  await saveModelConfig({
    version: 1,
    providers,
    ...(keepDefault ? { default: config.default } : {}),
  });
}

export async function setDefaultModel(ref: ModelRef | null): Promise<void> {
  const config = await loadModelConfig();
  await saveModelConfig(ref ? { ...config, default: ref } : { version: 1, providers: config.providers });
}

/** `{provider, modelId}` → 调用所需的一切；错就抛一条能直接给用户看的信息。 */
export async function resolveLlm(ref: ModelRef): Promise<ResolvedLlm> {
  const config = await loadModelConfig();
  const provider = config.providers.find((p) => p.id === ref.provider);
  if (!provider) throw new Error(`未知的模型 provider：${ref.provider}（先去「设置 → 模型」添加）`);
  if (!provider.apiKey) throw new Error(`provider「${provider.name}」还没有 API key`);
  if (provider.models.length > 0 && !provider.models.includes(ref.modelId)) {
    throw new Error(`provider「${provider.name}」下没有模型 ${ref.modelId}`);
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: ref.modelId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  };
}

/** 会话没选模型时用的默认模型；一个都没有时返回 null。 */
export async function fallbackModel(): Promise<ModelRef | null> {
  const config = await loadModelConfig();
  if (config.default) return config.default;
  const first = config.providers.find((p) => p.apiKey && p.models.length > 0);
  return first ? { provider: first.id, modelId: first.models[0] } : null;
}

/** 清掉进程内缓存（测试与「保存后立刻生效」用）。 */
export function resetModelConfigCache(): void {
  cache = null;
}

function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function isProvider(value: unknown): value is ModelProvider {
  const p = value as Partial<ModelProvider> | null;
  return Boolean(p && typeof p.id === 'string' && typeof p.baseUrl === 'string');
}

function isModelRef(value: unknown): value is ModelRef {
  const r = value as Partial<ModelRef> | null;
  return Boolean(r && typeof r.provider === 'string' && typeof r.modelId === 'string');
}
