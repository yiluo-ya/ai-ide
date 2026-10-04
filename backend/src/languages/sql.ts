/**
 * SQL 语言模块（行式扫描）：没有可用的 tree-sitter 语法包，
 * 只提 `CREATE ...` 声明的库对象名（表 / 视图 / 函数 / 存储过程 / 触发器 / 索引 / 序列 / 模式）。
 * 列、约束、DML 一律不做——它们是内容不是名字。
 */
import type { LanguageSpec, LineSymbol } from '../indexer/walker';
import type { SymbolKind } from '../types';

const CREATE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+|GLOBAL\s+|LOCAL\s+|MATERIALIZED\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|UNIQUE\s+INDEX|INDEX|SCHEMA|TYPE|SEQUENCE|DATABASE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"`[][\w."`\]$]*)/i;

const KINDS: Array<[RegExp, SymbolKind]> = [
  [/^TABLE$/i, 'struct'],
  [/^VIEW$/i, 'interface'],
  [/^FUNCTION$|^PROCEDURE$|^TRIGGER$/i, 'function'],
  [/^UNIQUE\s+INDEX$|^INDEX$/i, 'property'],
  [/^SCHEMA$|^DATABASE$/i, 'namespace'],
  [/^TYPE$/i, 'type'],
  [/^SEQUENCE$/i, 'constant'],
];

const kindOf = (keyword: string): SymbolKind =>
  KINDS.find(([pattern]) => pattern.test(keyword))?.[1] ?? 'unknown';

/** 去掉引号 / 反引号 / 方括号，保留 `schema.table` 的点号限定。 */
const cleanName = (raw: string): string => raw.replace(/["`[\]]/g, '');

/** 逐行扫 `CREATE`（`--` 注释行与空行直接跳过）。 */
function scan(source: string): LineSymbol[] {
  const out: LineSymbol[] = [];
  source.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) return;
    const m = CREATE.exec(line);
    if (!m?.[1] || !m[2]) return;
    const name = cleanName(m[2]);
    if (!name) return;
    out.push({
      name,
      kind: kindOf(m[1].replace(/\s+/g, ' ')),
      line: idx + 1,
      col: line.indexOf(m[2]) + 1,
      endCol: line.indexOf(m[2]) + 1 + name.length,
    });
  });
  return out;
}

export const sql: LanguageSpec = {
  id: 'sql',
  label: 'SQL',
  extensions: ['.sql'],
  monaco: 'sql',
  fence: 'sql',
  color: '#e38c00',
  commentPrefixes: ['--'],
  lineSymbols: scan,
  scopes: {},
  handlers: {},
  identifierTypes: [],
};
