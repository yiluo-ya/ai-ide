/**
 * ini / cfg / conf / env 语言模块（行式扫描）：没有可用的 tree-sitter 语法包。
 * 提两类名字：`[section]` 段名，以及 `key = value` 的键（全大写的当作常量，如 `PORT=8080`）。
 */
import type { LanguageSpec, LineSymbol } from '../indexer/walker';

const SECTION = /^\s*\[([^\]\r\n]+)\]/;
const KEY = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]/;
const ALL_CAPS = /^[A-Z][A-Z0-9_]*$/;

/** 逐行扫段与键（`#` / `;` 开头的行是注释）。 */
function scan(source: string): LineSymbol[] {
  const out: LineSymbol[] = [];
  source.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return;
    const section = SECTION.exec(line);
    if (section?.[1]) {
      const name = section[1].trim();
      out.push({ name, kind: 'namespace', line: idx + 1, col: line.indexOf(name) + 1 });
      return;
    }
    const key = KEY.exec(line);
    if (key?.[1]) {
      const name = key[1];
      out.push({
        name,
        kind: ALL_CAPS.test(name) ? 'constant' : 'field',
        line: idx + 1,
        col: line.indexOf(name) + 1,
      });
    }
  });
  return out;
}

export const ini: LanguageSpec = {
  id: 'ini',
  label: 'INI / ENV',
  extensions: ['.ini', '.cfg', '.conf', '.properties'],
  filenames: ['.env'],
  lineSymbols: scan,
  scopes: {},
  handlers: {},
  identifierTypes: [],
};
