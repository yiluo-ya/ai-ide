/**
 * Code Agent 后端的运行时配置（FR-0007）：目前只有 pi 的可执行路径。
 *
 * 为什么不放前端 prefs：这个路径要给后端 spawn 用（见 `runtime.ts`），存服务端自己的数据目录
 * `DATA_DIR/agent-runtime.json`（可用 READER_AGENT_RUNTIME 覆盖，测试用，写法同 `user-ignore.ts`）。
 * 配置坏了不该挡启动 —— 读到非法 JSON 一律当空配置。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config';

export interface AgentRuntimeConfig {
  /** 手填的 pi 路径（文件或目录）；空 = 没填，走落点与 PATH。 */
  piPath: string;
}

/** 配置文件路径（`READER_AGENT_RUNTIME` 覆盖优先，测试用）。 */
export function agentRuntimeFile(): string {
  return process.env.READER_AGENT_RUNTIME ?? path.join(DATA_DIR, 'agent-runtime.json');
}

/** 读配置；文件不存在 / 不是合法 JSON / 字段类型不对，都当空配置。 */
export async function readAgentRuntimeConfig(): Promise<AgentRuntimeConfig> {
  let text: string;
  try {
    text = await fsp.readFile(agentRuntimeFile(), 'utf8');
  } catch {
    return { piPath: '' };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return { piPath: typeof parsed?.piPath === 'string' ? parsed.piPath.trim() : '' };
  } catch {
    return { piPath: '' };
  }
}

/** 写配置（目录不存在就建），返回写进去的值。 */
export async function writeAgentRuntimeConfig(config: AgentRuntimeConfig): Promise<AgentRuntimeConfig> {
  const next: AgentRuntimeConfig = { piPath: (config.piPath ?? '').trim() };
  const file = agentRuntimeFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
