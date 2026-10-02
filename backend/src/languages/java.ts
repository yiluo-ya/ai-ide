/** Java 语言模块：定义 / 引用提取 + 基于类名索引的 import 解析。 */
import Java from 'tree-sitter-java';
import type { BaseInfo, DecoratorInfo, LanguageSpec, WalkContext } from '../indexer/walker';
import type { SymbolKind } from '../types';

const JAVA_BUILTINS = new Set([
  'int', 'long', 'short', 'byte', 'char', 'float', 'double', 'boolean', 'void', 'var',
  'String', 'Object', 'System', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character',
  'Math', 'Thread', 'Runnable', 'Exception', 'RuntimeException', 'Error', 'Throwable',
  'List', 'Map', 'Set', 'ArrayList', 'HashMap', 'HashSet', 'Optional', 'Stream', 'Iterable',
  'Override', 'Deprecated', 'SuppressWarnings', 'Objects', 'Arrays', 'Collections',
  'StringBuilder', 'Comparable', 'Comparator', 'this', 'super', 'null', 'true', 'false',
]);

/** 形参：`int a` / `String... xs`。 */
function defineParameter(node: any, ctx: WalkContext) {
  const name = node.childForFieldName('name');
  if (name) ctx.define(name, { nameNode: name, kind: 'parameter' });
  const type = node.childForFieldName('type');
  if (type) ctx.walk(type);
  for (const c of node.namedChildren as any[]) {
    if (c.type === 'dimensions') ctx.walk(c);
  }
  return true;
}

function defineLambdaParams(node: any, ctx: WalkContext) {
  if (node.type === 'identifier') {
    ctx.define(node, { nameNode: node, kind: 'parameter' });
    return;
  }
  if (node.type === 'inferred_parameters') {
    for (const c of node.namedChildren as any[]) {
      if (c.type === 'identifier') ctx.define(c, { nameNode: c, kind: 'parameter' });
    }
    return;
  }
  for (const c of node.namedChildren as any[]) {
    if (c.type === 'formal_parameter' || c.type === 'spread_parameter') ctx.walk(c);
    else if (c.type === 'identifier') ctx.define(c, { nameNode: c, kind: 'parameter' });
  }
}

/** 处理 `obj.name` / `name` 两类访问，object 简单时记为成员引用，否则先走 object。 */
function handleAccess(node: any, ctx: WalkContext, objectField: string, nameField: string) {
  const object = node.childForFieldName(objectField);
  const name = node.childForFieldName(nameField);
  let recorded = false;
  if (object && name) {
    const simple =
      object.type === 'identifier' ||
      object.type === 'this' ||
      object.type === 'super' ||
      object.type === 'type_identifier';
    if (simple) {
      ctx.addRef(node, {
        parts: [object.text, name.text],
        rangeNode: name,
        text: node.text.split('(')[0],
      });
      recorded = true;
    }
  }
  if (object && !recorded) ctx.walk(object);
  if (!recorded && name) ctx.addRef(name);
  for (const c of node.namedChildren as any[]) {
    if (c.type === 'argument_list' || c.type === 'type_arguments') ctx.walk(c);
  }
  return true;
}

/** L7：注解挂在 modifiers 下（`@Transactional` 是 annotation，`@Deprecated` 是 marker_annotation）。 */
function javaDecorators(node: any): DecoratorInfo[] | null {
  const modifiers = (node.namedChildren as any[]).find((c: any) => c.type === 'modifiers');
  if (!modifiers) return null;
  const out: DecoratorInfo[] = [];
  for (const c of modifiers.namedChildren as any[]) {
    if (c.type !== 'annotation' && c.type !== 'marker_annotation') continue;
    out.push({
      text: c.text.replace(/\s+/g, ' ').trim(),
      startLine: c.startPosition.row + 1,
      endLine: c.endPosition.row + 1,
    });
  }
  return out.length ? out : null;
}

/** 继承 / 实现里的类型名：`List<Foo>` 只取 `List`。 */
function typeNameOf(node: any): string | null {
  if (!node) return null;
  if (node.type === 'type_identifier' || node.type === 'identifier' || node.type === 'scoped_type_identifier') {
    return node.text;
  }
  if (node.type === 'generic_type') {
    const name = node.childForFieldName('name') ?? (node.namedChildren as any[])[0];
    return typeNameOf(name);
  }
  return null;
}

/** 容器节点（type_list / super_interfaces / extends_interfaces …）里的所有类型名。 */
function typeNamesIn(node: any, out: string[]) {
  for (const c of (node.namedChildren ?? []) as any[]) {
    const name = typeNameOf(c);
    if (name) out.push(name);
    else typeNamesIn(c, out);
  }
}

/**
 * 显式继承 / 实现（N17）：`extends B implements C, D`。
 * 只读 AST：泛型实参、匿名类、动态代理不算；方法级 override 关系不做推断。
 */
function javaBases(node: any): BaseInfo[] | null {
  const kinds = ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'];
  if (!kinds.includes(node.type)) return null;
  const out: BaseInfo[] = [];
  const sup = node.childForFieldName('superclass');
  if (sup) {
    const names: string[] = [];
    typeNamesIn(sup, names);
    for (const n of names) out.push({ name: n, kind: 'extends' });
  }
  const ifaces = node.childForFieldName('interfaces');
  if (ifaces) {
    const names: string[] = [];
    typeNamesIn(ifaces, names);
    for (const n of names) out.push({ name: n, kind: 'implements' });
  }
  for (const c of node.namedChildren as any[]) {
    if (c.type !== 'extends_interfaces') continue; // interface A extends B, C
    const names: string[] = [];
    typeNamesIn(c, names);
    for (const n of names) out.push({ name: n, kind: 'extends' });
  }
  return out.length ? out : null;
}

export const java: LanguageSpec = {
  id: 'java',
  label: 'Java',
  extensions: ['.java'],
  grammar: Java,

  scopes: {
    class_declaration: { kind: 'class', nameFields: ['name'], defKind: 'class' },
    interface_declaration: { kind: 'class', nameFields: ['name'], defKind: 'interface' },
    enum_declaration: { kind: 'class', nameFields: ['name'], defKind: 'enum' },
    record_declaration: { kind: 'class', nameFields: ['name'], defKind: 'struct' },
    annotation_type_declaration: { kind: 'class', nameFields: ['name'], defKind: 'interface' },
    method_declaration: {
      kind: 'function', nameFields: ['name'], defKind: 'method', paramFields: ['parameters'],
    },
    constructor_declaration: {
      kind: 'function', nameFields: ['name'], defKind: 'constructor', paramFields: ['parameters'],
    },
    compact_constructor_declaration: {
      kind: 'function', nameFields: ['name'], defKind: 'constructor',
    },
    lambda_expression: { kind: 'function', fixedName: 'lambda', paramFields: ['parameters'] },
    block: { kind: 'block' },
    static_initializer: { kind: 'block', fixedName: 'static' },
    constructor_body: { kind: 'block', fixedName: 'constructor' },
  },

  handlers: {
    package_declaration(node, ctx) {
      const id = (node.namedChildren as any[]).find(
        (c: any) => c.type === 'scoped_identifier' || c.type === 'identifier',
      );
      if (id) ctx.meta.packageName = id.text;
      return true;
    },

    import_declaration(node, ctx) {
      const text = node.text;
      const isStatic = /\bstatic\b/.test(text);
      const isWildcard = node.namedChildren.some((c: any) => c.type === 'asterisk');
      const scoped = (node.namedChildren as any[]).find(
        (c: any) => c.type === 'scoped_identifier' || c.type === 'identifier',
      );
      if (!scoped) return true;
      const parts = scoped.text.split('.');
      if (isWildcard) {
        ctx.addImport({
          localName: '*',
          module: parts.join('.'),
          kind: 'star',
          range: ctx.rangeOf(scoped),
        });
        return true;
      }
      const localName = parts[parts.length - 1];
      ctx.addImport({
        localName,
        module: parts.join('.'),
        importedName: localName,
        kind: isStatic ? 'named' : 'named',
        range: ctx.rangeOf(scoped),
      });
      return true;
    },

    variable_declarator(node, ctx) {
      const parent = node.parent;
      let kind: SymbolKind = 'variable';
      if (parent?.type === 'field_declaration') kind = 'field';
      else if (parent?.type === 'annotation_type_element_declaration') kind = 'method';
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind });
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      const dims = node.childForFieldName('dimensions');
      if (dims) ctx.walk(dims);
      return true;
    },

    field_declaration(node, ctx) {
      const type = node.childForFieldName('type');
      if (type) ctx.walk(type);
      for (const c of node.namedChildren as any[]) {
        if (c.type === 'variable_declarator') ctx.walk(c);
        else if (c.type === 'dimensions') ctx.walk(c);
      }
      return true;
    },

    local_variable_declaration(node, ctx) {
      const type = node.childForFieldName('type');
      if (type) ctx.walk(type);
      for (const c of node.namedChildren as any[]) {
        if (c.type === 'variable_declarator') ctx.walk(c);
        else if (c.type === 'dimensions') ctx.walk(c);
      }
      return true;
    },

    formal_parameter: defineParameter,
    spread_parameter: defineParameter,
    catch_formal_parameter: defineParameter,

    enhanced_for_statement(node, ctx) {
      const type = node.childForFieldName('type');
      if (type) ctx.walk(type);
      const name = node.childForFieldName('name');
      if (name) ctx.define(name, { nameNode: name, kind: 'variable' });
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      const body = node.childForFieldName('body');
      if (body) ctx.walk(body);
      return true;
    },

    resource(node, ctx) {
      const type = node.childForFieldName('type');
      if (type) ctx.walk(type);
      const name = node.childForFieldName('name');
      if (name) ctx.define(name, { nameNode: name, kind: 'variable' });
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      return true;
    },

    enum_constant(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'enumMember' });
      for (const c of node.namedChildren as any[]) {
        if (c.type === 'argument_list' || c.type === 'enum_body_declarations' || c.type === 'class_body') {
          ctx.walk(c);
        }
      }
      return true;
    },

    annotation_type_element_declaration(node, ctx) {
      const type = node.childForFieldName('type');
      if (type) ctx.walk(type);
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'method' });
      for (const c of node.namedChildren as any[]) {
        if (c.type === 'dimensions') ctx.walk(c);
      }
      return true;
    },

    method_invocation(node, ctx) {
      return handleAccess(node, ctx, 'object', 'name');
    },

    field_access(node, ctx) {
      return handleAccess(node, ctx, 'object', 'field');
    },

    method_reference(node, ctx) {
      const name = node.childForFieldName('name');
      const object = (node.namedChildren as any[]).find(
        (c: any) => c.type === 'identifier' || c.type === 'type_identifier',
      );
      if (object && name) {
        ctx.addRef(node, { parts: [object.text, name.text], rangeNode: name, text: node.text });
      } else if (name) {
        ctx.addRef(name);
      }
      return true;
    },
  },

  identifierTypes: ['identifier', 'type_identifier'],

  params: defineLambdaParams,
  builtins: JAVA_BUILTINS,
  classBasedImports: true,

  commentTypes: ['line_comment', 'block_comment'],

  /** L6：Java 的数值 / 字符 / 字符串字面量（true / false / null 不列）。 */
  literalTypes: {
    decimal_integer_literal: 'number',
    hex_integer_literal: 'number',
    octal_integer_literal: 'number',
    binary_integer_literal: 'number',
    decimal_floating_point_literal: 'number',
    hex_floating_point_literal: 'number',
    string_literal: 'string',
    character_literal: 'other',
  },

  /** L6：字段 / 局部变量的 `= 30` 位置才算绑定。 */
  valueContainers: {
    variable_declarator: ['value'],
  },

  /** L6：数组下标 `arr[0]`（Java 没有下标取 Map，键只可能是数组下标）。 */
  indexAccess: {
    array_access: { object: 'array', key: 'index' },
  },

  decoratorsOf: javaDecorators,
  basesOf: javaBases,

  resolveModule() {
    return null;
  },
};
