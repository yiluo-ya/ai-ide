import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, request, subscribeEvents } from './api';

/**
 * API 客户端（纯逻辑部分）：URL 拼装 / query 编码 / 错误信息 / SSE 解析。
 * 真实后端行为由 backend/tests 与 tests/ui 覆盖，这里只钉住客户端的契约。
 */

const BASE = '/api';

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function callOf(fn: ReturnType<typeof mockFetch>, index = 0): FetchArgs {
  return fn.mock.calls[index] as unknown as FetchArgs;
}

describe('api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('request 请求 /api 前缀，失败时抛出后端 message', async () => {
    const fn = mockFetch(() => jsonResponse({ message: '项目不存在' }, 404, 'Not Found'));
    await expect(request('/projects/none')).rejects.toThrow('项目不存在');
    expect(String(callOf(fn)[0])).toBe(`${BASE}/projects/none`);
  });

  it('request 的响应体不是 JSON 时，回落到状态码文本', async () => {
    mockFetch(() => new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(request('/health')).rejects.toThrow('502 Bad Gateway');
  });

  it('文件路径与查询词都做 URL 编码（含空格 / 斜杠 / 中文）', async () => {
    const fn = mockFetch(() => jsonResponse({ file: 'x', lang: 'ts', text: '', size: 0 }));
    await api.fileText('p1', 'src/a b/中文.ts');
    expect(String(callOf(fn)[0])).toBe(`${BASE}/projects/p1/file?path=src%2Fa%20b%2F%E4%B8%AD%E6%96%87.ts`);

    const fn2 = mockFetch(() => jsonResponse({ symbols: [] }));
    await api.workspaceSymbols('p1', 'foo bar', 'function');
    expect(String(callOf(fn2)[0])).toBe(`${BASE}/projects/p1/workspace-symbols?q=foo%20bar&kind=function`);
  });

  it('不带 kind 时不多拼参数；lookupByRoot 编码 root', async () => {
    const fn = mockFetch(() => jsonResponse({ symbols: [] }));
    await api.workspaceSymbols('p1', 'Foo');
    expect(String(callOf(fn)[0])).toBe(`${BASE}/projects/p1/workspace-symbols?q=Foo`);

    const fn2 = mockFetch(() => jsonResponse({ project: { id: 'p1' } }));
    await api.lookupByRoot('D:/code/my project');
    expect(String(callOf(fn2)[0])).toBe(`${BASE}/projects/lookup?root=D%3A%2Fcode%2Fmy%20project`);
  });

  it('POST 接口带上 JSON body 与方法', async () => {
    const fn = mockFetch(() => jsonResponse({ ok: true }));
    await api.gotoDefinition('p1', 'src/a.ts', 3, 7);
    const [url, init] = callOf(fn);
    expect(String(url)).toBe(`${BASE}/projects/p1/goto-definition`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ file: 'src/a.ts', line: 3, col: 7 });
  });

  it('gitWrite：四个命令走 POST，push 额外带 confirm=1，commit 的说明放 body', async () => {
    const fn = mockFetch(() => jsonResponse({ ok: true }));

    await api.gitWrite('p1', 'add');
    let [url, init] = callOf(fn, 0);
    expect(String(url)).toBe(`${BASE}/projects/p1/git-write`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'add' });

    await api.gitWrite('p1', 'push');
    [url, init] = callOf(fn, 1);
    expect(String(url)).toBe(`${BASE}/projects/p1/git-write?confirm=1`);

    await api.gitWrite('p1', 'commit', '修一个 bug');
    [url, init] = callOf(fn, 2);
    expect(String(url)).toBe(`${BASE}/projects/p1/git-write`);
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'commit', message: '修一个 bug' });
  });

  it('searchStream 解析 chunk / done 事件并回调命中', async () => {
    const chunk = { matches: [{ file: 'a.ts', range: {} }], truncated: false };
    const done = { fileCount: 1, truncated: false, total: 1 };
    const sse = `event: chunk\ndata: ${JSON.stringify(chunk)}\n\nevent: done\ndata: ${JSON.stringify(done)}\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));

    const seen: unknown[] = [];
    const summary = await api.searchStream('p1', 'foo', {}, (matches) => seen.push(matches));
    expect(seen).toEqual([chunk.matches]);
    expect(summary).toEqual(done);
  });

  it('searchStream 收到 error 事件时抛出该消息', async () => {
    const sse = `event: error\ndata: ${JSON.stringify({ message: 'invalid regex' })}\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    await expect(api.searchStream('p1', '(', {}, () => {})).rejects.toThrow('invalid regex');
  });

  it('searchStream 遇到非 2xx / 无 body 时抛错', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));
    await expect(api.searchStream('p1', 'x', {}, () => {})).rejects.toThrow('boom');
  });

  it('subscribeEvents 订阅四类 SSE 事件、解析 JSON、忽略坏事件，取消时关闭连接', () => {
    const handlers = new Map<string, (e: MessageEvent) => void>();
    const close = vi.fn();
    class FakeEventSource {
      constructor(public url: string) {}
      addEventListener(type: string, handler: EventListener) {
        handlers.set(type, handler as unknown as (e: MessageEvent) => void);
      }
      close = close;
    }
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

    const seen: string[] = [];
    const off = subscribeEvents('p1', (e) => seen.push(e.type));
    expect([...handlers.keys()]).toEqual(['status', 'file-changed', 'file-deleted', 'index-ready']);

    handlers.get('status')?.({ data: JSON.stringify({ type: 'status' }) } as MessageEvent);
    expect(seen).toEqual(['status']);
    handlers.get('status')?.({ data: '{not json' } as MessageEvent); // 坏事件被忽略
    expect(seen).toEqual(['status']);

    off();
    expect(close).toHaveBeenCalledOnce();
  });
});
