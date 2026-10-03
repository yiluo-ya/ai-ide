/**
 * 后台命令 worker（FR-0005）：命令面板「后台运行」真正干活的独立进程。
 *
 * 为什么是独立进程：IDE 后端重启不该把用户起的服务一起带走。
 * 为什么由它来写日志：Windows 上 detached 的 cmd 做 `>> file` 重定向会**丢输出**（实测 0 字节），
 * stdio 直接给文件句柄时 cmd 又会全缓冲（长驻进程的日志一直是空的）；只有「进程自己 open 文件写」
 * 才可靠 —— 所以 worker 用 pipe 收 shell 的子进程输出，再自己写盘（实测 1 秒内可见）。
 *
 * 用法：`node run-with-log.mjs '<json>'`，json = `{ command, cwd, logPath }`。
 * 启动后在 stdout 打一行 `{"childPid":n}`（后端据此记 pid），随后一直转发输出到日志；
 * 子进程退出后写 `<logPath>.exit.json`（`{exitCode,signal,endedAt}`），后端据此判定成功 / 失败。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(process.argv[2] ?? '{}');
const { command, cwd, logPath } = spec;

if (!command || !cwd || !logPath) {
  process.stderr.write('run-with-log: 参数不完整（需要 command / cwd / logPath）\n');
  process.exit(2);
}

const win = process.platform === 'win32';
const shell = win ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
const args = win ? ['/d', '/s', '/c', command] : ['-c', command];

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const fd = fs.openSync(logPath, 'a');

const child = spawn(shell, args, {
  cwd,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  // 命令串原样交给 shell（里面可能有引号），不要再让 Node 转义一层
  ...(win ? { windowsVerbatimArguments: true } : {}),
});

child.stdout?.on('data', (chunk) => fs.writeSync(fd, chunk));
child.stderr?.on('data', (chunk) => fs.writeSync(fd, chunk));

process.stdout.write(`${JSON.stringify({ childPid: child.pid ?? null })}\n`);

function finish(code, signal) {
  try {
    fs.writeSync(fd, `\n[已退出 code=${code ?? '-'} signal=${signal ?? '-'}]\n`);
    fs.closeSync(fd);
  } catch {
    /* 已经关了 */
  }
  try {
    fs.writeFileSync(`${logPath}.exit.json`, JSON.stringify({ exitCode: code, signal, endedAt: Date.now() }));
  } catch {
    /* 写不了就算了 */
  }
  process.exit(0);
}

child.on('exit', (code, signal) => finish(code, signal));
child.on('error', (error) => {
  try {
    fs.writeSync(fd, `\n[起不来：${error.message}]\n`);
  } catch {
    /* ignore */
  }
  finish(null, null);
});
