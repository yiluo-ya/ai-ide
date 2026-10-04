/**
 * 会话富文本渲染的纯函数测试（markdown.ts）：
 * 渲染正确性 + 清洗边界（脚本 / 事件属性 / 内联样式 / javascript: 链接）+ 块切分。
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  htmlPreviewDoc,
  isHtmlDocument,
  looksRichText,
  mdToHtml,
  sanitizeHtml,
  splitBlocks,
} from './markdown';

describe('mdToHtml', () => {
  it('渲染标题 / 列表 / 表格', () => {
    const html = mdToHtml('# 标题\n\n- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<h1');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<table>');
  });

  it('链接新窗口打开（不把 IDE 页面顶掉）', () => {
    const html = mdToHtml('[站点](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('挡掉脚本 / 事件属性 / javascript: 链接 / 内联样式', () => {
    expect(mdToHtml('<script>alert(1)</script>')).not.toContain('<script');
    expect(mdToHtml('<img src=x onerror="alert(1)">')).not.toContain('onerror');
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    expect(sanitizeHtml('<div style="position:fixed;inset:0">x</div>')).not.toContain('position:fixed');
    expect(sanitizeHtml('<iframe src="https://example.com"></iframe>')).not.toContain('<iframe');
  });
});

describe('isHtmlDocument', () => {
  it('只认「文档 / 带样式片段」', () => {
    expect(isHtmlDocument('<!doctype html><html><body>x</body></html>')).toBe(true);
    expect(isHtmlDocument('<html><body>x</body></html>')).toBe(true);
    expect(isHtmlDocument('<style>a{color:red}</style>')).toBe(true);
    expect(isHtmlDocument('<div class="x">hi</div>')).toBe(false);
    expect(isHtmlDocument('<table><tr><td>1</td></tr></table>')).toBe(false);
  });
});

describe('splitBlocks', () => {
  it('按顶层切成 md / 代码块 / html 块', () => {
    const text = ['# 标题', '', '```ts', 'const a = 1;', '```', '', '```html', '<div>hi</div>', '```', '', '正文'].join(
      '\n',
    );
    const blocks = splitBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(['md', 'code', 'html', 'md']);
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', code: 'const a = 1;' });
    expect(blocks[2]).toEqual({ kind: 'html', html: '<div>hi</div>' });
  });

  it('代码块里的 # 与 * 不会被当 Markdown', () => {
    const blocks = splitBlocks('```sh\n# 注释\n* x\n```');
    expect(blocks).toEqual([{ kind: 'code', lang: 'sh', code: '# 注释\n* x' }]);
  });

  it('裸 HTML 文档进 html 块，零散标签仍走 md 段（内联清洗）', () => {
    expect(splitBlocks('<!doctype html><html><body><p>x</p></body></html>')[0].kind).toBe('html');
    expect(splitBlocks('<div>hi</div>')[0].kind).toBe('md');
  });
});

describe('looksRichText', () => {
  it('日志 / 文件清单 / JSON 不触发', () => {
    expect(looksRichText('src/a.ts:12: error TS2322')).toBe(false);
    expect(looksRichText('- src/a.ts\n- src/b.ts')).toBe(false);
    expect(looksRichText('{"a":1}')).toBe(false);
    expect(looksRichText('普通两行\n第二行')).toBe(false);
  });

  it('Markdown 结构 / HTML 文档触发', () => {
    expect(looksRichText('## 结论\n\n都通过。')).toBe(true);
    expect(looksRichText('见 **文档**')).toBe(true);
    expect(looksRichText('```ts\nconst a = 1;\n```')).toBe(true);
    expect(looksRichText('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true);
    expect(looksRichText('<html><body>x</body></html>')).toBe(true);
  });
});

describe('htmlPreviewDoc', () => {
  it('片段补成完整文档，并注入基础样式', () => {
    const doc = htmlPreviewDoc('<p>hi</p>');
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<p>hi</p>');
    expect(doc).toContain('prefers-color-scheme');
  });

  it('完整文档保留原内容，样式插在 head 最前（用户样式能覆盖）', () => {
    const doc = htmlPreviewDoc('<!doctype html><html><head><title>t</title></head><body>x</body></html>');
    expect(doc).toContain('<title>t</title>');
    expect(doc.indexOf('<style>')).toBeGreaterThan(doc.indexOf('<head>'));
    expect(doc.indexOf('<style>')).toBeLessThan(doc.indexOf('<title>'));
  });
});

describe('escapeHtml', () => {
  it('转义四个字符', () => {
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });
});
