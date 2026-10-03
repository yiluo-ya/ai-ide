/**
 * Dockerfile 语言模块（行式扫描）：没有可用的 tree-sitter 语法包，
 * 只提「构建阶段名」与「变量」——这两类名字会被后续指令引用。
 */
import type { LanguageSpec, LineSymbol } from '../indexer/walker';

const FROM = /^\s*FROM\s+\S+(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i;
const ARG = /^\s*ARG\s+([A-Za-z_]\w*)/;
const ENV = /^\s*ENV\s+([A-Za-z_]\w*)/;

/** 逐行扫关键字（跳过空行与注释行；跨行的续行不参与匹配）。 */
function scan(source: string): LineSymbol[] {
  const out: LineSymbol[] = [];
  source.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const from = FROM.exec(line);
    if (from?.[1]) {
      out.push({ name: from[1], kind: 'namespace', line: idx + 1, col: line.indexOf(from[1]) + 1 });
      return;
    }
    const arg = ARG.exec(line) ?? ENV.exec(line);
    if (arg?.[1]) {
      out.push({ name: arg[1], kind: 'variable', line: idx + 1, col: line.indexOf(arg[1]) + 1 });
    }
  });
  return out;
}

export const dockerfile: LanguageSpec = {
  id: 'dockerfile',
  label: 'Dockerfile',
  extensions: ['.dockerfile'],
  filenames: ['dockerfile', 'containerfile'],
  lineSymbols: scan,
  scopes: {},
  handlers: {},
  identifierTypes: [],
};
