/**
 * pi 适配器（2026-10-03 用户要求）：把本机 pi CLI 当后端跑起来。
 *
 * 协议：`pi --mode rpc --no-session` 的 JSONL —— stdin 收命令、stdout 出行响应与
 * 会话事件（见 pi 的 docs/rpc.md）。事件名本来就与前端在用的那一套一致
 * （agent_start / message_start|update|end / tool_execution_* / agent_settled），
 * 所以事件原样转发，前端渲染逻辑一行不用改。
 *
 * 与内置 agent 的分工：
 * - 工具集、系统提示、上下文压缩都由 pi 自己负责（它是完整的 coding agent）；
 * - 模型凭证来自 pi 自己的配置（`~/.pi/agent/auth.json`），**不使用**本项目的「模型」配置；
 * - 历史由 pi 进程持有，`--no-session` 表示不落盘，进程退出即清。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  type AdapterExit,
  type AdapterOptions,
  type AgentAdapter,
  type AgentMessage,
  type BackendKind,
  type ModelRef,
  type NormalizedEvent,
  type SessionState,
} from './types';

const MAX_STDERR_LINES = 40;
/** 命令响应超时（prompt 的响应只表示「已受理」，很快）。 */
const COMMAND_TIMEOUT_MS = Number(process.env.READER_PI_TIMEOUT_MS ?? 30_000);
/** 关闭时等 pi 自己退出的宽限，超时再 kill。 */
const SHUTDOWN_GRACE_MS = 2_000;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiAgent extends EventEmitter implements AgentAdapter {
  readonly kind: BackendKind = 'pi';
  readonly cwd: string;

  private readonly options: AdapterOptions;
  private readonly stderrLines: string[] = [];
  private readonly pending = new Map<string, Pending>();
  private child: ChildProcess | null = null;
  private stdoutBuf = '';
  private seq = 0;
  private disposed = false;
  private state: SessionState = {};

  constructor(options: AdapterOptions) {
    super();
    this.options = options;
    this.cwd = options.host.project.root;
  }

  get stderrTail(): string[] {
    return [...this.stderrLines];
  }

  async start(): Promise<SessionState> {
    await this.spawn();
    const data = await this.command('get_state');
    this.state = mapState(data);
    if (this.options.name) {
      // 会话名只是显示用，失败不影响可用性
      await this.command('set_session_name', { name: this.options.name }).catch(() => {});
    }
    return this.state;
  }

  async prompt(message: string): Promise<void> {
    // 不等整轮跑完：进度走事件流（与内置 agent 同一套语义）
    await this.command('prompt', { message });
  }

  async abort(): Promise<void> {
    await this.command('abort');
  }

  async getMessages(): Promise<AgentMessage[]> {
    const data = asRecord(await this.command('get_messages'));
    const messages = data?.messages;
    return Array.isArray(messages) ? (messages as AgentMessage[]) : [];
  }

  async getState(): Promise<SessionState> {
    this.state = mapState(await this.command('get_state'));
    return this.state;
  }

  async setModel(ref: ModelRef): Promise<{ id?: string; name?: string; provider?: string } | null> {
    const data = asRecord(await this.command('set_model', { provider: ref.provider, modelId: ref.modelId }));
    const model = asRecord(data?.model ?? data);
    if (!model) return null;
    return { id: str(model.id), name: str(model.name), provider: str(model.provider) };
  }

  async rename(name: string): Promise<void> {
    await this.command('set_session_name', { name });
    this.state = { ...this.state, sessionName: name };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failPending('pi 会话已释放');
    const child = this.child;
    this.child = null;
    if (!child) return;
    // 关 stdin 请求 pi 有序退出（它会先释放自己的运行时），超时再 kill
    try {
      child.stdin?.end();
    } catch {
      /* 已经关了 */
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    }, SHUTDOWN_GRACE_MS);
    killTimer.unref?.();
    child.once('exit', () => clearTimeout(killTimer));
  }

  // ------------------------------------------------------------------ 内部

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['--mode', 'rpc', '--no-session'];
      let child: ChildProcess;
      try {
        // Windows 上 npm 全局装的是 `pi.cmd`（shim），交给 cmd.exe 解析；
        // 命令与参数都是固定字面量，不经用户输入拼接。
        child =
          process.platform === 'win32'
            ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `pi ${args.join(' ')}`], {
                cwd: this.cwd,
                windowsHide: true,
              })
            : spawn(process.env.READER_PI_COMMAND ?? 'pi', args, { cwd: this.cwd });
      } catch (error) {
        reject(new Error(`启动 pi 失败：${message(error)}`));
        return;
      }
      this.child = child;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => this.note(chunk));
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        this.failPending(message(error));
        reject(new Error(`启动 pi 失败：${message(error)}`));
      });
      child.once('exit', (code, signal) => {
        const detail = this.stderrLines.slice(-3).join(' | ');
        this.failPending(detail || `pi 进程已退出（code=${code ?? 'null'}）`);
        const info: AdapterExit = {
          code,
          signal,
          ...(detail ? { message: detail } : {}),
        };
        this.emit('exit', info);
      });
    });
  }

  /** stdout 是严格 JSONL：按 LF 切，容忍 CRLF；U+2028/U+2029 不能当边界。 */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (;;) {
      const index = this.stdoutBuf.indexOf('\n');
      if (index < 0) return;
      const line = this.stdoutBuf.slice(0, index).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(index + 1);
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.note(`无法解析的 pi 输出：${line.slice(0, 200)}`);
        continue;
      }
      this.onRecord(record);
    }
  }

  private onRecord(record: Record<string, unknown>): void {
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : '';
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      if (record.success === false) waiter.reject(new Error(str(record.error) ?? `pi 命令失败：${id}`));
      else waiter.resolve(record.data);
      return;
    }
    // 其余都是会话事件：原样转发（类型与前端约定一致）
    this.emit('event', record as NormalizedEvent);
  }

  private command(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || this.disposed) return Promise.reject(new Error('pi 进程不在运行'));
    const id = `wcr-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi 命令超时：${type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin?.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    });
  }

  private failPending(reason: string): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private note(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) this.stderrLines.push(trimmed);
    }
    if (this.stderrLines.length > MAX_STDERR_LINES * 2)
      this.stderrLines.splice(0, this.stderrLines.length - MAX_STDERR_LINES);
  }
}

/** pi 的 get_state → 适配层的 SessionState。 */
function mapState(data: unknown): SessionState {
  const d = asRecord(data);
  const model = asRecord(d?.model);
  return {
    model: model
      ? {
          id: str(model.id),
          name: str(model.name) ?? str(model.id),
          provider: str(model.provider),
          api: str(model.api),
        }
      : null,
    sessionId: str(d?.sessionId),
    sessionName: str(d?.sessionName),
    messageCount: typeof d?.messageCount === 'number' ? d.messageCount : undefined,
    isStreaming: d?.isStreaming === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
