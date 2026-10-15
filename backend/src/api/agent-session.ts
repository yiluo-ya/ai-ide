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
  lastPiSync,
  loadModelConfig,
  normalizeApiType,
  publicModelConfig,
  removeProvider,
  setDefaultModel,
  syncModelsToPiNow,
  upsertProvider,
} from '../agent/model-config';
import { piSyncStatus } from '../agent/pi-models';
import { probeLlm } from '../agent/probe';
import { isPiNotFound } from '../agent/runtime';
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
      apiType: str(body.apiType),
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

  /**
   * 测试连接：拿表单里的值（可能还没保存）发一条最小请求。
   * 没带 apiKey 但带了 id 时，回退用已保存的 key —— 编辑已有 provider 时表单不回填明文 key。
   */
  app.post('/model-config/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const baseUrl = str(body.baseUrl);
    if (!baseUrl) return c.json({ error: 'bad_request', message: 'baseUrl 必填' }, 400);

    const id = str(body.id);
    let apiKey = str(body.apiKey) ?? '';
    if (!apiKey && id) {
      const config = await loadModelConfig();
      apiKey = config.providers.find((p) => p.id === id)?.apiKey ?? '';
    }
    if (!apiKey) return c.json({ error: 'bad_request', message: '还没有 API key：填一个再测' }, 400);

    const modelId = str(body.modelId);
    const models = modelId
      ? [modelId]
      : Array.isArray(body.models)
        ? body.models.filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
        : [];
    if (models.length === 0) return c.json({ error: 'bad_request', message: '至少填一个模型 id 再测' }, 400);

    const apiType = normalizeApiType(body.apiType);
    const results = [];
    for (const model of models) {
      results.push(await probeLlm({ apiType, baseUrl, apiKey, modelId: model }));
    }
    return c.json({ ok: results.every((r) => r.ok), results });
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

  // ----------------------------------------------------- 模型配置同步到 pi（FR-0013）

  /** 同步状态：「模型」面板的状态行（pi 在哪、装没装、同步过哪几个）。 */
  app.get('/model-config/pi-sync', async (c) => c.json({ ...(await piSyncStatus()), last: lastPiSync() }));

  /**
   * 手动重推（幂等）。装上 pi 之后点一下就行，不需要回去改模型配置。
   * 与保存模型配置时的自动同步走同一个函数（`READER_PI_SYNC=0` 时两边都关）。
   */
  app.post('/model-config/sync-pi', async (c) => {
    const outcome = await syncModelsToPiNow();
    if (!outcome) return c.json({ error: 'disabled', message: 'pi 同步已关闭（READER_PI_SYNC=0）' }, 400);
    return c.json({ ...outcome, status: await piSyncStatus() });
  });

  // ----------------------------------------------------------------- 会话

  /** 会话未载入（重启后 / 刷新页面）就先按磁盘记录拉起来；拉不起来返回 false。 */
  const ensureSession = async (id: string): Promise<boolean> => {
    if (sessions.has(id)) return true;
    try {
      await sessions.resume(id);
      return true;
    } catch {
      return false;
    }
  };

  app.get('/sessions', async (c) => c.json({ sessions: await sessions.list() }));

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
      // 没装 pi：给一条能直接写进终端的安装命令（FR-0013 需求 3）
      if (isPiNotFound(error)) {
        return c.json(
          { error: 'pi_not_found', message: error.message, installCommand: error.installCommand },
          400,
        );
      }
      return c.json({ error: 'agent_session_failed', message: message(error) }, 400);
    }
  });

  app.get('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ session: await sessions.refresh(id) });
    } catch {
      return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    }
  });

  /**
   * 续传（FR-0013 需求 4）：重启后进程里没有这个会话，用磁盘记录把它拉起来。
   * 幂等（已经在跑就直接返回摘要），所以前端每次选中会话都可以调。
   */
  app.post('/sessions/:id/resume', async (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ session: await sessions.resume(id) });
    } catch (error) {
      return c.json({ error: 'agent_resume_failed', message: message(error) }, 404);
    }
  });

  app.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const removed = await sessions.remove(id);
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
    if (!(await ensureSession(id))) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
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
    if (!(await ensureSession(id))) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    const adapter = sessions.get(id);
    if (!adapter) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    await adapter.abort();
    return c.json({ ok: true });
  });

  app.post('/sessions/:id/model', async (c) => {
    const id = c.req.param('id');
    if (!(await ensureSession(id))) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
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
    if (!(await ensureSession(id))) return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
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
  app.get('/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    // 刷新页面后直接连事件流：会话还没载入就先拉起来（否则 404）
    if (!(await ensureSession(id))) {
      return c.json({ error: 'not_found', message: `会话不存在：${id}` }, 404);
    }
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
