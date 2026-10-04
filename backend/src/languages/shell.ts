/** Shell 语言模块（tree-sitter-bash）：函数 / 变量定义 + `source` 依赖。 */
import Bash from 'tree-sitter-bash';
import type { LanguageSpec, ModuleCandidate } from '../indexer/walker';
import { dirname, joinRel } from '../indexer/paths';

/** 去掉引号（`source "./x.sh"` 与 `source ./x.sh` 都要能解析）。 */
const unquote = (text: string): string => text.replace(/^["']|["']$/g, '');

/** `source` / `.` 的实参：第一个参数节点即为被引入的文件。 */
function sourcedPath(node: any): string | null {
  const name = node.childForFieldName('name');
  if (!name) return null;
  const args = (node.namedChildren as any[]).filter((c) => c !== name);
  const first = args[0];
  if (!first) return null;
  if (first.type !== 'word' && first.type !== 'string' && first.type !== 'raw_string') return null;
  return unquote(String(first.text ?? ''));
}

export const shell: LanguageSpec = {
  id: 'shell',
  label: 'Shell',
  extensions: ['.sh', '.bash', '.zsh'],
  monaco: 'shell',
  fence: 'bash',
  color: '#89e051',
  refs: true,
  commentPrefixes: ['#'],
  grammar: Bash,

  scopes: {
    function_definition: { kind: 'function', nameFields: ['name'], defKind: 'function' },
    // 函数体 / 控制流块是同一个「局部」作用域：函数里定义的变量归到函数名下
    compound_statement: { kind: 'block' },
  },

  handlers: {
    variable_assignment(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'variable' });
      const value = node.childForFieldName('value');
      if (value) ctx.walk(value);
      return true;
    },

    command(node, ctx) {
      const name = node.childForFieldName('name');
      const command = name?.text ?? '';
      if (command === 'source' || command === '.') {
        const specifier = sourcedPath(node);
        // 只记相对路径：`/etc/profile`、`$HOME/x.sh` 这类本机 / 环境相关的不进依赖图
        if (specifier && !specifier.startsWith('/') && !specifier.includes('$')) {
          const first = (node.namedChildren as any[]).find((c) => c !== name);
          ctx.addImport({
            localName: specifier.split('/').pop()?.replace(/\.[^.]+$/, '') ?? specifier,
            module: specifier,
            kind: 'module',
            range: first ? ctx.rangeOf(first) : ctx.rangeOf(node),
          });
          return true;
        }
      }
      // 命令名当作引用：`greet` 能跳到同名函数定义（内置命令解析不到，安静地落在 unresolved）
      const word = (name?.namedChildren as any[] | undefined)?.find((c: any) => c.type === 'word');
      if (word) ctx.addRef(word, { name: word.text, text: node.text });
      for (const child of node.namedChildren as any[]) {
        if (child !== name) ctx.walk(child);
      }
      return true;
    },
  },

  /** 变量读取（`$APP_NAME` / `${PORT}`）算引用；`$1` / `$@` 这类位置参数不是名字。 */
  identifierTypes: ['variable_name'],
  isReference: (node) => /^[A-Za-z_]\w*$/.test(String(node.text ?? '')),

  commentTypes: ['comment'],

  literalTypes: {
    string: 'string',
    raw_string: 'string',
    number: 'number',
  },

  /** `source ./lib/x.sh` → 相对当前文件的路径。 */
  resolveModule(specifier: string, fromFile: string): ModuleCandidate[] | null {
    if (!specifier) return null;
    return [{ path: joinRel(dirname(fromFile), specifier), kind: 'file' }];
  },
};
