/**
 * FR-0011：命令拼装与按 shell 转义。
 *
 * 钉住三类容易悄悄错的事：
 * 1) PowerShell 里绝对路径的解释器必须 `& '…'`（否则只是把字符串打印出来）；
 * 2) Git Bash 里反斜杠要转正斜杠，`cmd /c` 要写成 `cmd //c`（MSYS 会把 `/c` 当盘符路径改写）；
 * 3) 不认识的语言一律 null（界面置灰），不做路径兜底。
 */
import { describe, expect, it } from 'vitest';
import { buildRunCommand, extensionOf, isRunnable, runnerFor } from './runCommand';

const WIN_PY = 'D:\\proj\\.venv\\Scripts\\python.exe';

describe('extensionOf / runnerFor', () => {
  it('取小写扩展名，隐藏文件与无扩展名不算', () => {
    expect(extensionOf('src/a.PY')).toBe('py');
    expect(extensionOf('a/b/c.Js')).toBe('js');
    expect(extensionOf('.env')).toBe('');
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('src/noext')).toBe('');
  });

  it('只认可直接解释执行的语言', () => {
    expect(runnerFor('a.py')).toEqual(['python']);
    expect(runnerFor('a.go')).toEqual(['go', 'run']);
    expect(runnerFor('a.sh')).toEqual(['bash']);
    expect(isRunnable('a.py')).toBe(true);
    // 需要编译 / 没有运行器
    expect(runnerFor('a.ts')).toBeNull();
    expect(runnerFor('a.java')).toBeNull();
    expect(runnerFor('a.md')).toBeNull();
    expect(isRunnable('a.java')).toBe(false);
  });
});

describe('buildRunCommand', () => {
  it('Python 无指定解释器 → 裸 python + 相对路径', () => {
    expect(buildRunCommand({ file: 'src/a.py', shellKind: 'powershell' })).toBe('python src/a.py');
    expect(buildRunCommand({ file: 'src/a.py', shellKind: 'gitbash' })).toBe(`python 'src/a.py'`);
  });

  it('PowerShell：绝对路径解释器前置 & 并用单引号', () => {
    expect(buildRunCommand({ file: 'src/a.py', shellKind: 'powershell', pythonPath: WIN_PY })).toBe(
      `& '${WIN_PY}' src/a.py`,
    );
  });

  it('Git Bash：反斜杠转正斜杠', () => {
    expect(buildRunCommand({ file: 'src/a.py', shellKind: 'gitbash', pythonPath: WIN_PY })).toBe(
      `'D:/proj/.venv/Scripts/python.exe' 'src/a.py'`,
    );
  });

  it('路径含空格 / 括号 / 单引号时按 shell 正确转义', () => {
    expect(buildRunCommand({ file: 'src/a b.js', shellKind: 'powershell' })).toBe(`node 'src/a b.js'`);
    expect(buildRunCommand({ file: 'src/a(b).js', shellKind: 'powershell' })).toBe(`node 'src/a(b).js'`);
    expect(buildRunCommand({ file: `it's.py`, shellKind: 'powershell' })).toBe(`python 'it''s.py'`);
    expect(buildRunCommand({ file: `it's.py`, shellKind: 'gitbash' })).toBe(`python 'it'\\''s.py'`);
  });

  it('其它语言的命令前缀', () => {
    expect(buildRunCommand({ file: 'main.go', shellKind: 'powershell' })).toBe('go run main.go');
    expect(buildRunCommand({ file: 'tool.ps1', shellKind: 'powershell' })).toBe('powershell -File tool.ps1');
    expect(buildRunCommand({ file: 'run.sh', shellKind: 'gitbash' })).toBe(`bash 'run.sh'`);
    expect(buildRunCommand({ file: 'app.rb', shellKind: 'powershell' })).toBe('ruby app.rb');
  });

  it('Git Bash 下 cmd /c 要写 //c（MSYS 不把 /c 当路径改写）', () => {
    expect(buildRunCommand({ file: 'build.bat', shellKind: 'gitbash' })).toBe(`cmd //c 'build.bat'`);
    expect(buildRunCommand({ file: 'build.bat', shellKind: 'powershell' })).toBe('cmd /c build.bat');
  });

  it('不认识的文件返回 null', () => {
    expect(buildRunCommand({ file: 'src/a.ts', shellKind: 'powershell' })).toBeNull();
    expect(buildRunCommand({ file: 'README.md', shellKind: 'gitbash' })).toBeNull();
  });
});
