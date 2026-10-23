/**
 * 阅读模式面板（2026-10-23）：给图片 / 音视频 / PDF / Office 等二进制文件一个浏览器预览视图。
 *
 * - 图片 / 音视频 / PDF：走 `/raw` 流式字节 + 浏览器原生元素（<img> / <video> / <audio> / <iframe>）。
 * - Office（docx / xlsx）：fetch raw 字节后前端解析（mammoth / SheetJS）渲染成 HTML，进沙箱 iframe。
 * - 其余 office（pptx / odt 等）：占位 + 在资源管理器打开。
 */
import { useEffect, useState } from 'react';
import { useI18n } from './i18n';
import { api } from './api';
import { useStore, type ReaderKind } from './state';
import { htmlPreviewDoc, sanitizeHtml } from './markdown';
import { usePrefs } from './prefs';

/** Office 解析：按扩展名把 raw 字节转成 HTML（docx/xlsx），或返回 null（不支持的类型）。 */
async function officeToHtml(file: string, buf: ArrayBuffer): Promise<string | null> {
  if (/\.docx$/i.test(file)) {
    const mammoth = (await import('mammoth')).default;
    const res = await mammoth.convertToHtml({ arrayBuffer: buf });
    return res.value;
  }
  if (/\.xlsx$/i.test(file)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'array' });
    const first = wb.SheetNames[0];
    if (!first) return null;
    return XLSX.utils.sheet_to_html(wb.Sheets[first]);
  }
  return null;
}

function OfficePreview({ projectId, file }: { projectId: string; file: string }) {
  const { t } = useI18n();
  const { fontSize } = usePrefs();
  const revealEntry = useStore((s) => s.revealEntry);
  const [state, setState] = useState<'loading' | 'html' | 'unsupported' | 'error'>('loading');
  const [html, setHtml] = useState('');

  useEffect(() => {
    const url = api.rawUrl(projectId, file);
    const controller = new AbortController();
    setState('loading');
    setHtml('');
    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          setState('error');
          return;
        }
        const buf = await res.arrayBuffer();
        const out = await officeToHtml(file, buf);
        if (out == null) {
          setState('unsupported');
          return;
        }
        setHtml(sanitizeHtml(out));
        setState('html');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, [projectId, file]);

  if (state === 'loading') {
    return (
      <div className="reader-panel reader-unsupported">
        <div className="reader-unsupported-file">{t('reader.loading', { file })}</div>
      </div>
    );
  }
  if (state === 'html') {
    const doc = htmlPreviewDoc(html, fontSize);
    return (
      <div className="reader-panel reader-md" title={file}>
        <iframe className="reader-md-frame" title={file} sandbox="allow-same-origin" srcDoc={doc} />
      </div>
    );
  }
  // unsupported（pptx / odt 等）与 error（解析失败）都落到占位，只是文案不同
  return (
    <div className="reader-panel reader-unsupported">
      <div className="reader-unsupported-icon">📄</div>
      <div className="reader-unsupported-file">{file}</div>
      <p className="reader-unsupported-hint">
        {state === 'error' ? t('reader.officeError') : t('reader.officeHint')}
      </p>
      <button className="btn" onClick={() => void revealEntry(file)}>
        {t('reader.openInExplorer')}
      </button>
    </div>
  );
}

export function FileReaderPanel({
  projectId,
  file,
  kind,
}: {
  projectId: string;
  file: string;
  kind: ReaderKind;
}) {
  const url = api.rawUrl(projectId, file);

  if (kind === 'image') {
    return (
      <div className="reader-panel reader-image" title={file}>
        <img src={url} alt={file} draggable={false} />
      </div>
    );
  }
  if (kind === 'video') {
    return (
      <div className="reader-panel reader-video" title={file}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={url} controls playsInline />
      </div>
    );
  }
  if (kind === 'audio') {
    return (
      <div className="reader-panel reader-audio" title={file}>
        <div className="reader-audio-meta">{file}</div>
        <audio src={url} controls />
      </div>
    );
  }
  if (kind === 'pdf') {
    return (
      <div className="reader-panel reader-pdf" title={file}>
        <iframe src={url} title={file} />
      </div>
    );
  }
  // office：docx / xlsx 前端解析渲染，其余占位
  return <OfficePreview projectId={projectId} file={file} />;
}