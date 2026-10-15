import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyPrefs, loadPrefs } from './prefs';
import './styles.css';
// 打印样式：原来由「分享」下拉（ShareMenu）引入，分享入口去掉后改在这里全局加载 ——
// 直接 Ctrl/Cmd+P 打印时仍然只出代码，不出界面（2026-10-15 需求 13）。
import './print.css';

// P24：先把偏好写到 :root（主题 / 字号 / 侧栏宽 / 语言），避免首帧闪一下再跳
applyPrefs(loadPrefs());

const host = document.getElementById('root');
if (!host) throw new Error('#root not found');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
