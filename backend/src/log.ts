/**
 * 结构化日志（06-platform P22）：单行 `key=value`，默认写 stderr。
 *
 * 环境变量：
 *   READER_LOG_LEVEL=error|warn|info|debug   默认 info
 *   READER_LOG_FILE=<绝对路径或相对路径>      同时追加写入该文件（可选）
 *
 * 设计约束：日志本身永不抛错、永不阻塞请求（写文件失败只在 stderr 报一次）。
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel(): LogLevel {
  const raw = (process.env.READER_LOG_LEVEL ?? 'info').toLowerCase();
  return (raw in LEVELS ? raw : 'info') as LogLevel;
}

const minLevel = LEVELS[resolveLevel()];
const logFile = process.env.READER_LOG_FILE ? path.resolve(process.env.READER_LOG_FILE) : null;
let fileBroken = false;

function fmtValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') {
    return /[\s="]/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] > minLevel) return;
  const parts = [new Date().toISOString(), level, msg];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      parts.push(`${k}=${fmtValue(v)}`);
    }
  }
  const line = parts.join(' ');
  process.stderr.write(`${line}\n`);
  if (logFile && !fileBroken) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      fileBroken = true;
      process.stderr.write(`${new Date().toISOString()} warn log-file-write-failed file=${logFile}\n`);
    }
  }
}

export function logError(msg: string, fields?: Record<string, unknown>): void {
  write('error', msg, fields);
}

export function logWarn(msg: string, fields?: Record<string, unknown>): void {
  write('warn', msg, fields);
}

export function logInfo(msg: string, fields?: Record<string, unknown>): void {
  write('info', msg, fields);
}

export function logDebug(msg: string, fields?: Record<string, unknown>): void {
  write('debug', msg, fields);
}

/** 耗时日志：慢于 warnMs（默认 500ms）时按 warn 级别写。 */
export function logTiming(msg: string, ms: number, fields?: Record<string, unknown>, warnMs = 500): void {
  const level: LogLevel = ms >= warnMs ? 'warn' : 'info';
  write(level, msg, { ...fields, ms: Math.round(ms * 10) / 10 });
}
