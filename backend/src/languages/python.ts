/** Python 语言模块：定义 / 引用提取 + 模块解析。 */
import Python from 'tree-sitter-python';
import type { BaseInfo, DecoratorInfo, LanguageSpec, ModuleCandidate, ModuleHint } from '../indexer/walker';
import { WalkContext } from '../indexer/walker';
import { joinRel } from '../indexer/paths';
import { readHintFile } from '../config';
import type { SymbolKind } from '../types';

const PY_SELF = new Set(['self', 'cls']);

/** 赋值 / 循环 / with / except 的目标：标识符→定义，成员或下标→按引用走。 */
function defineTarget(node: any, ctx: WalkContext, kind: SymbolKind = 'variable') {
  if (!node) return;
  switch (node.type) {
    case 'identifier':
      ctx.define(node, { nameNode: node, kind });
      return;
    case 'attribute': {
      // `self.x = ...` 记成所属类的属性定义，这样 self.x 的读取能跨方法解析到它
      const object = node.childForFieldName('object');
      const attribute = node.childForFieldName('attribute');
      const cls = ctx.enclosing(['class']);
      if (object?.type === 'identifier' && PY_SELF.has(object.text) && attribute && cls) {
        ctx.defineIn(cls, attribute, { nameNode: attribute, kind: 'property' });
        return;
      }
      ctx.walk(node);
      return;
    }
    case 'pattern_list':
    case 'tuple_pattern':
    case 'list_pattern':
      for (const c of node.namedChildren as any[]) defineTarget(c, ctx, kind);
      return;
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern': {
      const id = (node.namedChildren as any[]).find((c) => c.type === 'identifier');
      if (id) ctx.define(id, { nameNode: id, kind });
      return;
    }
    default:
      ctx.walk(node);
  }
}

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** `os.path.join` → ['os','path','join']；拆不开（如对象来自函数调用）时返回 null。 */
function memberParts(node: any): string[] | null {
  if (node.type !== 'attribute') return null;
  const object = node.childForFieldName('object');
  const attribute = node.childForFieldName('attribute');
  if (!attribute) return null;
  if (object?.type === 'identifier') return [object.text, attribute.text];
  if (object?.type === 'attribute') {
    const base = memberParts(object);
    return base ? [...base, attribute.text] : null;
  }
  return null;
}

const firstSegment = (dotted: string): string => dotted.split('.')[0];

/** 去掉字符串字面量的引号前缀（可能带 r / b / f 等前缀）。 */
function stripStringLiterals(text: string): string {
  const m = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(text);
  if (!m) return text;
  const quote = m[2];
  let body = text.slice(m[0].length);
  if (body.endsWith(quote)) body = body.slice(0, -quote.length);
  return body;
}

/** L4a：函数 / 类 body 的第一个语句是字符串字面量时，它就是 docstring。 */
function pythonDocstring(node: any): string | null {
  if (node.type !== 'function_definition' && node.type !== 'class_definition') return null;
  const body = node.childForFieldName('body');
  if (!body || body.type !== 'block') return null;
  const first = (body.namedChildren as any[])[0];
  if (!first || first.type !== 'expression_statement') return null;
  const expr = (first.namedChildren as any[])[0];
  if (!expr || expr.type !== 'string') return null;
  return stripStringLiterals(expr.text);
}

/** L7：装饰器挂在 function / class 的父节点 decorated_definition 上。 */
function pythonDecorators(node: any): DecoratorInfo[] | null {
  const parent = node.parent;
  if (!parent || parent.type !== 'decorated_definition') return null;
  const out: DecoratorInfo[] = [];
  for (const c of parent.namedChildren as any[]) {
    if (c.type !== 'decorator') continue;
    out.push({
      text: c.text.replace(/\s+/g, ' ').trim(),
      startLine: c.startPosition.row + 1,
      endLine: c.endPosition.row + 1,
    });
  }
  return out.length ? out : null;
}

/**
 * 显式基类（N17）：`class A(Base, mixins.M):` 里的 superclasses。
 * 只读语法：元类 / 关键字实参（metaclass=...）不算基类；动态改基类无法从 AST 看出，不覆盖。
 */
function pythonBases(node: any): BaseInfo[] | null {
  if (node.type !== 'class_definition') return null;
  const sup = node.childForFieldName('superclasses');
  if (!sup) return null;
  const out: BaseInfo[] = [];
  for (const c of (sup.namedChildren ?? []) as any[]) {
    if (c.type === 'keyword_argument') continue;
    if (c.type === 'identifier' || c.type === 'attribute') out.push({ name: c.text, kind: 'extends' });
  }
  return out.length ? out : null;
}

const PY_BUILTINS = new Set([
  'self', 'cls', 'None', 'True', 'False', 'print', 'len', 'range', 'str', 'int', 'float',
  'bool', 'list', 'dict', 'set', 'tuple', 'type', 'super', 'isinstance', 'issubclass', 'open',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'sum', 'min', 'max', 'abs', 'any', 'all',
  'getattr', 'setattr', 'hasattr', 'repr', 'format', 'iter', 'next', 'id', 'hash', 'input',
  'bytes', 'bytearray', 'frozenset', 'object', 'property', 'staticmethod', 'classmethod',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError',
  'StopIteration', 'NotImplementedError', 'AttributeError', 'ImportError', 'OSError',
  'ZeroDivisionError', 'AssertionError', 'FileNotFoundError', 'NotImplemented', 'Ellipsis',
  'globals', 'locals', 'vars', 'dir', 'callable', 'divmod', 'round', 'pow', 'reversed',
  'slice', 'complex', 'memoryview', 'exec', 'eval', 'compile', '__name__', '__file__',
  '__main__', 'exit', 'quit',
]);

export const python: LanguageSpec = {
  id: 'python',
  label: 'Python',
  extensions: ['.py'],
  monaco: 'python',
  fence: 'python',
  color: '#3572a5',
  refs: true,
  commentPrefixes: ['#'],
  signatureStyle: 'colon',
  signatureColon: true,
  entryPatterns: [
    { res: [/__name__\s*==\s*['"]__main__['"]/], reason: 'Python 的 __main__ 块' },
  ],
  grammar: Python,

  scopes: {
    function_definition: { kind: 'function', nameFields: ['name'], defKind: 'function' },
    class_definition: { kind: 'class', nameFields: ['name'], defKind: 'class' },
    lambda: { kind: 'function', fixedName: 'lambda' },
    list_comprehension: { kind: 'block', fixedName: 'comprehension' },
    set_comprehension: { kind: 'block', fixedName: 'comprehension' },
    dictionary_comprehension: { kind: 'block', fixedName: 'comprehension' },
    generator_expression: { kind: 'block', fixedName: 'comprehension' },
  },

  identifierTypes: ['identifier'],

  handlers: {
    parameters(node, ctx) {
      for (const child of node.namedChildren as any[]) {
        switch (child.type) {
          case 'identifier':
            ctx.define(child, { nameNode: child, kind: 'parameter' });
            break;
          case 'default_parameter':
          case 'typed_default_parameter': {
            const name = child.childForFieldName('name');
            if (name) ctx.define(name, { nameNode: name, kind: 'parameter' });
            const value = child.childForFieldName('value');
            if (value) ctx.walk(value);
            const type = child.childForFieldName('type');
            if (type) ctx.walk(type);
            break;
          }
          case 'typed_parameter': {
            (child.namedChildren as any[]).forEach((c, i) => {
              if (i === 0 && c.type === 'identifier') {
                ctx.define(c, { nameNode: c, kind: 'parameter' });
              } else {
                ctx.walk(c);
              }
            });
            break;
          }
          case 'list_splat_pattern':
          case 'dictionary_splat_pattern': {
            const id = (child.namedChildren as any[]).find((c: any) => c.type === 'identifier');
            if (id) ctx.define(id, { nameNode: id, kind: 'parameter' });
            break;
          }
          default:
            ctx.walk(child);
        }
      }
      return true;
    },

    assignment(node, ctx) {
      defineTarget(node.childForFieldName('left'), ctx);
      const right = node.childForFieldName('right');
      if (right) ctx.walk(right);
      const type = node.childForFieldName('type');
      if (type) ctx.walk(type);
      return true;
    },

    augmented_assignment(node, ctx) {
      const left = node.childForFieldName('left');
      if (left) ctx.walk(left);
      const right = node.childForFieldName('right');
      if (right) ctx.walk(right);
      return true;
    },

    named_expression(node, ctx) {
      defineTarget(node.childForFieldName('name'), ctx);
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      return true;
    },

    for_statement(node, ctx) {
      defineTarget(node.childForFieldName('left'), ctx);
      for (const field of ['right', 'body', 'alternative']) {
        const c = node.childForFieldName(field);
        if (c) ctx.walk(c);
      }
      return true;
    },

    for_in_clause(node, ctx) {
      defineTarget(node.childForFieldName('left'), ctx);
      const right = node.childForFieldName('right');
      if (right) ctx.walk(right);
      return true;
    },

    as_pattern(node, ctx) {
      const children = node.namedChildren as any[];
      children.forEach((c, i) => {
        if (i === children.length - 1 && c.type === 'identifier') {
          ctx.define(c, { nameNode: c, kind: 'variable' });
        } else {
          defineTarget(c, ctx);
        }
      });
      return true;
    },

    with_item(node, ctx) {
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      defineTarget(node.childForFieldName('alias'), ctx);
      return true;
    },

    except_clause(node, ctx) {
      const children = node.namedChildren as any[];
      children.forEach((c, i) => {
        if (i === children.length - 1 && c.type === 'identifier') {
          ctx.define(c, { nameNode: c, kind: 'variable' });
        } else {
          ctx.walk(c);
        }
      });
      return true;
    },

    keyword_argument(node, ctx) {
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      return true;
    },

    import_statement(node, ctx) {
      for (const child of node.namedChildren as any[]) {
        if (child.type === 'aliased_import') {
          const name = child.childForFieldName('name');
          const alias = child.childForFieldName('alias');
          if (name) {
            ctx.addImport({
              localName: alias ? alias.text : firstSegment(name.text),
              module: name.text,
              kind: 'module',
              range: alias ? ctx.rangeOf(alias) : ctx.rangeOf(name),
            });
            if (alias) ctx.addRef(alias, { kind: 'import', name: alias.text });
          }
        } else if (child.type === 'dotted_name') {
          ctx.addImport({
            localName: firstSegment(child.text),
            module: child.text,
            kind: 'module',
            range: ctx.rangeOf(child),
          });
        }
      }
      return true;
    },

    import_from_statement(node, ctx) {
      const moduleNode = node.childForFieldName('module_name');
      const moduleText = moduleNode ? moduleNode.text : '';
      for (const child of node.namedChildren as any[]) {
        if (
          moduleNode &&
          child.startIndex === moduleNode.startIndex &&
          child.endIndex === moduleNode.endIndex
        ) {
          continue;
        }
        if (child.type === 'wildcard_import') {
          ctx.addImport({ localName: '*', module: moduleText, kind: 'star', range: ctx.rangeOf(child) });
          continue;
        }
        if (child.type === 'aliased_import') {
          const name = child.childForFieldName('name');
          const alias = child.childForFieldName('alias');
          const importedName = name ? name.text : '';
          const localName = alias ? alias.text : firstSegment(importedName);
          ctx.addImport({
            localName,
            module: moduleText,
            importedName,
            kind: 'named',
            range: alias ? ctx.rangeOf(alias) : ctx.rangeOf(name ?? child),
          });
          ctx.addRef(alias ?? name ?? child, { kind: 'import', name: localName });
          continue;
        }
        if (child.type === 'dotted_name' || child.type === 'identifier') {
          const importedName = child.text;
          const localName = firstSegment(importedName);
          ctx.addImport({
            localName,
            module: moduleText,
            importedName,
            kind: 'named',
            range: ctx.rangeOf(child),
          });
          ctx.addRef(child, { kind: 'import', name: localName });
        }
      }
      return true;
    },

    future_import_statement() {
      return true;
    },

    attribute(node, ctx) {
      const parts = memberParts(node);
      if (!parts) return false;
      ctx.addRef(node, {
        parts,
        rangeNode: node.childForFieldName('attribute'),
        text: node.text,
      });
      const object = node.childForFieldName('object');
      if (object) ctx.walk(object);
      return true;
    },
  },

  builtins: PY_BUILTINS,

  commentTypes: ['comment'],

  /** L6：值字面量（布尔 / None 不列，它们既是字面量也是标识符）。 */
  literalTypes: {
    integer: 'number',
    float: 'number',
    string: 'string',
  },

  /** L6：`X = 30` 与 `def f(x: int = 30)` 的默认值算「直接值」。 */
  valueContainers: {
    assignment: ['right'],
    typed_default_parameter: ['value'],
  },

  /** L6：下标访问 `cfg["k"]`（键字段是 `subscript`，切片 `a[1:2]` 的键不是字面量）。 */
  indexAccess: {
    subscript: { object: 'value', key: 'subscript' },
  },

  decoratorsOf: pythonDecorators,
  docstringOf: pythonDocstring,
  basesOf: pythonBases,
  resolveModule(specifier: string, fromFile: string, hint?: ModuleHint): ModuleCandidate[] | null {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    const rest = dots ? specifier.slice(dots) : specifier;
    const parts = rest.split('.').filter(Boolean);
    let baseDir = dirname(fromFile);
    for (let i = 0; i < Math.max(dots - 1, 0); i++) baseDir = dirname(baseDir);
    const rel = [...(baseDir ? baseDir.split('/').filter(Boolean) : []), ...parts].join('/');
    const seen = new Set<string>();
    const out: ModuleCandidate[] = [];
    const push = (p: string) => {
      if (!p || p.startsWith('..')) return;
      for (const candidate of [`${p}.py`, `${p}/__init__.py`]) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        out.push({ path: candidate, kind: 'file' });
      }
    };
    // 绝对导入（`import pkg.x`）按 Python 的 sys.path 语义从项目根 / src 布局解析；
    // 相对导入（`.x` / `..x`）仍按当前文件目录。
    if (dots === 0 && hint) {
      for (const root of pythonImportRoots(hint)) push(joinRel(root, ...parts));
    }
    push(rel);
    return out.length ? out : null;
  },

  moduleSpecifierOf(relFile: string): string | null {
    let p = relFile.replace(/\.py$/, '');
    if (p.endsWith('/__init__')) p = p.slice(0, -'/__init__'.length);
    return p.split('/').join('.');
  },
};

// ---------------------------------------------------------------- src 布局（P10）

/**
 * 绝对导入的解析根（相对项目根，按优先级）：
 * pyproject 的 `[tool.setuptools] package-dir` → 项目根 → 探测到的 `src/` 布局。
 */
function pythonImportRoots(hint: ModuleHint): string[] {
  const out: string[] = [];
  for (const d of pyprojectPackageDirs(hint)) out.push(d);
  out.push('');
  if (!out.includes('src') && hasSrcLayout(hint)) out.push('src');
  return [...new Set(out)];
}

/** `[tool.setuptools] package-dir = {"" = "src"}` 与 `[tool.setuptools.package-dir]` 段两种写法。 */
function pyprojectPackageDirs(hint: ModuleHint): string[] {
  const text = readHintFile(hint, 'pyproject.toml');
  if (text === null) return [];
  const dirs: string[] = [];
  const inline = /package-dir\s*=\s*\{([^}]*)\}/.exec(text);
  if (inline) {
    for (const m of inline[1].matchAll(/["']?[\w.-]*["']?\s*=\s*["']([^"']+)["']/g)) dirs.push(joinRel(m[1]));
  }
  const section = /\[tool\.setuptools\.package-dir\]\s*\r?\n([\s\S]*?)(?=\r?\n\[|$)/.exec(text);
  if (section) {
    for (const m of section[1].matchAll(/^\s*["']?[\w.-]*["']?\s*=\s*["']([^"']+)["']/gm)) {
      dirs.push(joinRel(m[1]));
    }
  }
  return [...new Set(dirs)];
}

/** src 布局探测：根有 `src/`，且其中至少有一个包（`__init__.py`）。 */
function hasSrcLayout(hint: ModuleHint): boolean {
  if (!hint.exists('src')) return false;
  for (const f of hint.files()) {
    if (f.startsWith('src/') && f.endsWith('__init__.py')) return true;
  }
  return false;
}
