/**
 * agent 会话的 HTTP 接口：会话增删 / 对话 / 中止 / 事件流（SSE），以及内置 agent 的模型配置。
 *
 * 为什么是普通 HTTP + SSE（而不是 WebSocket）：本项目其余部分（搜索流、索引事件）都是这套，
 * 前端已有 SSE 解析习惯；agent 的交互是「发一条 → 看流」，SSE 足够，且没有新的连接管理。
 *
 * 全部挂在 `/api/agent` 下（与已有的 `GET /api/agent/tools`、`POST /api/agent/:id/call` 共存）。
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  loadModelConfig,
  publicModelConfig,
  removeProvider,
  setDefaultModel,
  upsertProvider,
} from '../agent/model-config';
import { isBackendKind } from '../agent/types';
import type { AgentSessions } from '../agent/sessions';

/** 心跳间隔：SSE 长连接中间有代理时，太久不说话会被掐。 */
const PING_MS = 15_000;
/** 心跳用 500ms 分片等待，这样连接关闭时最多 0.5 秒就退出（与 FR-0004 的 dispose 语义一致）。 */
const SLICE_MS = 500;

export function createAgentSessionRoutes(sessions: AgentSessions): Hono {
  const app = new Hono();

  // ------------------------------------------------------------- 模型配置

  app.get('/model-config', async (c) => c.json(publicModelConfig(await loadModelConfig())));

  app.post('/model-config', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const baseUrl = str(body.baseUrl);
    if (!baseUrl) return c.json({ error: 'bad_request', message: 'baseUrl 必填' }, 400);
    const models = Array.isArray(body.models)
      ? body.models.filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
      : undefined;
    const saved = await upsertProvider({
      id: str(body.id),
      name: str(body.name),
      baseUrl,
      apiKey: str(body.apiKey),
      models,
    });
    return c.json({
      ok: true,
      provider: publicModelConfig({ version: 1, providers: [saved] }).providers[0],
      config: publicModelConfig(await loadModelConfig()),
    });
  });

  app.post('/model-config/remove', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = str(body.id);
    if (!id) return c.json({ error: 'bad_request', message: 'id 必填' }, 400);
    await removeProvider(id);
    return c.json({ ok: true, config: publicModelConfig(await loadModelConfig()) });
  });

  app.post('/model-config/default', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = str(body.provider);
    const modelId = str(body.modelId);
    if (body.clear === true) {
      await setDefaultModel(null);
      return c.json({ ok: true, config: publicModelConfig(await loadModelConfig()) });
    }
    if (!provider || !modelId) return c.json({ error: 'bad_request', message: 'provider 与 modelId 必填' }, 400);
    await setDefaultModel({ provider, modelId });
    return c.json({ ok: true, config: publicModelConfig(await loadModelConfig()) });
  });

  // ----------------------------------------------------------------- 会话

  app.get('/sessions', (c) => c.json({ sessions: sessions.list() }));

  app.post('/sessions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const projectId = str(body.projectId);
    if (!projectId) return c.json({ error: 'bad_request', message: 'projectId 必填' }, 400);
    const backend = str(body.backend);
    if (backend && !isBackendKind(backend)) {
      return c.json({ error: 'bad_request', message: `未知后端：${backend}` }, 400);
    }
    try {
      const session = await sessions.create({
        projectId,
        ...(str(body.name) ? { name: str(body.name) as string } : {}),
        ...(backend && isBackendKind(backend) ? { backend } : {}),
        ...(str(body.provider) ? { provider: str(body.provider) as string } : {}),
        ...(str(body.modelId) ? { modelId: str(body.modelId) as string } : {}),
        // 只读会话（FR-0005 命令分析）：不给写文件工具。
        ...(body.readOnly === true ? { readOnly: true } : {}),
      });
      return c.json({ session }, 201);
    } catch (error) {
      return c.json({ error: 'agent_session_failed', message: message(error) }, 400);
    }
  });

  app.get('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!sessions.has(id)) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    return c.json({ session: await sessions.refresh(id) });
  });

  app.delete('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const removed = sessions.remove(id);
    return removed
      ? c.json({ ok: true })
      : c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
  });

  app.get('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ messages: await sessions.messages(id) });
    } catch (error) {
      return c.json({ error: 'not_found', message: message(error) }, 404);
    }
  });

  app.post('/sessions/:id/prompt', async (c) => {
    const id = c.req.param('id');
    const adapter = sessions.get(id);
    if (!adapter) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = str(body.message);
    if (!text) return c.json({ error: 'bad_request', message: 'message 必填' }, 400);
    try {
      // 不等这一轮跑完：进度走 SSE 事件，HTTP 只回报「已受理」
      await adapter.prompt(text);
      return c.json({ ok: true, session: await sessions.refresh(id) });
    } catch (error) {
      return c.json({ error: 'agent_prompt_failed', message: message(error) }, 400);
    }
  });

  app.post('/sessions/:id/abort', async (c) => {
    const id = c.req.param('id');
    const adapter = sessions.get(id);
    if (!adapter) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    await adapter.abort();
    return c.json({ ok: true });
  });

  app.post('/sessions/:id/model', async (c) => {
    const id = c.req.param('id');
    const adapter = sessions.get(id);
    if (!adapter) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = str(body.provider);
    const modelId = str(body.modelId);
    if (!provider || !modelId) return c.json({ error: 'bad_request', message: 'provider 与 modelId 必填' }, 400);
    try {
      const model = await adapter.setModel({ provider, modelId });
      return c.json({ ok: true, model, session: await sessions.refresh(id) });
    } catch (error) {
      return c.json({ error: 'agent_model_failed', message: message(error) }, 400);
    }
  });

  app.post('/sessions/:id/rename', async (c) => {
    const id = c.req.param('id');
    if (!sessions.has(id)) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = str(body.name);
    if (!name) return c.json({ error: 'bad_request', message: 'name 必填' }, 400);
    return c.json({ ok: true, session: await sessions.rename(id, name) });
  });

  /**
   * 事件流（SSE）。事件体就是适配层的归一化事件：
   * agent_start / message_start|update|end / tool_execution_start|end / agent_settled，
   * 另有一发 `session_state` 让前端一订阅就有状态。
   */
  app.get('/sessions/:id/events', (c) => {
    const id = c.req.param('id');
    if (!sessions.has(id)) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = sessions.subscribe(id, (event) => {
        if (closed) return;
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
          closed = true;
        });
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      // 心跳：每 15 秒一发；用 500ms 分片等，连接断开时最多 0.5 秒就收尾
      let waited = 0;
      while (!closed) {
        await new Promise((r) => setTimeout(r, SLICE_MS));
        waited += SLICE_MS;
        if (waited < PING_MS) continue;
        waited = 0;
        await stream.writeSSE({ event: 'ping', data: JSON.stringify({ at: Date.now() }) }).catch(() => {
          closed = true;
        });
      }
      unsubscribe();
    });
  });

  return app;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
