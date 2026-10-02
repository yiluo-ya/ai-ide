/** Go 语言模块：定义 / 引用提取 + 包解析（依赖 go.mod 的 module path）。 */
import Go from 'tree-sitter-go';
import type { BaseInfo, LanguageSpec, ModuleCandidate, ModuleHint, WalkContext } from '../indexer/walker';
import { basename, joinRel } from '../indexer/paths';
import { readHintFile } from '../config';
import type { SymbolKind } from '../types';

const GO_BUILTINS = new Set([
  'nil', 'true', 'false', 'iota', 'make', 'new', 'len', 'cap', 'append', 'copy', 'delete',
  'panic', 'recover', 'print', 'println', 'close', 'complex', 'real', 'imag', 'min', 'max', 'clear',
  'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128', 'string', 'bool', 'byte', 'rune', 'error', 'any',
]);

function defineIdentifiers(node: any, ctx: WalkContext, kind: SymbolKind) {
  for (const c of node.namedChildren as any[]) {
    if (c.type === 'identifier') ctx.define(c, { nameNode: c, kind });
    else if (c.type === 'expression_list') defineIdentifiers(c, ctx, kind);
  }
}

/** 参数声明：`a, b int` 里前导 identifier 是形参，其余（类型）按引用走。 */
function defineParameters(node: any, ctx: WalkContext) {
  for (const child of node.namedChildren as any[]) {
    switch (child.type) {
      case 'parameter_declaration':
      case 'variadic_parameter_declaration':
        for (const c of child.namedChildren as any[]) {
          if (c.type === 'identifier') ctx.define(c, { nameNode: c, kind: 'parameter' });
          else ctx.walk(c);
        }
        break;
      case 'identifier':
        ctx.define(child, { nameNode: child, kind: 'parameter' });
        break;
      default:
        ctx.walk(child);
    }
  }
}

/** `pkg.Func` → ['pkg','Func']。 */
function memberParts(node: any): string[] | null {
  if (node.type !== 'selector_expression') return null;
  const operand = node.childForFieldName('operand');
  const field = node.childForFieldName('field');
  if (!operand || !field) return null;
  if (operand.type === 'identifier') return [operand.text, field.text];
  if (operand.type === 'selector_expression') {
    const base = memberParts(operand);
    return base ? [...base, field.text] : null;
  }
  return null;
}

/**
 * 结构体嵌入字段（N17）：`type A struct { B; *C }` 里的 B / C。
 * 只读语法：接口嵌入只看 struct 字段；泛型实例化、运行时组合不覆盖。
 */
function goBases(node: any): BaseInfo[] | null {
  if (node.type !== 'type_spec') return null;
  const typeNode = node.childForFieldName('type');
  if (typeNode?.type !== 'struct_type') return null;
  const out: BaseInfo[] = [];
  const stack = [typeNode];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of (cur.namedChildren ?? []) as any[]) {
      if (c.type === 'field_declaration_list') {
        stack.push(c);
        continue;
      }
      if (c.type !== 'field_declaration') continue;
      const kids = (c.namedChildren ?? []) as any[];
      if (kids.some((k) => k.type === 'field_identifier')) continue; // 具名字段不是嵌入
      const t = c.childForFieldName('type') ?? kids[0];
      if (!t) continue;
      const name = t.type === 'pointer_type' ? ((t.namedChildren as any[])[0]?.text ?? '') : t.text;
      if (name) out.push({ name, kind: 'embeds' });
    }
  }
  return out.length ? out : null;
}

export const go: LanguageSpec = {
  id: 'go',
  label: 'Go',
  extensions: ['.go'],
  grammar: Go,

  scopes: {
    function_declaration: {
      kind: 'function', nameFields: ['name'], defKind: 'function', paramFields: ['parameters'],
    },
    method_declaration: {
      kind: 'function', nameFields: ['name'], defKind: 'method',
      paramFields: ['receiver', 'parameters'],
    },
    func_literal: { kind: 'function', fixedName: 'func', paramFields: ['parameters'] },
    block: { kind: 'block' },
  },

  handlers: {
    package_clause(node, ctx) {
      const id = (node.namedChildren as any[]).find((c: any) => c.type === 'package_identifier');
      if (id) ctx.meta.packageName = id.text;
      return true;
    },

    import_spec(node, ctx) {
      const path = node.childForFieldName('path');
      if (!path) return true;
      const specifier = path.text.replace(/^["`]|["`]$/g, '');
      const alias = node.childForFieldName('name');
      const aliasText = alias ? alias.text : null;
      if (aliasText === '_') return true;
      if (aliasText === '.') {
        ctx.addImport({
          localName: '*', module: specifier, kind: 'star', range: ctx.rangeOf(node),
        });
        return true;
      }
      const last = specifier.split('/').pop() ?? specifier;
      const localName = aliasText ?? last;
      ctx.addImport({
        localName,
        module: specifier,
        kind: 'module',
        range: alias ? ctx.rangeOf(alias) : ctx.rangeOf(path),
      });
      if (alias) ctx.addRef(alias, { kind: 'import', name: localName });
      return true;
    },

    var_spec(node, ctx) {
      defineLeadingNames(node, ctx, 'variable');
      return true;
    },

    const_spec(node, ctx) {
      defineLeadingNames(node, ctx, 'constant');
      return true;
    },

    short_var_declaration(node, ctx) {
      const left = node.childForFieldName('left');
      if (left) defineIdentifiers(left, ctx, 'variable');
      const right = node.childForFieldName('right');
      if (right) ctx.walk(right);
      return true;
    },

    range_clause(node, ctx) {
      if (node.text.includes(':=')) {
        const left = node.childForFieldName('left');
        if (left) defineIdentifiers(left, ctx, 'variable');
      } else {
        const left = node.childForFieldName('left');
        if (left) ctx.walk(left);
      }
      const right = node.childForFieldName('right');
      if (right) ctx.walk(right);
      return true;
    },

    type_spec(node, ctx) {
      const name = node.childForFieldName('name');
      const typeNode = node.childForFieldName('type');
      const kind: SymbolKind =
        typeNode?.type === 'struct_type'
          ? 'struct'
          : typeNode?.type === 'interface_type'
            ? 'interface'
            : 'type';
      const def = name ? ctx.define(node, { nameNode: name, kind }) : null;
      if (typeNode) {
        const scope = ctx.enterScope(
          typeNode,
          { kind: 'block', fixedName: name?.text ?? undefined },
          name?.text ?? null,
        );
        if (def) def.bodyScopeId = scope.id;
        if (typeNode.type === 'struct_type') {
          const fields = (typeNode.namedChildren as any[]).find(
            (c: any) => c.type === 'field_declaration_list',
          );
          if (fields) ctx.walk(fields);
          for (const c of typeNode.namedChildren as any[]) {
            if (c.type !== 'field_declaration_list') ctx.walk(c);
          }
        } else {
          ctx.walk(typeNode);
        }
        ctx.exitScope();
      }
      const tparams = node.childForFieldName('type_parameters');
      if (tparams) ctx.walk(tparams);
      return true;
    },

    type_alias(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'type' });
      const typeNode = node.childForFieldName('type');
      if (typeNode) ctx.walk(typeNode);
      return true;
    },

    field_declaration(node, ctx) {
      for (const child of node.namedChildren as any[]) {
        if (child.type === 'field_identifier') {
          ctx.define(child, { nameNode: child, kind: 'field' });
        } else if (child.type === 'field_declaration_list' || child.type === 'struct_type') {
          ctx.walk(child);
        } else if (child.type !== 'tag') {
          ctx.walk(child);
        }
      }
      return true;
    },

    method_elem(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'method' });
      for (const f of ['parameters', 'result']) {
        const c = node.childForFieldName(f);
        if (c) ctx.walk(c);
      }
      return true;
    },

    type_elem(node, ctx) {
      const c = node.childForFieldName('type');
      if (c) ctx.walk(c);
      return true;
    },

    selector_expression(node, ctx) {
      const parts = memberParts(node);
      const field = node.childForFieldName('field');
      if (parts && field) ctx.addRef(node, { parts, rangeNode: field, text: node.text });
      const operand = node.childForFieldName('operand');
      if (operand) ctx.walk(operand);
      return true;
    },

    // `util.User{...}` / `var x pkg.Type` 的类型限定名
    qualified_type(node, ctx) {
      const pkg = node.childForFieldName('package');
      const name = node.childForFieldName('name');
      if (pkg && name) {
        ctx.addRef(node, { parts: [pkg.text, name.text], rangeNode: name, text: node.text });
      } else {
        ctx.walkChildren(node);
      }
      return true;
    },

    labeled_statement(node, ctx) {
      const stmt = node.childForFieldName('statement');
      if (stmt) ctx.walk(stmt);
      return true;
    },
  },

  identifierTypes: ['identifier', 'type_identifier'],

  params: defineParameters,
  builtins: GO_BUILTINS,

  commentTypes: ['comment'],

  /** L6：Go 的数值 / 字符串 / 字符字面量（true / false / nil 不列）。 */
  literalTypes: {
    int_literal: 'number',
    float_literal: 'number',
    interpreted_string_literal: 'string',
    raw_string_literal: 'string',
    rune_literal: 'other',
  },

  /** L6：`const X = 30` 的值经 expression_list 包一层，故允许它作为直接值。 */
  valueContainers: {
    const_spec: ['value'],
    var_spec: ['value'],
    short_var_declaration: ['right'],
    assignment_statement: ['right'],
  },

  /** L6：下标 / 元素访问 `m["k"]`（对象字段是 `operand`）。 */
  indexAccess: {
    index_expression: { object: 'operand', key: 'index' },
  },

  /** 同包内其它文件隐式可见（Go 没有 per-symbol import）。 */
  siblings(fromFile: string, hint): string[] {
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    return [...hint.files()].filter((f) => {
      if (!f.endsWith('.go') || f === fromFile) return false;
      const fdir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      return fdir === dir;
    });
  },

  basesOf: goBases,

  resolveModule(specifier: string, _fromFile: string, hint): ModuleCandidate[] | null {
    // 1) 根 go.mod 的 module path（单模块仓库）
    const mod = hint.projectMeta['go.modulePath'];
    if (mod) {
      if (specifier === mod) return [{ path: '', kind: 'dir' }];
      if (specifier.startsWith(`${mod}/`)) {
        return [{ path: specifier.slice(mod.length + 1), kind: 'dir' }];
      }
    }
    // 2) go.work：多个 module 根 + 本地 replace 指令
    const work = goWorkOf(hint);
    if (work) {
      for (const [from, toDir] of work.replaces) {
        if (specifier === from) return [{ path: toDir, kind: 'dir' }];
        if (specifier.startsWith(`${from}/`)) {
          return [{ path: joinRel(toDir, specifier.slice(from.length + 1)), kind: 'dir' }];
        }
      }
      for (const m of work.modules) {
        if (specifier === m.path) return [{ path: m.dir, kind: 'dir' }];
        if (specifier.startsWith(`${m.path}/`)) {
          return [{ path: joinRel(m.dir, specifier.slice(m.path.length + 1)), kind: 'dir' }];
        }
      }
    }
    // 3) 读不到 go.work（如无项目根）时的目录名后缀启发：`example.com/x/lib/...` → `<lib 模块根>/...`
    const guessed = goModuleDirGuess(specifier, hint);
    if (guessed) return guessed;
    // 4) 兜底：说明符本身就是项目内路径
    return hint.exists(specifier) ? [{ path: specifier, kind: 'dir' }] : null;
  },
};

/** `var a, b = 1, 2` / `var a, b int`：前导连续 identifier 是名字，其余按引用走。 */
function defineLeadingNames(node: any, ctx: WalkContext, kind: SymbolKind) {
  let seenOther = false;
  for (const child of node.namedChildren as any[]) {
    if (!seenOther && child.type === 'identifier') {
      ctx.define(child, { nameNode: child, kind });
    } else {
      seenOther = true;
      ctx.walk(child);
    }
  }
}

// ---------------------------------------------------------------- go.work（P10）

interface GoWorkInfo {
  /** use 列表里的模块根（相对项目根）与各自 go.mod 里声明的 module path。 */
  modules: Array<{ dir: string; path: string }>;
  /** `replace X => ./local` 的本地路径替换（远程版本替换不记）。 */
  replaces: Array<[string, string]>;
}

const goWorkCache = new Map<string, { text: string; value: GoWorkInfo }>();

/** 读并解析项目根的 `go.work`（无项目根 / 无该文件时返回 null）。 */
function goWorkOf(hint: ModuleHint): GoWorkInfo | null {
  const text = readHintFile(hint, 'go.work');
  if (text === null) return null;
  const cached = goWorkCache.get('go.work');
  if (cached && cached.text === text) return cached.value;
  const parsed = parseGoWork(text);
  const modules: Array<{ dir: string; path: string }> = [];
  for (const raw of parsed.uses) {
    const dir = joinRel(raw);
    if (dir.startsWith('..')) continue; // 项目外的模块根不索引
    const gomod = readHintFile(hint, dir ? `${dir}/go.mod` : 'go.mod');
    const m = gomod ? /^\s*module\s+(\S+)/m.exec(gomod) : null;
    if (m) modules.push({ dir, path: m[1] });
  }
  const value: GoWorkInfo = { modules, replaces: parsed.replaces };
  goWorkCache.set('go.work', { text, value });
  return value;
}

/** go.work 的 `use (...)` 与 `replace (...)`（只读语法，不做版本解析）。 */
function parseGoWork(text: string): { uses: string[]; replaces: Array<[string, string]> } {
  const uses: string[] = [];
  const replaces: Array<[string, string]> = [];
  let mode: 'use' | 'replace' | null = null;
  const unquote = (s: string) => s.trim().replace(/^["`]|["`]$/g, '');
  const pushReplace = (expr: string) => {
    const parts = expr.split('=>');
    if (parts.length !== 2) return;
    const from = unquote(parts[0]);
    const to = unquote(parts[1]);
    if (from && to.startsWith('.')) replaces.push([from, joinRel(to)]);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line === ')') {
      mode = null;
      continue;
    }
    if (/^use\s*\($/.test(line)) {
      mode = 'use';
      continue;
    }
    if (/^replace\s*\($/.test(line)) {
      mode = 'replace';
      continue;
    }
    const useOne = /^use\s+(.+)$/.exec(line);
    if (useOne) {
      uses.push(unquote(useOne[1]));
      continue;
    }
    const replaceOne = /^replace\s+(.+)$/.exec(line);
    if (replaceOne) {
      pushReplace(replaceOne[1]);
      continue;
    }
    if (mode === 'use') uses.push(unquote(line));
    else if (mode === 'replace') pushReplace(line);
  }
  return { uses, replaces };
}

/**
 * 没有 go.work 时的启发：多模块仓库的 module path 末段通常就是模块目录名，
 * 在项目内按这个后缀找模块根（`example.com/x/lib/sub` → `lib/sub`）。
 */
function goModuleDirGuess(specifier: string, hint: ModuleHint): ModuleCandidate[] | null {
  const roots: string[] = [];
  for (const f of hint.files()) {
    if (f === 'go.mod') roots.push('');
    else if (f.endsWith('/go.mod')) roots.push(f.slice(0, -'/go.mod'.length));
  }
  for (const dir of roots) {
    if (!dir) continue;
    const last = basename(dir);
    const atEnd = specifier.endsWith(`/${last}`);
    const idx = specifier.lastIndexOf(`/${last}/`);
    if (!atEnd && idx < 0) continue;
    const rest = atEnd ? '' : specifier.slice(idx + last.length + 2);
    const target = rest ? joinRel(dir, rest) : dir;
    if (hint.exists(target)) return [{ path: target, kind: 'dir' }];
  }
  return null;
}
