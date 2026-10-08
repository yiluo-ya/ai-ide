/**
 * 交互式终端（2026-10-08）：node-pty 常驻 PTY + WebSocket 双向透传。
 *
 * 与 commands.ts 的「一次性跑命令读输出」不同，这里维护一条**常驻**的伪终端会话：
 * 客户端连上 → 发 {type:'spawn', cols, rows} 起 shell（cwd = 项目根）→ 之后
 * input / resize 双向流式，直到客户端断开或 shell 退出。
 *
 * 安全边界（与 services.ts / commands.ts 同口径）：
 * - 只在**本机模式**下开放：共享模式（HOST 非本机回环地址）整层拒绝；
 * - cwd 一律是**项目根**（由 registry 从项目 id 解析），不接受前端传目录；
 * - 每个项目 id 可起多个会话（多标签 / 分屏），断开即回收。
 */
import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import * as path from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { LOCAL_HOSTS, HOST } from '../config';
import { logInfo, logError } from '../log';
import type { ProjectRegistry } from '../registry';

/** 客户端 → 服务端 的消息。 */
interface ClientMessage {
  type: 'spawn' | 'input' | 'resize' | 'signal';
  /** input：要写入 PTY 的字符；resize：列/行；signal：可选 'SIGINT' 等。 */
  data?: string;
  cols?: number;
  rows?: number;
}

/** 服务端 → 客户端 的消息。 */
type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'title'; title: string }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'error'; message: string };

/** WebSocket 连接的原始字节发送器。 */
interface WsSender {
  send(data: string): void;
  close(): void;
}

/** 一个会话 = 一次 WebSocket 连接 + 其专属 PTY。 */
interface TerminalSession {
  id: string;
  pty: IPty;
  sender: WsSender;
  open: boolean;
}

/** 按 session id 索引（id 从升级 URL 的 ?session= 带过来，客户端自己生成）。 */
const sessions = new Map<string, TerminalSession>();

/** Windows 默认 shell；其它平台用用户 SHELL 或 bash。 */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: [] };
  }
  const shell = process.env.SHELL ?? '/bin/bash';
  return { file: shell, args: ['-l'] };
}

/** 把项目 id 解析成可用的 cwd（项目根）。 */
function cwdFor(registry: ProjectRegistry, projectId: string): string | null {
  const project = registry.get(projectId);
  if (!project) return null;
  return project.root;
}

/**
 * 处理一次 WebSocket 升级（由 server.ts 的 `upgrade` 事件调用）。
 * 校验：共享模式拒绝、项目存在、session id 合法；然后完成握手并把连接交给会话。
 */
export function handleTerminalUpgrade(
  registry: ProjectRegistry,
  req: http.IncomingMessage,
  socket: Duplex,
  _head: Buffer,
): void {
  // 只处理 /api/projects/:id/terminal 路径
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = /^\/api\/projects\/([^/]+)\/terminal$/.exec(url.pathname);
  if (!match) return;
  const projectId = match[1];
  const sessionId = url.searchParams.get('session') || crypto.randomUUID();

  // 共享模式（HOST 非本机回环）整层拒绝
  if (!LOCAL_HOSTS.has(HOST)) {
    rejectUpgrade(socket, 403, '共享模式下不提供交互式终端');
    return;
  }
  const cwd = cwdFor(registry, projectId);
  if (!cwd) {
    rejectUpgrade(socket, 404, '项目不存在或未索引');
    return;
  }

  // 完成 WebSocket 握手（不引额外依赖：手动算 Sec-WebSocket-Accept）
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const sender = createWsSender(socket);
  const session: TerminalSession = {
    id: sessionId,
    pty: null as unknown as IPty,
    sender,
    open: true,
  };
  sessions.set(sessionId, session);
  logInfo('terminal.open', { projectId, sessionId, cwd });

  // 逐帧解析客户端消息，直到断开
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame: { opcode: number; payload: Buffer; consumed: number } | null;
    while ((frame = decodeFrame(buffer)) !== null) {
      buffer = buffer.subarray(frame.consumed ?? buffer.length);
      if (frame.opcode === 0x8) {
        // 关闭帧
        closeSession(sessionId);
        return;
      }
      if (frame.opcode === 0x9) {
        // ping → pong
        sendFrame(socket, 0xa, frame.payload);
        continue;
      }
      if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(frame.payload.toString('utf8')) as ClientMessage;
      } catch {
        continue;
      }
      handleClientMessage(session, msg, cwd, socket);
    }
  };
  socket.on('data', onData);
  socket.on('error', () => closeSession(sessionId));
  socket.on('close', () => closeSession(sessionId));
}

/** 客户端消息：spawn / input / resize / signal。 */
function handleClientMessage(
  session: TerminalSession,
  msg: ClientMessage,
  cwd: string,
  _socket: Duplex,
): void {
  if (!session.open) return;
  if (msg.type === 'spawn') {
    if (session.pty) return; // 已起过
    const { file, args } = defaultShell();
    const cols = Math.max(2, Math.min(500, Math.floor(msg.cols ?? 80)));
    const rows = Math.max(1, Math.min(200, Math.floor(msg.rows ?? 24)));
    try {
      const pty = spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: process.env as Record<string, string>,
      });
      session.pty = pty;
      // 回传 shell 名，前端据此显示「1: cmd」这样的标签标题。
      const shellName = path.basename(file).replace(/\.exe$/i, '');
      session.sender.send(JSON.stringify({ type: 'title', title: shellName } satisfies ServerMessage));
      pty.onData((data) => {
        if (session.open) session.sender.send(JSON.stringify({ type: 'output', data } satisfies ServerMessage));
      });
      pty.onExit(({ exitCode, signal }) => {
        if (session.open) {
          session.sender.send(
            JSON.stringify({
              type: 'exit',
              exitCode,
              signal: signal ?? undefined,
            } satisfies ServerMessage),
          );
          closeSession(session.id);
        }
      });
    } catch (err) {
      logError('terminal.spawn.failed', { error: (err as Error).message });
      session.sender.send(
        JSON.stringify({ type: 'error', message: `无法启动 shell：${(err as Error).message}` } satisfies ServerMessage),
      );
      closeSession(session.id);
    }
    return;
  }
  if (!session.pty) return;
  if (msg.type === 'input') {
    session.pty.write(msg.data ?? '');
  } else if (msg.type === 'resize') {
    const cols = Math.max(2, Math.min(500, Math.floor(msg.cols ?? 80)));
    const rows = Math.max(1, Math.min(200, Math.floor(msg.rows ?? 24)));
    try {
      session.pty.resize(cols, rows);
    } catch {
      /* conpty 偶发 resize 失败，忽略 */
    }
  } else if (msg.type === 'signal') {
    try {
      session.pty.kill(msg.data ?? 'SIGTERM');
    } catch {
      /* 进程可能已退出 */
    }
    // kill 之后 pty 的 onExit 会触发 closeSession
  }
}

/** 关闭并回收会话。 */
function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.open = false;
  try {
    session.sender.close();
  } catch {
    /* 已关闭 */
  }
  if (session.pty) {
    try {
      session.pty.kill();
    } catch {
      /* 进程可能已退出 */
    }
  }
  logInfo('terminal.close', { sessionId });
}

/** 服务关闭时：回收所有会话（server.ts close 时调用）。 */
export function closeAllTerminals(): void {
  for (const id of [...sessions.keys()]) closeSession(id);
}

// ------------------------------------------------------------ WebSocket 帧编解码

/**
 * 解出一帧。返回 null 表示缓冲不完整（等更多字节）。
 * 只处理非分片的小帧（文本 / 二进制 / 关闭 / ping），终端消息都是小 JSON，够用。
 */
function decodeFrame(buf: Buffer): ({ opcode: number; payload: Buffer; consumed: number }) | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  // 分片帧：浏览器 WebSocket 客户端默认不分片（小消息），这里直接丢弃兜底。
  if ((buf[0] & 0x80) === 0) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { opcode, payload: Buffer.alloc(0), consumed: buf.length };
    len = Number(big);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
  offset += maskLen;
  let payload = buf.subarray(offset, offset + len);
  if (maskKey) {
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  }
  return { opcode, payload, consumed: offset + len };
}

/** 发送一帧（服务端 → 客户端的数据帧不 mask）。 */
function sendFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/** 建发送器：文本帧（opcode 1）。 */
function createWsSender(socket: Duplex): WsSender {
  return {
    send(data: string) {
      sendFrame(socket, 0x1, Buffer.from(data, 'utf8'));
    },
    close() {
      sendFrame(socket, 0x8, Buffer.alloc(0));
      socket.end();
    },
  };
}

/** 拒绝 upgrade：直接写 HTTP 错误响应。 */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.write(
    `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
  socket.destroy();
}