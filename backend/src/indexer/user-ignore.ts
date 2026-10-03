/**
 * 设置面板里的「自定义忽略规则」（2026-10-03 用户要求）：对所有项目生效的额外排除规则。
 *
 * 为什么不写进项目根：工具不写被读目录，所以这份规则只能放在自己的数据目录里
 * （`DATA_DIR/ignore-user.txt`，可用 READER_USER_IGNORE 覆盖，测试用）。
 * 语法与 .gitignore 一致（`dir/`、`*.log`、`!` 取反），由 IgnoreMatcher 解析。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config';
import { setUserIgnoreRules } from './ignore';

export function userIgnoreFile(): string {
  return process.env.READER_USER_IGNORE ?? path.join(DATA_DIR, 'ignore-user.txt');
}

export async function readUserIgnore(): Promise<string> {
  try {
    return await fsp.readFile(userIgnoreFile(), 'utf8');
  } catch {
    return '';
  }
}

/** 写盘并立即装进判定器；已建好的索引要重建才反映新规则。 */
export async function writeUserIgnore(text: string): Promise<void> {
  const file = userIgnoreFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
  setUserIgnoreRules(text);
}

/** 启动时把已存的规则装进判定器（要在建任何项目索引之前调用）。 */
export async function primeUserIgnore(): Promise<void> {
  setUserIgnoreRules(await readUserIgnore());
}
