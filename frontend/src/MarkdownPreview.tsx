/**
 * Markdown 预览（2026-10-23 用户要求「md 格式要有预览模式」）。
 *
 * 复用 `markdown.ts` 的 `mdToHtml`（marked 解析 + DOMPurify 清洗）与
 * `htmlPreviewDoc`（套基础样式、跟随系统深浅色），渲染进沙箱 iframe：
 * sandbox 不给 allow-scripts，文档里的脚本 / 外链不会被浏览器执行。
 */
import { useMemo } from 'react';
import { htmlPreviewDoc, mdToHtml } from './markdown';
import { usePrefs } from './prefs';

export function MarkdownPreview({ text }: { text: string }) {
  const { fontSize } = usePrefs();
  const doc = useMemo(() => htmlPreviewDoc(mdToHtml(text), fontSize), [text, fontSize]);

  return (
    <div className="reader-panel reader-md">
      <iframe className="reader-md-frame" title="Markdown preview" sandbox="allow-same-origin" srcDoc={doc} />
    </div>
  );
}