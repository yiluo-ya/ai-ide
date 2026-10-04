/**
 * 会话导入 / 导出（agentExport.ts）：md 与 html 两种记录都要能独立看懂，
 * 且导出文件里不带 agent 写的脚本。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from './agentApi';
import { sessionFilename, sessionToHtml, sessionToMarkdown, stamp } from './agentExport';

const at = new Date(2026, 9, 3, 18, 20);

const messages: AgentMessage[] = [
  { role: 'user', content: '看看 build 脚本' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先读 package.json' },
      { type: 'text', text: '## 结论\n\n用 **npm run build**。\n\n```json\n{"a":1}\n```' },
      { type: 'toolCall', name: 'read_file', arguments: { path: 'package.json' } },
    ],
  },
  { role: 'toolResult', toolName: 'read_file', content: '{"scripts":{}}' },
];

describe('stamp / sessionFilename', () => {
  it('时间戳补零', () => {
    expect(stamp(new Date(2026, 9, 3, 8, 5))).toBe('2026-10-03 08:05');
  });

  it('文件名保留中文，空格换 -', () => {
    expect(sessionFilename('修复 build 脚本', 'md', at)).toBe('agent-session-修复-build-脚本-20261003-1820.md');
    expect(sessionFilename('修复 build 脚本', 'html', at).endsWith('.html')).toBe(true);
  });
});

describe('sessionToMarkdown', () => {
  it('带元信息与逐条消息', () => {
    const md = sessionToMarkdown({ name: '会话 A', projectName: 'demo', projectRoot: 'D:/demo', messages, at });
    expect(md.startsWith('# 会话 A')).toBe(true);
    expect(md).toContain('- 项目: demo (D:/demo)');
    expect(md).toContain('- 消息: 3');
    expect(md).toContain('## 我');
    expect(md).toContain('看看 build 脚本');
    expect(md).toContain('## Agent');
    expect(md).toContain('npm run build');
    expect(md).toContain('<details><summary>思考</summary>');
    expect(md).toContain('2026-10-03 18:20');
  });

  it('思考与工具内容缩进成代码块：里面的围栏不会破坏格式', () => {
    const md = sessionToMarkdown({
      name: 's',
      messages: [{ role: 'toolResult', toolName: 'read_file', content: '```\ncode\n```' }],
      at,
    });
    expect(md).toContain('    ```\n    code\n    ```');
  });
});

describe('sessionToHtml', () => {
  it('输出完整文档，正文按 Markdown 渲染，脚本已被清掉', () => {
    const html = sessionToHtml({
      name: 's',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '正文\n\n<script>alert(1)</script>' }] }],
      at,
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>s</title>');
    expect(html).toContain('正文');
    expect(html).not.toContain('<script');
  });

  it('用户消息按原文（不解析 Markdown），特殊字符已转义', () => {
    const html = sessionToHtml({ name: 's', messages: [{ role: 'user', content: '<b>x</b>' }], at });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
