/**
 * TypeScript / JavaScript / TSX / JSX 语言模块。
 * 同一套规则，用不同语法包实例化（.ts 与 .d.ts 同规则；.jsx 用 tsx 语法以支持 JSX）。
 */
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import type {
  BaseInfo, DecoratorInfo, LanguageSpec, ModuleCandidate, ModuleHint, WalkContext,
} from '../indexer/walker';
import { dirname, joinRel } from '../indexer/paths';
import { readHintFile, readHintJson, stripJsonComments } from '../config';
import type { SymbolKind } from '../types';

const JS_GLOBALS = new Set([
  'console', 'window', 'document', 'globalThis', 'process', 'require', 'module', 'exports',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Proxy', 'Reflect', 'Intl', 'Buffer', 'URL', 'URLSearchParams', 'fetch', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'undefined', 'null', 'NaN', 'Infinity',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'structuredClone', 'queueMicrotask', 'global', 'Function', '__dirname', '__filename',
]);

/** 解构 / 形参里的目标模式 → 定义。 */
function definePattern(node: any, ctx: WalkContext, kind: SymbolKind = 'variable') {
  if (!node) return;
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      ctx.define(node, { nameNode: node, kind });
      return;
    case 'object_pattern':
    case 'array_pattern':
    case 'rest_pattern':
      for (const c of node.namedChildren as any[]) definePattern(c, ctx, kind);
      return;
    case 'pair_pattern':
      definePattern(node.childForFieldName('value'), ctx, kind);
      return;
    case 'assignment_pattern':
    case 'object_assignment_pattern': {
      definePattern(node.childForFieldName('left'), ctx, kind);
      const right = node.childForFieldName('right');
      if (right) ctx.walk(right);
      return;
    }
    default:
      ctx.walk(node);
  }
}

function defineParams(node: any, ctx: WalkContext) {
  if (node.type === 'formal_parameters') {
    for (const child of node.namedChildren as any[]) {
      if (child.type === 'identifier') ctx.define(child, { nameNode: child, kind: 'parameter' });
      else if (child.type === 'comment') continue;
      else ctx.walk(child);
    }
    return;
  }
  if (node.type === 'identifier') {
    ctx.define(node, { nameNode: node, kind: 'parameter' });
    return;
  }
  definePattern(node, ctx, 'parameter');
}

function defineRequiredParameter(node: any, ctx: WalkContext) {
  definePattern(
    node.childForFieldName('pattern') ?? node.childForFieldName('name'),
    ctx,
    'parameter',
  );
  for (const f of ['type', 'value']) {
    const c = node.childForFieldName(f);
    if (c) ctx.walk(c);
  }
  return true;
}

function defineClassField(node: any, ctx: WalkContext) {
  const name = node.childForFieldName('name');
  if (name) ctx.define(node, { nameNode: name, kind: 'property' });
  for (const f of ['value', 'type']) {
    const c = node.childForFieldName(f);
    if (c) ctx.walk(c);
  }
  return true;
}

/** `a.b.c` → ['a','b','c']，拆不开返回 null。 */
function memberParts(node: any): string[] | null {
  if (node.type !== 'member_expression') return null;
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  if (!property) return null;
  if (object?.type === 'identifier' || object?.type === 'this' || object?.type === 'super') {
    return [object.text, property.text];
  }
  if (object?.type === 'member_expression') {
    const base = memberParts(object);
    return base ? [...base, property.text] : null;
  }
  return null;
}

/** 相对说明符 → 候选文件；裸说明符走 monorepo 解析（tsconfig paths / workspace 包 / 别名），仍未命中返回 null。 */
function tsResolveModule(specifier: string, fromFile: string, hint?: ModuleHint): ModuleCandidate[] | null {
  if (specifier.startsWith('.')) return relativeTsCandidates(specifier, fromFile);
  if (!hint || specifier.startsWith('node:')) return null; // node_modules / 内置：落 external
  const bases: string[] = [];
  const cfg = tsconfigOf(hint);
  if (cfg) {
    bases.push(...tsPathTargets(specifier, cfg));
    if (cfg.baseUrl) bases.push(joinRel(cfg.baseUrl, specifier));
  }
  // 包自引用：根 package.json 的 name 指向项目根
  const ownName = hint.projectMeta['npm.name'];
  if (ownName && specifier === ownName) bases.push('.');
  else if (ownName && specifier.startsWith(`${ownName}/`)) bases.push(specifier.slice(ownName.length + 1));
  // monorepo workspace 包（packages/* / apps/* …），入口看该包 package.json 的 exports / main
  bases.push(...workspacePackageTargets(specifier, hint));
  // 常见别名：`@/x` 与 `~/x` 都指向 src/x
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const rest = specifier.slice(2);
    bases.push(`src/${rest}`, rest);
  }
  if (!bases.length) return null;
  const out: ModuleCandidate[] = [];
  const seen = new Set<string>();
  for (const b of bases) {
    for (const c of tsFileCandidates(b)) {
      if (!c.path || seen.has(c.path) || !hint.exists(c.path)) continue;
      seen.add(c.path);
      out.push(c);
    }
  }
  return out.length ? out : null;
}

const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

/** 基础路径 → 文件本体 / 各扩展名 / index.*（未经 exists 过滤）。 */
function tsFileCandidates(base: string): ModuleCandidate[] {
  if (!base || base.startsWith('..')) return [];
  const out: ModuleCandidate[] = [{ path: base, kind: 'file' }];
  for (const e of TS_EXTS) out.push({ path: `${base}${e}`, kind: 'file' });
  for (const e of TS_EXTS) out.push({ path: `${base}/index${e}`, kind: 'file' });
  return out;
}

/** 相对说明符：候选扩展名沿用原有口径。 */
function relativeTsCandidates(specifier: string, fromFile: string): ModuleCandidate[] | null {
  const base = joinRel(dirname(fromFile), specifier);
  if (!base || base.startsWith('..')) return null;
  return tsFileCandidates(base);
}

interface TsCompilerPaths {
  /** 相对项目根的 baseUrl（`tsconfig` 所在目录为基准）。 */
  baseUrl: string;
  paths: Record<string, string[]>;
}

interface RawTsConfig {
  extends?: string;
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/** 解析结果按「文件文本」缓存：文本没变（mtime 未动）就不重复 parse。 */
const tsconfigParseCache = new Map<string, { text: string; value: RawTsConfig }>();

/** 读并解析一个 tsconfig（带文本级缓存）。 */
function readTsConfig(hint: ModuleHint, rel: string): RawTsConfig | null {
  const text = readHintFile(hint, rel);
  if (text === null) return null;
  const cached = tsconfigParseCache.get(rel);
  if (cached && cached.text === text) return cached.value;
  let value: RawTsConfig | null = null;
  try {
    value = JSON.parse(stripJsonComments(text)) as RawTsConfig;
  } catch {
    value = null;
  }
  if (value) tsconfigParseCache.set(rel, { text, value });
  return value;
}

/**
 * 读项目根的 `tsconfig.json` / `tsconfig.base.json`（含一层本地 `extends`），
 * 合并 `compilerOptions.baseUrl` 与 `paths`：baseUrl 相对各自 tsconfig 所在目录解析。
 * 读不到配置文件（hint 未提供项目根）时返回 null，由调用方退回路径启发式。
 */
function tsconfigOf(hint: ModuleHint): TsCompilerPaths | null {
  const merged: TsCompilerPaths = { baseUrl: '', paths: {} };
  let found = false;
  const seen = new Set<string>();
  const apply = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const cfg = readTsConfig(hint, rel);
    if (!cfg) return;
    const dir = dirname(rel);
    if (typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      const ext = cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`;
      apply(joinRel(dir, ext));
    }
    const co = cfg.compilerOptions ?? {};
    if (co.paths && typeof co.paths === 'object') {
      merged.paths = { ...merged.paths, ...co.paths };
      found = true;
    }
    if (typeof co.baseUrl === 'string') {
      merged.baseUrl = joinRel(dir, co.baseUrl);
      found = true;
    }
  };
  for (const rel of ['tsconfig.json', 'tsconfig.base.json']) apply(rel);
  return found ? merged : null;
}

/** `paths` 通配匹配：`@app/*` → `apps/app/src/*`。 */
function tsPathTargets(specifier: string, cfg: TsCompilerPaths): string[] {
  const out: string[] = [];
  for (const [pattern, targets] of Object.entries(cfg.paths)) {
    const star = pattern.indexOf('*');
    let middle = '';
    if (star < 0) {
      if (pattern !== specifier) continue;
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const t of Array.isArray(targets) ? targets : []) {
      if (typeof t !== 'string') continue;
      const at = t.indexOf('*');
      out.push(at < 0 ? joinRel(cfg.baseUrl, t) : joinRel(cfg.baseUrl, t.slice(0, at) + middle + t.slice(at + 1)));
    }
  }
  return out;
}

/** monorepo 常见布局的包目录前缀（标准 workspace 目录名）。 */
const WORKSPACE_DIRS = ['packages', 'apps', 'libs', 'modules', 'services', 'workspaces'];

/** 裸说明符 → workspace 包目录下的入口路径（只认项目内已存在的目录与实体）。 */
function workspacePackageTargets(specifier: string, hint: ModuleHint): string[] {
  const segs = specifier.split('/').filter(Boolean);
  if (!segs.length) return [];
  const pkg = specifier.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
  const sub = specifier.startsWith('@') ? segs.slice(2).join('/') : segs.slice(1).join('/');
  if (!pkg) return [];
  // 包目录名常只取 scope 的末段（`@acme/ui` → `packages/ui`），两个都试。
  const names = pkg.includes('/') ? [pkg, segs[1]] : [pkg];
  const out: string[] = [];
  for (const root of ['', ...WORKSPACE_DIRS.map((d) => `${d}/`)]) {
    for (const name of names) {
      const dir = `${root}${name}`;
      if (!hint.exists(dir)) continue;
      const entry = packageEntry(dir, sub, hint);
      if (entry) out.push(entry);
      out.push(joinRel(dir, 'src', sub));
      out.push(joinRel(dir, sub));
    }
  }
  return out;
}

/** 项目内包的 package.json 入口：`exports` 优先，其次 main / module / types。 */
function packageEntry(dir: string, sub: string, hint: ModuleHint): string | null {
  const pkg = readHintJson<{ main?: string; module?: string; types?: string; exports?: unknown }>(
    hint,
    `${dir}/package.json`,
  );
  if (!pkg) return null;
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const key of ['.', 'import', 'default', 'require', 'types', 'node', 'browser']) {
        const got = pick(obj[key]);
        if (got) return got;
      }
    }
    return null;
  };
  let entry: string | null = null;
  if (pkg.exports && typeof pkg.exports === 'object') {
    const map = pkg.exports as Record<string, unknown>;
    if (sub) {
      entry = pick(map[`./${sub}`]) ?? pick(map['./*'])?.replace('*', sub) ?? null;
    } else {
      entry = pick(map);
    }
  }
  if (!entry && !sub) entry = pkg.module ?? pkg.main ?? pkg.types ?? null;
  if (!entry) return null;
  return joinRel(dir, entry);
}

/** 采集一个节点（及其 export 包装）上的类装饰器（L7）。 */
function tsDecorators(node: any): DecoratorInfo[] | null {
  if (node.type !== 'class_declaration' && node.type !== 'abstract_class_declaration') return null;
  const owners = [node];
  if (node.parent?.type === 'export_statement') owners.push(node.parent);
  const out: DecoratorInfo[] = [];
  for (const owner of owners) {
    for (const c of owner.namedChildren as any[]) {
      if (c.type !== 'decorator') continue;
      out.push({
        text: c.text.replace(/\s+/g, ' ').trim(),
        startLine: c.startPosition.row + 1,
        endLine: c.endPosition.row + 1,
      });
    }
  }
  return out.length ? out : null;
}

/** `class A extends B<T> implements C {}` 里的基名（泛型实参丢弃）。 */
function tsTypeNameOf(node: any): string | null {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'nested_type_identifier') {
    return node.text;
  }
  if (node.type === 'generic_type') {
    const name = node.childForFieldName('name') ?? (node.namedChildren as any[])[0];
    return tsTypeNameOf(name);
  }
  if (node.type === 'member_expression') return node.text;
  return null;
}

/**
 * 显式继承 / 实现（N17）：类与接口的 extends / implements。
 * 只读 AST：条件类型、映射类型、混入函数的动态基类不覆盖。
 */
function tsBases(node: any): BaseInfo[] | null {
  const kinds = ['class_declaration', 'abstract_class_declaration', 'class', 'interface_declaration'];
  if (!kinds.includes(node.type)) return null;
  const out: BaseInfo[] = [];
  for (const c of (node.namedChildren ?? []) as any[]) {
    if (c.type === 'class_heritage') {
      for (const h of (c.namedChildren ?? []) as any[]) {
        if (h.type === 'extends_clause') {
          const v = h.childForFieldName('value');
          const name = tsTypeNameOf(v) ?? (h.namedChildren as any[])[0]?.text;
          if (name) out.push({ name, kind: 'extends' });
        } else if (h.type === 'implements_clause') {
          for (const t of (h.namedChildren ?? []) as any[]) {
            const name = tsTypeNameOf(t);
            if (name) out.push({ name, kind: 'implements' });
          }
        }
      }
    } else if (c.type === 'extends_type_clause') {
      // interface A extends B, C
      for (const t of (c.namedChildren ?? []) as any[]) {
        const name = tsTypeNameOf(t);
        if (name) out.push({ name, kind: 'extends' });
      }
    }
  }
  return out.length ? out : null;
}

function makeTsSpec(
  id: LanguageSpec['id'],
  label: string,
  grammar: unknown,
  extensions: string[],
): LanguageSpec {
  return {
    id,
    label,
    extensions,
    grammar,

    scopes: {
      function_declaration: {
        kind: 'function', nameFields: ['name'], defKind: 'function', paramFields: ['parameters'],
      },
      generator_function_declaration: {
        kind: 'function', nameFields: ['name'], defKind: 'function', paramFields: ['parameters'],
      },
      function_expression: {
        kind: 'function', nameFields: ['name'], defKind: 'function', paramFields: ['parameters'],
      },
      generator_function: {
        kind: 'function', nameFields: ['name'], defKind: 'function', paramFields: ['parameters'],
      },
      arrow_function: {
        kind: 'function', fixedName: '=>', paramFields: ['parameters', 'parameter'],
      },
      method_definition: {
        kind: 'function', nameFields: ['name'], defKind: 'method', paramFields: ['parameters'],
      },
      method_signature: {
        kind: 'function', nameFields: ['name'], defKind: 'method', paramFields: ['parameters'],
      },
      abstract_method_signature: {
        kind: 'function', nameFields: ['name'], defKind: 'method', paramFields: ['parameters'],
      },
      class_declaration: { kind: 'class', nameFields: ['name'], defKind: 'class' },
      abstract_class_declaration: { kind: 'class', nameFields: ['name'], defKind: 'class' },
      class: { kind: 'class', nameFields: ['name'], defKind: 'class' },
      interface_declaration: { kind: 'class', nameFields: ['name'], defKind: 'interface' },
      enum_declaration: { kind: 'class', nameFields: ['name'], defKind: 'enum' },
      internal_module: { kind: 'namespace', nameFields: ['name'], defKind: 'namespace' },
      statement_block: { kind: 'block' },
      class_static_block: { kind: 'block', fixedName: 'static' },
      switch_body: { kind: 'block', fixedName: 'switch' },
      for_statement: { kind: 'block', fixedName: 'for' },
      for_in_statement: { kind: 'block', fixedName: 'for' },
      catch_clause: { kind: 'block', fixedName: 'catch' },
    },

    handlers: {
      variable_declarator(node, ctx) {
        const parent = node.parent;
        const isConst = parent?.type === 'lexical_declaration' && /^\s*const\b/.test(parent.text ?? '');
        definePattern(node.childForFieldName('name'), ctx, isConst ? 'constant' : 'variable');
        const value = node.childForFieldName('value');
        if (value) ctx.walk(value);
        const type = node.childForFieldName('type');
        if (type) ctx.walk(type);
        return true;
      },

      required_parameter: defineRequiredParameter,
      optional_parameter: defineRequiredParameter,

      type_parameter(node, ctx) {
        const name = node.childForFieldName('name');
        if (name) ctx.define(name, { nameNode: name, kind: 'type' });
        for (const f of ['constraint', 'default_type', 'value']) {
          const c = node.childForFieldName(f);
          if (c) ctx.walk(c);
        }
        return true;
      },

      function_signature(node, ctx) {
        const name = node.childForFieldName('name');
        if (name) ctx.define(node, { nameNode: name, kind: 'function' });
        const params = node.childForFieldName('parameters');
        if (params) {
          ctx.enterScope(
            node,
            { kind: 'function', fixedName: name ? name.text : 'fn' },
            name ? name.text : null,
          );
          defineParams(params, ctx);
          const ret = node.childForFieldName('return_type');
          if (ret) ctx.walk(ret);
          ctx.exitScope();
        }
        return true;
      },

      public_field_definition: defineClassField,
      field_definition: defineClassField,

      property_signature(node, ctx) {
        const name = node.childForFieldName('name');
        if (name) ctx.define(node, { nameNode: name, kind: 'property' });
        const type = node.childForFieldName('type');
        if (type) ctx.walk(type);
        return true;
      },

      type_alias_declaration(node, ctx) {
        const name = node.childForFieldName('name');
        if (name) ctx.define(node, { nameNode: name, kind: 'type' });
        const value = node.childForFieldName('value');
        if (value) ctx.walk(value);
        return true;
      },

      enum_body(node, ctx) {
        for (const child of node.namedChildren as any[]) {
          if (child.type === 'enum_assignment') {
            const name = child.childForFieldName('name');
            if (name) ctx.define(name, { nameNode: name, kind: 'enumMember' });
            const value = child.childForFieldName('value');
            if (value) ctx.walk(value);
          } else if (child.type === 'property_identifier') {
            ctx.define(child, { nameNode: child, kind: 'enumMember' });
          } else {
            ctx.walk(child);
          }
        }
        return true;
      },

      pair(node, ctx) {
        const key = node.childForFieldName('key');
        const value = node.childForFieldName('value');
        if (key && (key.type === 'shorthand_property_identifier' || key.type === 'computed_property_name')) {
          ctx.walk(key);
        }
        if (value) ctx.walk(value);
        return true;
      },

      pair_pattern(node, ctx) {
        definePattern(node.childForFieldName('value'), ctx);
        const key = node.childForFieldName('key');
        if (key && key.type === 'computed_property_name') ctx.walk(key);
        return true;
      },

      export_specifier(node, ctx) {
        const name = node.childForFieldName('name');
        if (name) ctx.walk(name);
        return true;
      },

      member_expression(node, ctx) {
        const parts = memberParts(node);
        const property = node.childForFieldName('property');
        if (parts && property) {
          ctx.addRef(node, { parts, rangeNode: property, text: node.text });
        }
        const object = node.childForFieldName('object');
        if (object) ctx.walk(object);
        return true;
      },

      import_statement(node, ctx) {
        const source = node.childForFieldName('source');
        const specifier = source ? source.text.replace(/^['"`]|['"`]$/g, '') : '';
        const clause = (node.namedChildren as any[]).find((c: any) => c.type === 'import_clause');
        if (!clause) return true;
        for (const child of clause.namedChildren as any[]) {
          switch (child.type) {
            case 'identifier':
              ctx.addImport({
                localName: child.text, module: specifier, kind: 'default', range: ctx.rangeOf(child),
              });
              ctx.addRef(child, { kind: 'import', name: child.text });
              break;
            case 'namespace_import': {
              const ns = (child.namedChildren as any[]).find((c: any) => c.type === 'identifier');
              if (ns) {
                ctx.addImport({
                  localName: ns.text, module: specifier, kind: 'namespace', range: ctx.rangeOf(ns),
                });
                ctx.addRef(ns, { kind: 'import', name: ns.text });
              }
              break;
            }
            case 'named_imports':
              for (const spec of child.namedChildren as any[]) {
                if (spec.type !== 'import_specifier') continue;
                const nameNode = spec.childForFieldName('name');
                const alias = spec.childForFieldName('alias');
                const local = alias ?? nameNode;
                if (!local) continue;
                ctx.addImport({
                  localName: local.text,
                  module: specifier,
                  importedName: nameNode ? nameNode.text : '',
                  kind: 'named',
                  range: ctx.rangeOf(local),
                });
                ctx.addRef(local, { kind: 'import', name: local.text });
              }
              break;
            default:
              break;
          }
        }
        return true;
      },

      jsx_opening_element(node, ctx) {
        const name = node.childForFieldName('name');
        if (name) ctx.walk(name);
        for (const a of node.namedChildren as any[]) {
          if (a.type === 'jsx_attribute' || a.type === 'jsx_expression') ctx.walk(a);
        }
        return true;
      },

      jsx_self_closing_element(node, ctx) {
        const name = node.childForFieldName('name');
        if (name) ctx.walk(name);
        for (const a of node.namedChildren as any[]) {
          if (a.type === 'jsx_attribute' || a.type === 'jsx_expression') ctx.walk(a);
        }
        return true;
      },

      jsx_closing_element() {
        return true;
      },

      jsx_attribute(node, ctx) {
        const value = node.childForFieldName('value');
        if (value) ctx.walk(value);
        return true;
      },
    },

    identifierTypes: ['identifier', 'type_identifier', 'shorthand_property_identifier'],

    isReference(node) {
      const parent = node.parent;
      if (!parent) return false;
      if (parent.type === 'labeled_statement') return false;
      if (node.type === 'shorthand_property_identifier') {
        return parent.type === 'pair' || parent.type === 'object_pattern';
      }
      return true;
    },

    builtins: JS_GLOBALS,

    commentTypes: ['comment'],

    /** L6：数字 / 字符串字面量（不包含布尔 / null，它们既是字面量也是标识符）。 */
    literalTypes: {
      number: 'number',
      string: 'string',
    },

    /** L6：只有变量 / 字段 / 枚举成员 / 赋值的 value / right 位置才算绑定。 */
    valueContainers: {
      variable_declarator: ['value'],
      public_field_definition: ['value'],
      field_definition: ['value'],
      property_signature: ['value'],
      enum_assignment: ['value'],
      assignment_expression: ['right'],
    },

    /** L6：下标 / 元素访问 `config["k"]`（该语法包用 subscript_expression）。 */
    indexAccess: {
      subscript_expression: { object: 'object', key: 'index' },
    },

    decoratorsOf: tsDecorators,
    basesOf: tsBases,

    params: defineParams,

    resolveModule: tsResolveModule,
  };
}

export function makeTsLanguages(): LanguageSpec[] {
  const typescript = makeTsSpec(
    'typescript',
    'TypeScript',
    TypeScript.typescript,
    ['.ts', '.d.ts', '.mts', '.cts'],
  );
  const tsx = makeTsSpec('tsx', 'TypeScript JSX', TypeScript.tsx, ['.tsx']);
  const javascript = makeTsSpec('javascript', 'JavaScript', JavaScript, ['.js', '.mjs', '.cjs']);
  const jsx = makeTsSpec('jsx', 'JavaScript JSX', TypeScript.tsx, ['.jsx']);
  return [typescript, tsx, javascript, jsx];
}
