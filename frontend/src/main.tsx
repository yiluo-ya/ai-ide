import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyPrefs, loadPrefs } from './prefs';
import './styles.css';

// P24：先把偏好写到 :root（主题 / 字号 / 侧栏宽 / 语言），避免首帧闪一下再跳
applyPrefs(loadPrefs());

const host = document.getElementById('root');
if (!host) throw new Error('#root not found');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
