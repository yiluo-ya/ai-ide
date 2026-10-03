/** 服务入口：加载项目注册表 → 起 Hono HTTP 服务（同时托管前端产物）。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './api/routes';
import { ProjectRegistry } from './registry';
import { DATA_DIR, HOST, PORT, CORS_ORIGINS, SHARE_NOTE_LOCAL, SHARE_NOTE_SHARED, shareHintFor } from './config';
import { installNoWatch, installProjectHint, migrateLegacyDataDir } from './bootstrap';
import { primeUserIgnore } from './indexer/user-ignore';
import { logError, logInfo } from './log';

export interface ServerOptions {
  port: number;
  host: string;
  /** 数据目录（projects.json / runtime.json / 索引快照）；默认 config.DATA_DIR。 */
  dataDir?: string;
}

export interface ServerHandle {
  /** 实际监听端口（`port: 0` 时由 OS 分配）。 */
  port: number;
  host: string;
  registry: ProjectRegistry;
  dataDir: string;
  close(): Promise<void>;
}

/**
 * 起服务（P13/P15）。端口占用会在这里抛错，让调用方（CLI）决定让位策略；
 * 等 `listening` 落定再返回真实端口（`port: 0` 时端口由 OS 选）。
 */
export async function createServer(opts: ServerOptions): Promise<ServerHandle> {
  installProjectHint();
  installNoWatch();
  // 设置里的自定义忽略规则：在建任何项目索引之前装进判定器
  await primeUserIgnore();
  const dataDir = opts.dataDir ?? DATA_DIR;
  // 老版本的 <仓库根>/data 一次性搬到新默认位置（~/.ide）；只复制不删。
  await migrateLegacyDataDir(dataDir);
  const registry = new ProjectRegistry(dataDir);
  await registry.load();

  const app = createApp(registry);
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err: Error) => reject(err));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  // Node 默认 keepAliveTimeout 只有 5s：宿主（Node / undici）复用空闲连接时会撞上服务端
  // 刚发起的关闭，表现为偶发 ECONNRESET。放宽到 65s（本地直连场景，无需迁就反代）。
  const httpServer = server as unknown as import('node:http').Server;
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  logInfo('server.listening', {
    url: `http://${opts.host}:${port}`,
    projects: registry.list().length,
    dataDir,
  });
  logSharing(registry, port);

  return {
    port,
    host: opts.host,
    registry,
    dataDir,
    close: () =>
      new Promise<void>((resolve) => {
        registry.closeAll();
        server.close(() => resolve());
      }),
  };
}

/** 启动日志：同机同目录分享提示与 CORS 口径（S5a）。 */
function logSharing(registry: ProjectRegistry, port: number) {
  const hint = shareHintFor(HOST, port);
  if (hint) {
    const sample = registry.list()[0];
    const url = sample ? hint.url.replace('{projectId}', sample.id) : hint.url;
    logInfo('server.share-hint', { url, note: SHARE_NOTE_SHARED });
  } else {
    logInfo('server.share-note', { note: SHARE_NOTE_LOCAL });
  }
  if (CORS_ORIGINS.includes('*')) {
    logInfo('server.cors', { origins: '*', hint: '共享前可用 READER_CORS_ORIGIN=a.com,b.com 收紧' });
  } else {
    logInfo('server.cors', { origins: CORS_ORIGINS.join(',') });
  }
}

/** 直接 `tsx src/server.ts`（等价 `npm start`）时的入口。 */
async function main(): Promise<void> {
  let handle: ServerHandle;
  try {
    handle = await createServer({ port: PORT, host: HOST });
  } catch (e) {
    logError('server.start.failed', { port: PORT, host: HOST, error: (e as Error).message });
    process.exit(1);
    return;
  }
  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1];
const isMain =
  !!entry && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) await main();
