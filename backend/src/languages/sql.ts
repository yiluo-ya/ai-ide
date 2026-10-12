/**
 * SQL 语言模块（tree-sitter-sql，回退行式扫描）。
 *
 * 定义层级：
 * - 库对象（TABLE / VIEW / FUNCTION / ...）：`create_table` 等声明的对象名；
 * - 列：`column_definition` 的 `name` 字段，挂在所属表的作用域下。
 *
 * 引用层级：
 * - 表引用：FROM / JOIN / INTO / UPDATE 后的 `object_reference`；
 * - 列引用：SELECT / WHERE 里的 `field` 节点（`t.col` 或裸 `col`）。
 *
 * 名字口径（同 PostgreSQL）：未加引号的标识符折叠成小写（`Users` = `users`），
 * 加引号 / 反引号 / 方括号的按字面保留大小写。
 */
import { createRequire } from 'node:module';
import type { LanguageSpec, LineRef, LineSymbol, ModuleHint } from '../indexer/walker';
import type { SymbolKind } from '../types';

// ---------------------------------------------------------- 行式回退（无 grammar 时）

const CREATE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+|GLOBAL\s+|LOCAL\s+|MATERIALIZED\s+|EXTERNAL\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|UNIQUE\s+INDEX|INDEX|SCHEMA|TYPE|SEQUENCE|DATABASE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"`[][\w."`\]$]*)/i;

const REF =
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|REFERENCES|TRUNCATE|SEQUENCE|SCHEMA|DATABASE|INDEX|CALL)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?(?!SELECT\b|VALUES\b|\()([A-Za-z_"`[][\w."`\]$]*)/gi;

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

/** 双引号保留大小写（PostgreSQL 口径）；反引号 / 方括号仅转义，仍折叠小写（Hive / MySQL 方言）。 */
const DOUBLE_QUOTED = /"/;

const cleanName = (raw: string): string => {
  const bare = raw.replace(/["`[\]]/g, '');
  return DOUBLE_QUOTED.test(raw) ? bare : bare.toLowerCase();
};

const codeOf = (line: string): string => {
  const i = line.indexOf('--');
  return i < 0 ? line : line.slice(0, i);
};

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
    if (/\b(?:INDEX|TRIGGER)\b/i.test(code)) collect(ON_OBJECT, code, idx + 1);
  });
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

// ---------------------------------------------------------- tree-sitter 加载（可选）

let sqlGrammar: unknown = null;
try {
  // SQL 语法包是原生扩展，需要编译；装好才有。
  // 用 createRequire 兼容 ESM 环境（tsx / 纯 ESM 下 require 不存在）。
  // 语法包以 ESM default import 形式暴露整个模块对象，
  // setLanguage 需要可扩展的 wrapper 来挂 nodeSubclasses。
  const req = createRequire(import.meta.url);
  sqlGrammar = req('@derekstride/tree-sitter-sql');
} catch {
  // 未装或编译失败：回退行式扫描
}

// ---------------------------------------------------------- 源码预处理

/**
 * 剥离 grammar 无法解析的 Hive/Spark 方言语法，替换为等长空格。
 * 保持行号 / 列号 / 字节偏移完全对齐，让 AST 节点的 range 仍映射到原文位置。
 *
 * 当前处理：
 * - `LATERAL VIEW [OUTER] UDTF(...) alias AS col1, col2`
 *   语法解析器把整段判为 ERROR，且会把 `alias AS col` 误判为独立 relation。
 *   剥离后 FROM 子句干净，不影响后续列引用跳转。
 */
function stripDialectSyntax(source: string): string {
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length) {
    const code = codeOf(lines[i]);
    const lvMatch = code.match(/LATERAL\s+VIEW/i);
    if (!lvMatch) { i++; continue; }
    const lvStart = lvMatch.index;
    if (lvStart === undefined) { i++; continue; }
    // LATERAL VIEW 段落从 lvStart 开始，到包含 AS 的行结束
    const afterLv = code.substring(lvStart);
    let endLine = i;
    if (/\bAS\b/i.test(afterLv)) {
      endLine = i;
    } else {
      for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
        if (/\bAS\b/i.test(codeOf(lines[j])) ) { endLine = j; break; }
      }
    }
    // 起始行：保留 lvStart 之前的内容，之后替换为空格
    lines[i] = lines[i].substring(0, lvStart) + ' '.repeat(lines[i].length - lvStart);
    // 中间行和结尾行：全部替换为空格
    for (let j = i + 1; j <= endLine; j++) {
      lines[j] = ' '.repeat(lines[j].length);
    }
    i = endLine + 1;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------- 从 object_reference 提取全名

/** object_reference → "schema.name" 或 "name"（小写折叠同 cleanName）。 */
function refFullName(node: any): string {
  const nameNode = node.childForFieldName('name');
  const schemaNode = node.childForFieldName('schema');
  const name = cleanName(String(nameNode?.text ?? ''));
  if (!name) return '';
  if (schemaNode) {
    const schema = cleanName(String(schemaNode.text));
    return schema ? `${schema}.${name}` : name;
  }
  return name;
}

/** object_reference 的 name 节点（用于 nameRange）。 */
function refNameNode(node: any): any {
  return node.childForFieldName('name');
}

// ---------------------------------------------------------- LanguageSpec

export const sql: LanguageSpec = {
  id: 'sql',
  label: 'SQL',
  extensions: ['.sql'],
  monaco: 'sql',
  fence: 'sql',
  color: '#e38c00',
  commentPrefixes: ['--'],
  refs: true,

  // 剥离 grammar 无法解析的方言语法（LATERAL VIEW 等），保持行号对齐
  preprocess: stripDialectSyntax,

  // tree-sitter 语法（有则走 walker，无则回退 lineSymbols / lineRefs）
  ...(sqlGrammar ? { grammar: sqlGrammar } : { lineSymbols: scan, lineRefs: scanRefs }),

  scopes: sqlGrammar
    ? {
        // 列定义：name 字段是列名，在父作用域（表）里注册为定义
        column_definition: { kind: 'block', nameFields: ['name'], defKind: 'field', local: false },
      }
    : {},

  handlers: sqlGrammar
    ? {
        // CREATE TABLE：表名定义 + 进入表作用域（让列定义挂在表名下）
        create_table(node: any, ctx: any) {
          const ref = (node.namedChildren as any[]).find((c: any) => c.type === 'object_reference');
          let def: any = null;
          if (ref) {
            const fullName = refFullName(ref);
            const nameNode = refNameNode(ref);
            if (fullName) {
              def = ctx.define(node, { name: fullName, nameNode, kind: 'struct' });
            }
          }
          // 进入表作用域，让列定义挂在表名下（documentSymbols 展开为树）
          const scope = ctx.enterScope(node, { kind: 'class' } as any, def?.name ?? null);
          if (def) def.bodyScopeId = scope.id;
          ctx.walkChildren(node, ref ? [ref] : []);
          ctx.exitScope();
          return true;
        },

        // CREATE VIEW / FUNCTION / PROCEDURE 等其它 CREATE 语句
        create_view(node: any, ctx: any) {
          const ref = (node.namedChildren as any[]).find((c: any) => c.type === 'object_reference');
          if (ref) {
            const fullName = refFullName(ref);
            const nameNode = refNameNode(ref);
            if (fullName) ctx.define(node, { name: fullName, nameNode, kind: 'interface' });
          }
          ctx.walkChildren(node);
          return true;
        },

        create_function(node: any, ctx: any) {
          const ref = (node.namedChildren as any[]).find((c: any) => c.type === 'object_reference');
          if (ref) {
            const fullName = refFullName(ref);
            const nameNode = refNameNode(ref);
            if (fullName) ctx.define(node, { name: fullName, nameNode, kind: 'function' });
          }
          ctx.walkChildren(node);
          return true;
        },

        // CREATE INDEX：索引名在 column 字段
        create_index(node: any, ctx: any) {
          const nameNode = node.childForFieldName?.('column');
          if (nameNode) {
            ctx.define(node, { nameNode, kind: 'property' });
          }
          ctx.walkChildren(node, nameNode ? [nameNode] : []);
          return true;
        },

        // INSERT [OVERWRITE|INTO] [TABLE] schema.name PARTITION (...) SELECT ...
        // 语法解析器把 `TABLE` 关键字误判为 schema identifier，导致表名错误。
        // 这里从源码文本正则提取真正的表名，手动注册引用，再 walk SELECT 等子节点。
        insert(node: any, ctx: any) {
          const text = String(node.text ?? '');
          // 提取 INSERT OVERWRITE/INTO 后的 TABLE schema.name
          const m = text.match(/\bINSERT\s+(?:OVERWRITE\s+|INTO\s+)TABLE\s+([A-Za-z_][\w.]*)/i);
          const skip: any[] = [];
          if (m) {
            const tableName = cleanName(m[1]);
            // 用 object_reference 节点的 range（只覆盖表名部分），但修正名字
            const ref = (node.namedChildren as any[]).find((c: any) => c.type === 'object_reference');
            if (ref) {
              skip.push(ref);
              if (tableName) ctx.addRef(ref, { name: tableName, text: m[1] });
            }
          }
          ctx.walkChildren(node, skip);
          return true;
        },

        // 表引用：FROM / JOIN / INTO / UPDATE 后面的 object_reference
        object_reference(node: any, ctx: any) {
          const fullName = refFullName(node);
          if (fullName) {
            ctx.addRef(node, { name: fullName, text: String(node.text ?? '') });
          }
          ctx.walkChildren(node);
          return true;
        },

        // FROM 子句里的 relation：
        //   `(SELECT ...) alias` → 子查询别名注册为 namespace，但不 enterScope：
        //   列定义直接挂到父作用域（CTE / 文件作用域），这样 `t1.mid` 和 `aa.mid`
        //   都能找到子查询内的列定义。
        //   `cte_name alias`（如 `FROM group_exploded g`）→ 别名指向同名 CTE 的
        //   bodyScopeId，让 `g.col` 能 resolveMember 到 CTE 内的列定义。
        //   `table_name alias`（外部表）→ 无对应 CTE，bodyScopeId 留空，列不可解析。
        relation(node: any, ctx: any) {
          const aliasNode = node.childForFieldName?.('alias') ?? node.namedChildren.find((c: any) => c.type === 'identifier');
          const subqueryNode = node.namedChildren.find((c: any) => c.type === 'subquery');
          const objRefNode = node.namedChildren.find((c: any) => c.type === 'object_reference');

          // 子查询别名 `(SELECT ...) b`：进入 namespace scope，
          // 让子查询内部的列（含无别名透传列）都注册为 field，
          // `b.col` 通过 resolveMember 在 bodyScopeId 里找到。
          if (subqueryNode && aliasNode) {
            const alias = cleanName(String(aliasNode.text));
            let def: any = null;
            if (alias) {
              def = ctx.define(node, { name: alias, nameNode: aliasNode, kind: 'namespace' });
            }
            const scope = ctx.enterScope(subqueryNode, { kind: 'namespace' } as any, alias || null);
            if (def) def.bodyScopeId = scope.id;
            ctx.walkChildren(node, aliasNode ? [aliasNode] : []);
            ctx.exitScope();
            return true;
          }

          // CTE / 表别名 `cte_name alias`
          if (objRefNode && aliasNode) {
            const cteName = cleanName(String(objRefNode.text ?? ''));
            const alias = cleanName(String(aliasNode.text));
            // 在已 walked 的 CTE 定义里找同名 namespace，取它的 bodyScopeId
            let bodyScopeId: string | null = null;
            for (const d of ctx.definitions) {
              if (d.name === cteName && d.kind === 'namespace' && d.bodyScopeId) {
                bodyScopeId = d.bodyScopeId;
                break;
              }
            }
            if (alias && cteName) {
              const def = ctx.define(node, { name: alias, nameNode: aliasNode, kind: 'namespace' });
              if (def) def.bodyScopeId = bodyScopeId;
            }
            ctx.walkChildren(node, aliasNode ? [aliasNode] : []);
            return true;
          }

          ctx.walkChildren(node);
          return true;
        },

        // CTE：`name AS (subquery)` — 注册别名，进入作用域让列别名挂在 CTE 下
        cte(node: any, ctx: any) {
          const nameNode = node.namedChildren.find((c: any) => c.type === 'identifier');
          const cteName = cleanName(String(nameNode?.text ?? ''));
          let def: any = null;
          if (cteName && nameNode) {
            def = ctx.define(node, { name: cteName, nameNode, kind: 'namespace' });
          }
          const scope = ctx.enterScope(node, { kind: 'namespace' } as any, cteName || null);
          if (def) def.bodyScopeId = scope.id;
          ctx.walkChildren(node, nameNode ? [nameNode] : []);
          ctx.exitScope();
          return true;
        },

        // SELECT 子句里的 term：
        //   `expr AS alias` → alias 是列名（定义）
        //   `t.col`（无 alias）→ 列名隐含为 col（SQL 标准：取字段名最后一段）
        //   `col`（裸列名，无 alias）→ 列名就是 col
        term(node: any, ctx: any) {
          const aliasNode = node.childForFieldName?.('alias');
          let nameNode: any = null;
          let colName = '';
          if (aliasNode) {
            colName = cleanName(String(aliasNode.text));
            nameNode = aliasNode;
          } else {
            // 无显式别名：取 field 的 name 段，或裸 identifier
            const fieldNode = node.namedChildren.find((c: any) => c.type === 'field');
            if (fieldNode) {
              const fn = fieldNode.childForFieldName('name');
              if (fn) {
                colName = cleanName(String(fn.text));
                nameNode = fn;
              }
            } else {
              const idNode = node.namedChildren.find((c: any) => c.type === 'identifier');
              if (idNode) {
                colName = cleanName(String(idNode.text));
                nameNode = idNode;
              }
            }
          }
          // 无显式别名时只在 CTE 作用域内注册隐式列名：
          // CREATE VIEW / 顶层 SELECT 的裸列名是引用，不是定义。
          if (colName && nameNode) {
            const inCte = ctx.scope?.kind === 'namespace';
            if (aliasNode || inCte) {
              ctx.define(node, { name: colName, nameNode, kind: 'field', local: false });
            }
          }
          ctx.walkChildren(node, nameNode ? [nameNode] : []);
          return true;
        },

        // 列引用：SELECT / WHERE 里的 field 节点
        // `t_wake.mid` → member 引用 parts=['t_wake','mid']；裸 `mid` → 普通引用
        field(node: any, ctx: any) {
          const nameNode = node.childForFieldName('name');
          const colName = cleanName(String(nameNode?.text ?? ''));
          if (!colName) {
            ctx.walkChildren(node);
            return true;
          }
          // 检查有没有表别名前缀（object_reference 子节点）
          const tableNode = node.namedChildren.find((c: any) => c.type === 'object_reference');
          if (tableNode) {
            const tableName = cleanName(String(tableNode.text));
            if (tableName) {
              ctx.addRef(nameNode ?? node, {
                name: colName,
                parts: [tableName, colName],
                text: String(node.text ?? ''),
              });
            } else {
              ctx.addRef(nameNode ?? node, { name: colName, text: String(nameNode?.text ?? '') });
            }
          } else {
            ctx.addRef(nameNode ?? node, { name: colName, text: String(nameNode?.text ?? '') });
          }
          ctx.walkChildren(node);
          return true;
        },
      }
    : {},

  identifierTypes: [],
  commentTypes: ['comment'],

  /**
   * 跨文件跳转：SQL 没有 import，对象名在库内全局可见 ——
   * 同目录的 `.sql` 优先（迁移脚本常放一起），其余按路径序兜底。
   */
  siblings(fromFile: string, hint: ModuleHint): string[] {
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
