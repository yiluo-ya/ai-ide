/**
 * 适配器工厂：后端类型 → 实现。加自己的 agent 只需要改这里 + `types.ts` 的 BackendKind。
 *
 * builtin = 本项目自带的最简 agent（用「模型」配置里的 OpenAI 兼容端点）；
 * pi = 本机 pi CLI（RPC 模式，用 pi 自己的凭证与工具集）。
 * OpenHands 还没接：调用时给出「怎么接」的指引，而不是假装能用。
 */
import { BuiltinAgent } from './builtin';
import { PiAgent } from './pi';
import type { AdapterOptions, AgentAdapter, BackendKind } from './types';

/** 还没实现的后端各自的接入指引（错误信息直接给用户看，所以要具体）。 */
const NOT_IMPLEMENTED: Partial<Record<BackendKind, string>> = {
  openhands: 'OpenHands 适配器还没接：可走 agent-server 的 REST + 事件 WebSocket。实现 AgentAdapter 后在这里注册。',
};

export function createAdapter(kind: BackendKind, options: AdapterOptions): AgentAdapter {
  switch (kind) {
    case 'builtin':
      return new BuiltinAgent(options);
    case 'pi':
      return new PiAgent(options);
    case 'openhands':
      throw new Error(NOT_IMPLEMENTED.openhands ?? 'openhands 适配器还没接');
  }
}
