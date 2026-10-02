#!/usr/bin/env node
/**
 * `wcr` 的 npx / bin 入口（06-platform P14）。
 *
 * 一条命令起服务：把参数原样交给 `backend/src/cli.ts`，用 `--import tsx` 直接跑 TypeScript
 * （不引入构建产物，与 `npm start` 同一份代码）。
 *
 * 路径一律基于本文件定位（`import.meta.url`），所以「从 npm 包解包后在任何 cwd 运行」都成立。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cli = path.join(root, 'backend', 'src', 'cli.ts');

const require = createRequire(import.meta.url);

/**
 * tsx 的解析：包内 node_modules 优先，其次 `backend/node_modules`（在源码仓库里直接跑本文件时），
 * 最后看当前工作目录。`--import` 需要一个绝对路径，所以这里解析到具体文件。
 */
function resolveTsx() {
  const paths = [root, path.join(root, 'backend'), process.cwd()];
  try {
    return require.resolve('tsx', { paths });
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const hasFlag = (...names) => args.some((a) => names.includes(a));

if (hasFlag('--version', '-v')) {
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? version;
  } catch {
    /* 读不到就给 0.0.0 */
  }
  process.stdout.write(`web-code-reader ${version}\n`);
  process.exit(0);
}

const tsx = resolveTsx();
if (!tsx) {
  process.stderr.write(
    'web-code-reader: 找不到 tsx 运行器。请在包目录执行 `npm install`（或全局安装 tsx）后重试。\n',
  );
  process.exit(1);
}

// Windows 上 `--import` 只接受 file:// URL，不能直接给 `D:\\...`。
const child = spawn(process.execPath, ['--import', pathToFileURL(tsx).href, cli, ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

child.on('error', (err) => {
  process.stderr.write(`web-code-reader: 启动失败：${err.message}\n`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
