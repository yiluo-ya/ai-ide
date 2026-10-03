/**
 * 内置 agent 的工具包：索引类（复用 /api/agent 已有的工具）+ 文件类（本项目新增的写能力）。
 *
 * 两类的分工其实就是这个项目的价值所在：
 * - **索引类**（find_symbol / goto_definition / find_references / file_outline / search_text）
 *   直接转发给 `api/agent.ts` 的 `callAgentTool` —— 同一套语义，agent 不必靠 grep 猜「定义在哪」；
 * - **文件类**（read_file / write_file / edit_file / list_dir / glob / grep）是这次新加的，
 *   让 agent 能真的改代码、生成代码。
 *
 * 写能力是**显式的新边界**：FR-0004 之前定的「不做编辑、agent 工具只读」在 2026-10-03 被用户
 * 改为「要能直接改代码、生成代码」。安全上只做一件事：所有路径必须落在当前项目根内，
 * 越界一律拒绝（不写仓库外的任何文件）。没有沙箱、没有权限询问 —— 与 pi 一致，以启动它的用户身份运行。
 */
import fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { callAgentTool } from '../api/agent';
import type { AgentHost, ToolDefinition, ToolResult } from './types';

/** 单次读文件的默认 / 最大行数。 */
const READ_DEFAULT_LINES = 400;
const READ_MAX_LINES = 2000;
/** 工具输出进模型上下文前的截断长度。 */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 60;
const MAX_FILE_BYTES = 1_000_000;
/** 绝对不遍历的目录（噪声且昂贵；与索引器的硬保护一致）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'target', '__pycache__', '.venv', 'venv']);

/** 从 /api/agent 复用过来的索引类工具（不含 read_file：文件类里有一个更实时的）。 */
export const INDEX_TOOL_NAMES = [
  'find_symbol',
  'goto_definition',
  'find_references',
  'file_outline',
  'search_text',
] as const;

export const FILE_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: `读项目内某个文件（带行号）。大文件用 offset/limit 分段读；单次最多 ${READ_MAX_LINES} 行。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径，如 src/App.tsx' },
        offset: { type: 'number', description: '起始行（1-based，缺省 1）' },
        limit: { type: 'number', description: `最多读多少行（缺省 ${READ_DEFAULT_LINES}）` },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '写文件：新建或整文件覆盖（父目录会自动创建）。改已有文件请优先用 edit_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      '按精确片段替换改文件：old_string 必须在文件里唯一出现（除非 replace_all=true）。old_string 必须逐字照抄，含缩进。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: '要被替换的原文（逐字）' },
        new_string: { type: 'string', description: '替换成什么' },
        replace_all: { type: 'boolean', description: '替换全部出现（缺省 false）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: '列一层目录（目录在前），非递归。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录相对路径，缺省项目根' } },
    },
  },
  {
    name: 'glob',
    description: '按 glob 找文件，如 src/**/*.ts。忽略 node_modules / .git / 构建产物。',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: '相对项目根的 glob' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: '按正则搜文件内容，返回 path:line:text。找文本用这个；找「符号定义 / 谁在调用」用索引类工具。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则（JS 语法）' },
        glob: { type: 'string', description: '只搜匹配这个 glob 的文件，如 src/**/*.ts' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'number', description: `缺省 ${MAX_GREP_RESULTS}` },
      },
      required: ['pattern'],
    },
  },
];

/** 全部可用工具名（清单 / 报错共用）。 */
export function agentFileToolNames(): string[] {
  return FILE_TOOLS.map((tool) => tool.name);
}

/**
 * 执行一次工具调用。永不抛错：失败以 `isError` 结果返回，让模型自己看到并纠正。
 */
export async function runAgentTool(
  name: string,
  args: Record<string, unknown>,
  host: AgentHost,
): Promise<ToolResult> {
  try {
    if ((INDEX_TOOL_NAMES as readonly string[]).includes(name)) {
      const result = await callAgentTool(host.registry, host.projectId, name, args);
      const body = JSON.stringify(result.body);
      return { content: truncate(body), ...(result.status === 200 ? {} : { isError: true }) };
    }
    switch (name) {
      case 'read_file':
        return await readFileTool(args, host);
      case 'write_file':
        return await writeFileTool(args, host);
      case 'edit_file':
        return await editFileTool(args, host);
      case 'list_dir':
        return await listDirTool(args, host);
      case 'glob':
        return await globTool(args, host);
      case 'grep':
        return await grepTool(args, host);
      default:
        return {
          content: `未知工具：${name}；可用：${[...INDEX_TOOL_NAMES, ...agentFileToolNames()].join(', ')}`,
          isError: true,
        };
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

// ------------------------------------------------------------------ 文件类

/** 相对路径 → 绝对路径；越界（含 `..` / 绝对路径）直接拒绝。 */
function safeAbs(host: AgentHost, rel: string | undefined, fallback = '.'): { abs: string; rel: string } {
  const raw = (rel ?? fallback).trim() || fallback;
  if (!host.project.resolveInside(raw)) {
    throw new Error(`路径越界（必须在当前项目内）：${raw}`);
  }
  const normalized = raw.split('\\').join('/').replace(/^\.\//, '');
  return { abs: host.project.abs(normalized), rel: normalized === '.' ? '.' : normalized };
}

async function readFileTool(args: Record<string, unknown>, host: AgentHost): Promise<ToolResult> {
  const { abs, rel } = safeAbs(host, strArg(args, 'path'));
  const text = await fsp.readFile(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, Math.trunc(numArg(args, 'offset') ?? 1));
  const limit = Math.min(READ_MAX_LINES, Math.max(1, Math.trunc(numArg(args, 'limit') ?? READ_DEFAULT_LINES)));
  const end = Math.min(total, start + limit - 1);
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}\t${line}`)
    .join('\n');
  const head = `# ${rel}（共 ${total} 行，显示 ${start}-${end}）\n`;
  return { content: truncate(head + body) };
}

async function writeFileTool(args: Record<string, unknown>, host: AgentHost): Promise<ToolResult> {
  const { abs, rel } = safeAbs(host, strArg(args, 'path'));
  const content = typeof args.content === 'string' ? args.content : '';
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return { content: `已写入 ${rel}（${content.length} 字符）`, changed: [rel] };
}

async function editFileTool(args: Record<string, unknown>, host: AgentHost): Promise<ToolResult> {
  const { abs, rel } = safeAbs(host, strArg(args, 'path'));
  const oldString = strArg(args, 'old_string');
  const newString = typeof args.new_string === 'string' ? args.new_string : '';
  const replaceAll = args.replace_all === true;
  const text = await fsp.readFile(abs, 'utf8');
  const count = text.split(oldString).length - 1;
  if (count === 0) throw new Error(`没有找到要替换的片段（${rel}）：old_string 必须逐字照抄，含缩进`);
  if (count > 1 && !replaceAll) throw new Error(`片段在 ${rel} 里出现 ${count} 次，不唯一：补上上下文，或设 replace_all=true`);
  const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
  await fsp.writeFile(abs, next, 'utf8');
  return { content: `已修改 ${rel}（替换 ${replaceAll ? count : 1} 处）`, changed: [rel] };
}

async function listDirTool(args: Record<string, unknown>, host: AgentHost): Promise<ToolResult> {
  const { abs, rel } = safeAbs(host, strArg(args, 'path'), '.');
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  return { content: truncate([`# ${rel}`, ...dirs.sort(), ...files.sort()].join('\n') || '（空目录）') };
}

async function globTool(args: Record<string, unknown>, host: AgentHost): Promise<ToolResult> {
  const pattern = strArg(args, 'pattern');
  const matcher = globToRegExp(pattern);
  const hits: string[] = [];
  await walk(host.project.root, async (abs) => {
    const rel = toRel(host, abs);
    if (matcher.test(rel)) hits.push(rel);
    return hits.length < MAX_GLOB_RESULTS;
  });
  if (hits.length === 0) return { content: `没有匹配 ${pattern} 的文件` };
  const suffix = hits.length >= MAX_GLOB_RESULTS ? `\n…（只显示前 ${MAX_GLOB_RESULTS} 条）` : '';
  return { content: truncate(`${hits.sort().join('\n')}${suffix}`) };
}

async function grepTool(args: Record<string, unknown>, host: AgentHost): Promise<ToolResult> {
  const source = strArg(args, 'pattern');
  const matcher = new RegExp(source, args.ignore_case === true ? 'i' : '');
  const limit = Math.min(500, Math.max(1, Math.trunc(numArg(args, 'max_results') ?? MAX_GREP_RESULTS)));
  const fileMatcher = typeof args.glob === 'string' && args.glob.trim() ? globToRegExp(args.glob.trim()) : null;
  const hits: string[] = [];
  await walk(host.project.root, async (abs) => {
    const rel = toRel(host, abs);
    if (fileMatcher && !fileMatcher.test(rel)) return true;
    if (!(await looksLikeText(abs))) return true;
    let text: string;
    try {
      text = await fsp.readFile(abs, 'utf8');
    } catch {
      return true;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!matcher.test(lines[i])) continue;
      hits.push(`${rel}:${i + 1}:${truncate(lines[i].trim(), 300)}`);
      if (hits.length >= limit) return false;
    }
    return true;
  });
  if (hits.length === 0) return { content: `没有匹配 /${source}/ 的内容` };
  return { content: truncate(hits.join('\n')) };
}

// ------------------------------------------------------------------ 通用

function toRel(host: AgentHost, abs: string): string {
  const rel = path.relative(host.project.root, abs);
  return rel.split(path.sep).join('/');
}

/** 递归遍历（广度优先），回调返回 false 表示提前停止。 */
async function walk(root: string, onFile: (abs: string) => Promise<boolean>): Promise<void> {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!(await onFile(abs))) return;
    }
  }
}

/** 二进制 / 超大文件不进 grep。 */
async function looksLikeText(abs: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(abs);
    if (stat.size > MAX_FILE_BYTES) return false;
    const head = await fsp.readFile(abs);
    return !head.subarray(0, 4096).includes(0);
  } catch {
    return false;
  }
}

/** glob → RegExp：`**` 跨目录，`*` / `?` 不跨。 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split('\\').join('/');
  let out = '^';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          out += '(?:.*/)?'; // `**/` 可以匹配零层目录
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（输出已截断，共 ${text.length} 字符）`;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`参数 ${key} 缺失或不是非空字符串`);
}

function numArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
