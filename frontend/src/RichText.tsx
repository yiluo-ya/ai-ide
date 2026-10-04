/**
 * 会话内容的富文本组件（2026-10-03 用户要求：会话内容支持 md 与 html 展示）。
 *
 * 三种块：
 * - Markdown 段：`markdown.ts` 解析 + 清洗后的 HTML，内联渲染；
 * - 代码块：语言标签 + 复制按钮（代码原样，不做语法解析）；
 * - HTML 块：沙箱 iframe 预览（可切源码）。
 *
 * 逻辑都在 `markdown.ts`（纯函数、有测试），这里只做视图与交互。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { htmlPreviewDoc, splitBlocks, type MdBlock } from './markdown';
import { usePrefs } from './prefs';
import { copyText } from './report';

/** 预览 iframe 的高度区间：内容自适应，超出就内部滚动。 */
const FRAME_MIN = 80;
const FRAME_MAX = 460;

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-lang">{lang || t('md.plainText')}</span>
        <button className="md-btn" onClick={() => void copy()}>
          {copied ? t('md.copied') : t('md.copy')}
        </button>
      </div>
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function HtmlBlock({ html }: { html: string }) {
  const { t } = useI18n();
  // 预览是独立文档，拿不到父页面的 CSS 变量：把当前界面字号显式传进去（跟设置里的「字号」一起变）
  const { fontSize } = usePrefs();
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => htmlPreviewDoc(html, fontSize), [html, fontSize]);

  // 内容变了先把高度收回去，等 iframe 重新加载后再按新内容量高
  useEffect(() => {
    if (view === 'preview' && frameRef.current) frameRef.current.style.height = `${FRAME_MIN}px`;
  }, [doc, view]);

  const copy = async () => {
    if (await copyText(html)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-lang">HTML</span>
        <div className="md-tabs">
          <button className={`md-btn${view === 'preview' ? ' on' : ''}`} onClick={() => setView('preview')}>
            {t('md.preview')}
          </button>
          <button className={`md-btn${view === 'source' ? ' on' : ''}`} onClick={() => setView('source')}>
            {t('md.source')}
          </button>
          <button className="md-btn" onClick={() => void copy()}>
            {copied ? t('md.copied') : t('md.copy')}
          </button>
        </div>
      </div>
      {view === 'preview' ? (
        <iframe
          ref={frameRef}
          className="md-frame"
          /* 关键：不给 allow-scripts —— agent 输出的脚本不执行；allow-same-origin 只为按内容测高 */
          sandbox="allow-same-origin"
          srcDoc={doc}
          title={t('md.htmlPreview')}
          onLoad={() => {
            const el = frameRef.current;
            const inner = el?.contentDocument?.documentElement;
            if (!el || !inner) return;
            el.style.height = `${Math.min(FRAME_MAX, Math.max(FRAME_MIN, inner.scrollHeight + 8))}px`;
          }}
        />
      ) : (
        <pre className="md-pre">
          <code>{html}</code>
        </pre>
      )}
    </div>
  );
}

function BlockView({ block }: { block: MdBlock }) {
  if (block.kind === 'md') return <div className="md-part" dangerouslySetInnerHTML={{ __html: block.html }} />;
  if (block.kind === 'html') return <HtmlBlock html={block.html} />;
  return <CodeBlock lang={block.lang} code={block.code} />;
}

/** 把一段会话文本画成富文本。`text` 为空时不渲染任何东西。 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  if (blocks.length === 0) return null;
  return (
    <div className={`md${className ? ` ${className}` : ''}`}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}
