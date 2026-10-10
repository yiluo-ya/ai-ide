/**
 * SQL 语言模块（行式扫描）：没有可用的 tree-sitter 语法包。
 * - 定义：`CREATE ...` 声明的库对象名（表 / 视图 / 函数 / 存储过程 / 触发器 / 索引 / 序列 / 模式 / 类型）；
 * - 引用（`lineRefs`）：FROM / JOIN / INTO / UPDATE / TABLE … 后面出现的对象名 ——
 *   有引用才有跳定义 / 查引用（F12 / Shift+F12）。
 * 列、约束、DML 里的列名一律不做——它们是内容不是名字。
 *
 * 名字口径（同 PostgreSQL）：未加引号的标识符折叠成小写（`Users` = `users`），
 * 加引号 / 反引号 / 方括号的按字面保留大小写。
 */
import type { LanguageSpec, LineRef, LineSymbol } from '../indexer/walker';
import type { SymbolKind } from '../types';

const CREATE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+|GLOBAL\s+|LOCAL\s+|MATERIALIZED\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|UNIQUE\s+INDEX|INDEX|SCHEMA|TYPE|SEQUENCE|DATABASE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"`[][\w."`\]$]*)/i;

/**
 * 引用：这些关键字后面紧跟的就是被引用的库对象。
 * `ONLY` 是 PostgreSQL 的限定词（`FROM ONLY t`）；`SELECT / VALUES / (` 开头的不是对象名（子查询 / 值表）。
 */
const REF =
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|REFERENCES|TRUNCATE|SEQUENCE|SCHEMA|DATABASE|INDEX|CALL)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?(?!SELECT\b|VALUES\b|\()([A-Za-z_"`[][\w."`\]$]*)/gi;

/** `CREATE [UNIQUE] INDEX / TRIGGER ... ON <table>` 的作用对象（ON 在 JOIN 里是条件，故只在带 INDEX / TRIGGER 的行上启用）。 */
const ON_OBJECT = /\bON\s+(?!\()([A-Za-z_"`[][\w."`\]$]*)/gi;

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

const QUOTED = /["`\[]/;

/**
 * 去掉引号 / 反引号 / 方括号；未加引号的名字按 SQL 语义折叠成小写，保留 `schema.table` 的点号限定。
 */
const cleanName = (raw: string): string => {
  const bare = raw.replace(/["`[\]]/g, '');
  return QUOTED.test(raw) ? bare : bare.toLowerCase();
};

/** 行内注释（`--`）之后的正文不参与扫描；列号不受影响。 */
const codeOf = (line: string): string => {
  const i = line.indexOf('--');
  return i < 0 ? line : line.slice(0, i);
};

/** 逐行扫 `CREATE`（`--` 注释行与空行直接跳过）。 */
function scan(source: string): LineSymbol[] {
  const out: LineSymbol[] = [];
  source.split(/\r?\n/).forEach((line, idx) => {
    const code = codeOf(line);
    if (!code.trim()) return;
    const m = CREATE.exec(code);
    if (!m?.[1] || !m[2]) return;
    const name = cleanName(m[2]);
    if (!name) return;
    const start = code.indexOf(m[2]);
    out.push({
      name,
      kind: kindOf(m[1].replace(/\s+/g, ' ')),
      line: idx + 1,
      col: start + 1,
      endCol: start + 1 + name.length,
    });
  });
  return out;
}

/** 逐行扫引用（对象名出现的位置）；同一行可有多处。 */
function scanRefs(source: string): LineRef[] {
  const out: LineRef[] = [];
  const collect = (re: RegExp, code: string, line: number) => {
    for (const m of code.matchAll(new RegExp(re.source, 'gi'))) {
      const raw = m[1];
      const name = cleanName(raw);
      if (!name) continue;
      const at = (m.index ?? 0) + m[0].lastIndexOf(raw);
      out.push({ name, line, col: at + 1, endCol: at + 1 + raw.length, text: raw });
    }
  };
  source.split(/\r?\n/).forEach((line, idx) => {
    const code = codeOf(line);
    if (!code.trim()) return;
    collect(REF, code, idx + 1);
    // `ON <table>` 只在带 INDEX / TRIGGER 的行上算引用（JOIN ... ON 的条件不算）
    if (/\b(?:INDEX|TRIGGER)\b/i.test(code)) collect(ON_OBJECT, code, idx + 1);
  });
  out.sort((a, b) => a.line - b.line || a.col - b.col);
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
  lineRefs: scanRefs,
  scopes: {},
  handlers: {},
  identifierTypes: [],
  refs: true,

  /**
   * 跨文件跳转：SQL 没有 import，对象名在库内全局可见 ——
   * 同目录的 `.sql` 优先（迁移脚本常放一起），其余按路径序兜底。
   */
  siblings(fromFile, hint) {
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    const same: string[] = [];
    const other: string[] = [];
    for (const f of hint.files()) {
      if (f === fromFile || !f.toLowerCase().endsWith('.sql')) continue;
      const fdir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      (fdir === dir ? same : other).push(f);
    }
    same.sort();
    other.sort();
    return [...same, ...other];
  },
};
