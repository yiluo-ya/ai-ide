/**
 * Rust 语言模块：定义 / 引用提取 + crate 路径解析（`crate::` / `super::` / `self::`）。
 *
 * 覆盖口径（只读 AST，不做类型推断）：
 * - 定义：fn / struct / enum / trait / mod / type / const / static / macro_rules!、impl 内方法与字段；
 * - 引用：标识符与类型标识符；`p.field` 记为成员引用（`obj.method()` 仍无法跳转，见 P2 的 unresolved 口径）；
 * - 继承：`impl Trait for Type` 与 `#[derive(...)]` 都作为目标类型的 implements 基名（impl 可出现在定义之前，
 *   也可能在别的文件里 —— 跨文件的 impl 覆盖不到，只认同一文件内的语法事实）；
 * - 模块：`crate::a::b` → `src/a/b.rs` 或 `src/a/b/mod.rs`；`std::` / 第三方 crate 返回 null（落 external）。
 */
import Rust from 'tree-sitter-rust';
import type { DefRecord } from '../indexer/model';
import type { BaseInfo, DecoratorInfo, LanguageSpec, ModuleCandidate, WalkContext } from '../indexer/walker';
import { basename, dirname, joinRel, stripExt } from '../indexer/paths';
import type { SymbolKind } from '../types';

/** Rust 标准库类型 / 原生类型 / 常用宏：落 external，不参与跳转。 */
const RUST_BUILTINS = new Set([
  // 原生类型
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
  'f32',
  'f64',
  'bool',
  'char',
  'str',
  // 语法成分
  'self',
  'Self',
  'super',
  'crate',
  'true',
  'false',
  'None',
  'Some',
  'Ok',
  'Err',
  // 标准库类型 / trait
  'String',
  'Vec',
  'VecDeque',
  'Option',
  'Result',
  'Box',
  'Rc',
  'Arc',
  'Weak',
  'RefCell',
  'Cell',
  'Mutex',
  'RwLock',
  'OnceCell',
  'OnceLock',
  'Cow',
  'HashMap',
  'HashSet',
  'BTreeMap',
  'BTreeSet',
  'BinaryHeap',
  'LinkedList',
  'Iterator',
  'IntoIterator',
  'FromIterator',
  'Extend',
  'DoubleEndedIterator',
  'Clone',
  'Copy',
  'Default',
  'Debug',
  'Display',
  'PartialEq',
  'Eq',
  'PartialOrd',
  'Ord',
  'Hash',
  'Send',
  'Sync',
  'Sized',
  'Drop',
  'Fn',
  'FnMut',
  'FnOnce',
  'From',
  'Into',
  'TryFrom',
  'TryInto',
  'AsRef',
  'AsMut',
  'Borrow',
  'BorrowMut',
  'Deref',
  'DerefMut',
  'ToString',
  'ToOwned',
  'Spawn',
  'Path',
  'PathBuf',
  'OsStr',
  'OsString',
  'CString',
  'CStr',
  'Duration',
  'Instant',
  'SystemTime',
  'IpAddr',
  'Ipv4Addr',
  'Ipv6Addr',
  'SocketAddr',
  'Ordering',
  'Range',
  'RangeInclusive',
  'NonNull',
  // 常用宏（macro_invocation 的 macro 标识符不带 `!`）
  'print',
  'println',
  'eprint',
  'eprintln',
  'format',
  'vec',
  'write',
  'writeln',
  'panic',
  'assert',
  'assert_eq',
  'assert_ne',
  'debug_assert',
  'debug_assert_eq',
  'debug_assert_ne',
  'todo',
  'unimplemented',
  'unreachable',
  'matches',
  'dbg',
  'include',
  'include_str',
  'include_bytes',
  'env',
  'option_env',
  'concat',
  'stringify',
  'line',
  'column',
  'file',
  'module_path',
  'cfg',
  'derive',
  'allow',
  'warn',
  'deny',
  'forbid',
  'test',
  'bench',
  'macro_rules',
]);

/** 类型定义类 kind（impl / derive 的基名要挂到这些定义上）。 */
function isTypeDefKind(kind: SymbolKind): boolean {
  return kind === 'struct' || kind === 'enum' || kind === 'interface' || kind === 'type' || kind === 'class';
}

/**
 * impl 块与 #[derive] 指出的基名需要挂到「类型定义」上，但 impl 允许出现在定义之前，
 * 故先记 pending，等定义出现（或反过来）时补齐；顺序无关。
 */
const pendingBases = new WeakMap<WalkContext, Map<string, BaseInfo[]>>();

function attachBase(ctx: WalkContext, typeName: string, base: BaseInfo) {
  const def = ctx.definitions.find((d) => d.name === typeName && !d.local && isTypeDefKind(d.kind));
  if (def) {
    def.bases = [...(def.bases ?? []), base];
    return;
  }
  let map = pendingBases.get(ctx);
  if (!map) {
    map = new Map();
    pendingBases.set(ctx, map);
  }
  const list = map.get(typeName);
  if (list) list.push(base);
  else map.set(typeName, [base]);
}

/** 定义出现时把「先到的 impl」补上。 */
function applyPendingBases(ctx: WalkContext, def: DefRecord | null) {
  if (!def) return;
  const map = pendingBases.get(ctx);
  const list = map?.get(def.name);
  if (!list?.length || !map) return;
  def.bases = [...(def.bases ?? []), ...list];
  map.delete(def.name);
}

/** 类型名去泛型 / 去引用：`&'a Point<T>` → `Point`。 */
function typeBaseName(node: any): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
    case 'identifier':
      return node.text;
    case 'generic_type':
      return typeBaseName(node.childForFieldName('type') ?? (node.namedChildren as any[])[0]);
    case 'reference_type':
      return typeBaseName(node.childForFieldName('type') ?? (node.namedChildren as any[])[0]);
    case 'scoped_type_identifier':
      return node.childForFieldName('name')?.text ?? node.text;
    default:
      return typeof node.text === 'string' && node.text ? node.text : null;
  }
}

/** 紧邻定义之前的 `#[derive(...)]` 展开为 implements 基名（前缀 `derive.` 避免与真实类型撞名）。 */
function deriveBases(node: any): BaseInfo[] | null {
  const out: BaseInfo[] = [];
  let sib = node.previousNamedSibling;
  while (sib) {
    if (sib.type === 'line_comment' || sib.type === 'block_comment') {
      sib = sib.previousNamedSibling;
      continue;
    }
    if (sib.type !== 'attribute_item') break;
    const attr = (sib.namedChildren as any[]).find((c: any) => c.type === 'attribute');
    const head = attr ? (attr.namedChildren as any[])[0] : null;
    if (attr && head?.text === 'derive') {
      const args = attr.childForFieldName('arguments');
      for (const c of (args?.namedChildren ?? []) as any[]) {
        if (c.type === 'identifier' || c.type === 'scoped_identifier') {
          out.push({ name: `derive.${c.text}`, kind: 'implements' });
        }
      }
    }
    sib = sib.previousNamedSibling;
  }
  return out.length ? out : null;
}

/** 定义节点 / impl 的目标类型上的基名。 */
function rustBases(node: any): BaseInfo[] | null {
  if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'type_item') {
    return deriveBases(node);
  }
  return null;
}

/** `#[...]` 属性（前导兄弟节点，不是子节点）。 */
function rustDecorators(node: any): DecoratorInfo[] | null {
  const out: DecoratorInfo[] = [];
  let sib = node.previousNamedSibling;
  while (sib) {
    if (sib.type === 'attribute_item') {
      out.unshift({
        text: String(sib.text).replace(/\s+/g, ' ').trim(),
        startLine: sib.startPosition.row + 1,
        endLine: sib.endPosition.row + 1,
      });
      sib = sib.previousNamedSibling;
      continue;
    }
    if (sib.type === 'line_comment' || sib.type === 'block_comment') {
      sib = sib.previousNamedSibling;
      continue;
    }
    break;
  }
  return out.length ? out : null;
}

/** `///` / `//!` 文档注释（普通 `//` 返回 null，交给上方的注释块归属逻辑）。 */
function rustDocstring(node: any): string | null {
  const lines: string[] = [];
  let sib = node.previousNamedSibling;
  while (sib) {
    if (sib.type === 'attribute_item') {
      sib = sib.previousNamedSibling;
      continue;
    }
    if (sib.type !== 'line_comment') break;
    const kids = (sib.namedChildren ?? []) as any[];
    const isDoc = kids.some((c: any) => c.type === 'outer_doc_comment_marker' || c.type === 'inner_doc_comment_marker');
    if (!isDoc) break;
    const text = kids.find((c: any) => c.type === 'doc_comment')?.text ?? '';
    lines.unshift(String(text).trim());
    sib = sib.previousNamedSibling;
  }
  return lines.length ? lines.join('\n') : null;
}

/** 变量绑定模式：`x` / `mut x` / `&x` / `(a, b)` / `x @ _`。 */
function definePattern(node: any, ctx: WalkContext, kind: SymbolKind = 'variable') {
  if (!node) return;
  switch (node.type) {
    case 'identifier':
    case 'shorthand_field_identifier':
      ctx.define(node, { nameNode: node, kind });
      return;
    case 'mut_pattern':
    case 'ref_pattern':
    case 'reference_pattern':
    case 'tuple_pattern':
    case 'slice_pattern':
    case 'or_pattern':
    case 'captured_pattern':
      for (const c of node.namedChildren as any[]) definePattern(c, ctx, kind);
      return;
    default:
      return;
  }
}

/** 形参：`self` / `&self` / `x: i32` / `(a, b): (i32, i32)`。 */
function defineParameters(node: any, ctx: WalkContext) {
  for (const child of node.namedChildren as any[]) {
    if (child.type === 'self_parameter') {
      const selfNode = (child.namedChildren as any[]).find((c: any) => c.type === 'self');
      if (selfNode) ctx.define(selfNode, { nameNode: selfNode, kind: 'parameter' });
      continue;
    }
    if (child.type === 'parameter') {
      const pattern = child.childForFieldName('pattern');
      if (pattern) definePattern(pattern, ctx, 'parameter');
      const type = child.childForFieldName('type');
      if (type) ctx.walk(type);
      continue;
    }
    ctx.walk(child);
  }
}

/** `a::b::c` 形式的路径 → 段数组。 */
function pathSegments(node: any): string[] | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self':
    case 'metavariable':
      return [node.text];
    case 'scoped_identifier':
    case 'scoped_type_identifier': {
      const path = pathSegments(node.childForFieldName('path'));
      const name = node.childForFieldName('name');
      if (!path || !name) return null;
      return [...path, name.text];
    }
    default:
      return null;
  }
}

interface UseItem {
  segments: string[];
  alias?: string;
  wildcard?: boolean;
  rangeNode: any;
}

/** 展开一条 use 里的所有绑定（`{A, B as C}` / `*` / `X as Y` 都拆开）。 */
function expandUse(node: any, base: string[] = []): UseItem[] {
  if (!node) return [];
  switch (node.type) {
    case 'use_as_clause': {
      const segs = pathSegments(node.childForFieldName('path'));
      const alias = node.childForFieldName('alias');
      if (!segs) return [];
      return [{ segments: [...base, ...segs], alias: alias?.text, rangeNode: alias ?? node }];
    }
    case 'scoped_use_list': {
      const prefix = pathSegments(node.childForFieldName('path')) ?? [];
      const list = node.childForFieldName('list');
      const out: UseItem[] = [];
      for (const c of (list?.namedChildren ?? []) as any[]) out.push(...expandUse(c, [...base, ...prefix]));
      return out;
    }
    case 'use_list': {
      const out: UseItem[] = [];
      for (const c of node.namedChildren as any[]) out.push(...expandUse(c, base));
      return out;
    }
    case 'use_wildcard': {
      const inner = (node.namedChildren as any[])[0];
      const segs = pathSegments(inner);
      if (!segs) return [];
      return [{ segments: [...base, ...segs], wildcard: true, rangeNode: node }];
    }
    default: {
      const segs = pathSegments(node);
      if (!segs) return [];
      return [{ segments: [...base, ...segs], rangeNode: node }];
    }
  }
}

/** `p.field` / `a.b.c` 的成员链；对象过复杂就不记成员引用。 */
function chainParts(value: any, field: any): string[] | null {
  if (!value || !field) return null;
  if (value.type === 'identifier' || value.type === 'self' || value.type === 'type_identifier') {
    return [value.text, field.text];
  }
  if (value.type === 'field_expression') {
    const base = chainParts(value.childForFieldName('value'), value.childForFieldName('field'));
    return base ? [...base, field.text] : null;
  }
  if (value.type === 'scoped_identifier' || value.type === 'scoped_type_identifier') {
    const base = pathSegments(value);
    return base ? [...base, field.text] : null;
  }
  return null;
}

/** impl 块的类型名 / 方法归属：`impl Draw for Point` 的方法 containerName = Point。 */
function handleFunction(node: any, ctx: WalkContext) {
  const name = node.childForFieldName('name');
  const ownerItem = node.parent?.type === 'declaration_list' ? node.parent.parent : null;
  const isMethod = ownerItem?.type === 'impl_item' || ownerItem?.type === 'trait_item';
  const def = name ? ctx.define(node, { nameNode: name, kind: isMethod ? 'method' : 'function' }) : null;
  const scope = ctx.enterScope(node, { kind: 'function', fixedName: name?.text }, name?.text ?? null);
  if (def) def.bodyScopeId = scope.id;
  const params = node.childForFieldName('parameters');
  if (params) defineParameters(params, ctx);
  const ret = node.childForFieldName('return_type');
  if (ret) ctx.walk(ret);
  const body = node.childForFieldName('body');
  if (body) ctx.walk(body);
  ctx.exitScope();
  return true;
}

export const rust: LanguageSpec = {
  id: 'rust',
  label: 'Rust',
  extensions: ['.rs'],
  grammar: Rust,

  scopes: {
    source_file: { kind: 'file' },
    mod_item: { kind: 'module', nameFields: ['name'], defKind: 'module' },
    function_item: { kind: 'function', nameFields: ['name'], defKind: 'function', paramFields: ['parameters'] },
    function_signature_item: {
      kind: 'function',
      nameFields: ['name'],
      defKind: 'method',
      paramFields: ['parameters'],
    },
    struct_item: { kind: 'class', nameFields: ['name'], defKind: 'struct' },
    enum_item: { kind: 'class', nameFields: ['name'], defKind: 'enum' },
    trait_item: { kind: 'class', nameFields: ['name'], defKind: 'interface' },
    impl_item: { kind: 'class' },
    type_item: { kind: 'class', nameFields: ['name'], defKind: 'type' },
    const_item: { kind: 'class', nameFields: ['name'], defKind: 'constant' },
    static_item: { kind: 'class', nameFields: ['name'], defKind: 'constant' },
    block: { kind: 'block' },
  },

  handlers: {
    function_item: handleFunction,

    macro_definition(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'function' });
      return true; // 宏体是 token tree，不解析（`$x` 不是引用）
    },

    impl_item(node, ctx) {
      const typeNode = node.childForFieldName('type');
      const traitNode = node.childForFieldName('trait');
      const typeName = typeBaseName(typeNode) ?? 'impl';
      if (traitNode && typeNode) {
        const traitName = typeBaseName(traitNode);
        if (traitName) attachBase(ctx, typeName, { name: traitName, kind: 'implements' });
      }
      ctx.enterScope(node, { kind: 'class', fixedName: typeName }, typeName);
      for (const c of node.namedChildren as any[]) ctx.walk(c);
      ctx.exitScope();
      return true;
    },

    struct_item(node, ctx) {
      const name = node.childForFieldName('name');
      const def = name ? ctx.define(node, { nameNode: name, kind: 'struct' }) : null;
      applyPendingBases(ctx, def);
      const scope = ctx.enterScope(node, { kind: 'class', fixedName: name?.text }, name?.text ?? null);
      if (def) def.bodyScopeId = scope.id;
      for (const c of node.namedChildren as any[]) if (c !== name) ctx.walk(c);
      ctx.exitScope();
      return true;
    },

    enum_item(node, ctx) {
      const name = node.childForFieldName('name');
      const def = name ? ctx.define(node, { nameNode: name, kind: 'enum' }) : null;
      applyPendingBases(ctx, def);
      const scope = ctx.enterScope(node, { kind: 'class', fixedName: name?.text }, name?.text ?? null);
      if (def) def.bodyScopeId = scope.id;
      for (const c of node.namedChildren as any[]) if (c !== name) ctx.walk(c);
      ctx.exitScope();
      return true;
    },

    enum_variant(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'enumMember' });
      for (const c of node.namedChildren as any[]) if (c !== name) ctx.walk(c);
      return true;
    },

    field_declaration(node, ctx) {
      const name = node.childForFieldName('name');
      if (name && name.type === 'field_identifier') {
        ctx.define(name, { nameNode: name, kind: 'field' });
      }
      const type = node.childForFieldName('type');
      if (type) ctx.walk(type);
      return true;
    },

    let_declaration(node, ctx) {
      const pattern = node.childForFieldName('pattern');
      if (pattern) definePattern(pattern, ctx);
      for (const c of node.namedChildren as any[]) if (c !== pattern) ctx.walk(c);
      return true;
    },

    closure_expression(node, ctx) {
      const params = node.childForFieldName('parameters');
      if (params) {
        for (const c of params.namedChildren as any[]) {
          if (c.type === 'identifier') ctx.define(c, { nameNode: c, kind: 'parameter' });
          else definePattern(c, ctx, 'parameter');
        }
      }
      for (const c of node.namedChildren as any[]) if (c !== params) ctx.walk(c);
      return true;
    },

    use_declaration(node, ctx) {
      const arg = node.childForFieldName('argument');
      if (!arg) return true;
      for (const item of expandUse(arg)) {
        const segs = item.segments.filter(Boolean);
        if (!segs.length) continue;
        if (item.wildcard) {
          ctx.addImport({
            localName: '*',
            module: segs.join('::'),
            kind: 'star',
            range: ctx.rangeOf(item.rangeNode),
          });
          continue;
        }
        const last = segs[segs.length - 1];
        const localName = item.alias ?? last;
        if (segs.length === 1) {
          ctx.addImport({
            localName,
            module: last,
            kind: 'module',
            range: ctx.rangeOf(item.rangeNode),
          });
          continue;
        }
        ctx.addImport({
          localName,
          module: segs.slice(0, -1).join('::'),
          importedName: last,
          kind: 'named',
          range: ctx.rangeOf(item.rangeNode),
        });
        ctx.addRef(item.rangeNode, { kind: 'import', name: localName });
      }
      return true;
    },

    field_expression(node, ctx) {
      const value = node.childForFieldName('value');
      const field = node.childForFieldName('field');
      const parts = chainParts(value, field);
      if (parts && field) {
        ctx.addRef(node, { parts, rangeNode: field, text: node.text });
        if (value.type === 'field_expression') ctx.walk(value);
      } else {
        if (value) ctx.walk(value);
        if (field) ctx.addRef(field);
      }
      return true;
    },
  },

  identifierTypes: ['identifier', 'type_identifier'],

  params: defineParameters,
  builtins: RUST_BUILTINS,

  commentTypes: ['line_comment', 'block_comment'],

  literalTypes: {
    integer_literal: 'number',
    float_literal: 'number',
    string_literal: 'string',
    raw_string_literal: 'string',
    char_literal: 'other',
  },

  valueContainers: {
    const_item: ['value'],
    static_item: ['value'],
    let_declaration: ['value'],
  },

  decoratorsOf: rustDecorators,
  docstringOf: rustDocstring,
  basesOf: rustBases,

  resolveModule(specifier: string, fromFile: string, _hint): ModuleCandidate[] | null {
    const segs = specifier.split('::').filter(Boolean);
    if (!segs.length) return null;
    /**
     * 模块层级口径：
     * - `src/a/mod.rs` 的模块目录就是 `src/a`；`src/a/b.rs` 的模块目录是 `src/a/b`（文件模块自身）；
     * - 一条 `super` 从当前模块升到父模块（`src/a/b.rs` 的父是 `src/a`）；
     * - `self::x` 指向当前模块内的项：先给「当前文件」自己，再看子模块文件。
     */
    let moduleFile = fromFile;
    let moduleDir = basename(fromFile) === 'mod.rs' ? dirname(fromFile) : stripExt(fromFile);
    let rest = segs;
    let crateRoot = false;
    if (segs[0] === 'crate') {
      moduleFile = 'src/lib.rs';
      moduleDir = 'src';
      rest = segs.slice(1);
      crateRoot = true;
    } else if (segs[0] === 'self' || segs[0] === 'super') {
      while (rest[0] === 'self' || rest[0] === 'super') {
        if (rest[0] === 'super') {
          moduleDir = dirname(moduleDir);
          moduleFile = moduleDir ? `${moduleDir}/mod.rs` : 'src/lib.rs';
        }
        rest = rest.slice(1);
      }
    } else {
      return null; // std::* 与第三方 crate 落 external
    }
    if (!rest.length) {
      const self: ModuleCandidate = { path: moduleFile, kind: 'file' };
      if (crateRoot) {
        return [self, { path: 'src/main.rs', kind: 'file' }];
      }
      return [self];
    }
    const base = joinRel(moduleDir, ...rest);
    if (!base) return null;
    const out: ModuleCandidate[] = [
      { path: `${base}.rs`, kind: 'file' },
      { path: `${base}/mod.rs`, kind: 'file' },
    ];
    // `self::X` 里的 X 也可能是当前模块内的项（如 `use self::helper;`）
    if (segs[0] === 'self' && rest.length === 1) out.push({ path: moduleFile, kind: 'file' });
    return out;
  },
};
