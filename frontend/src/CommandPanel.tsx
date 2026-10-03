/**
 * 命令面板（2026-10-03 用户要求：命令管理 —— 启动服务 / 停止服务 / 重启）。
 *
 * 能做的事只有三件，且都只针对「阅读器后端自己」：
 * 看状态（pid / 端口 / 运行时长 / 日志路径）、重启、停止。停止之后没法从界面再启动
 * （服务已经不在跑了），所以按钮文案里直接写清「停了要自己去命令行 npm start」。
 *
 * 安全边界：共享模式（HOST 不是本机）下后端会 403，这里据 status.manageable 禁用全部按钮；
 * 危险的都走二次确认对话框。
 */
import { useEffect, useState } from 'react';
import type { ServiceStatus } from '../../shared/types';
import { Dialog } from './Dialog';
import { api } from './api';
import './service.css';

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function CommandPanel() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'restart' | 'stop' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    try {
      setStatus(await api.serviceStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    // 运行时长每秒自己走，不用每次请求后端
    const timer = window.setInterval(() => {
      setStatus((s) => (s ? { ...s, uptimeMs: Date.now() - s.startedAt } : s));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const run = async (kind: 'restart' | 'stop') => {
    setConfirm(null);
    setBusy(true);
    setNote(null);
    try {
      const res = kind === 'restart' ? await api.serviceRestart() : await api.serviceStop();
      setNote(res.note ?? '已执行');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const manageable = status?.manageable ?? false;

  return (
    <div className="service-panel">
      <div className="sv-head">
        <h3>命令 · 服务</h3>
        <button className="btn ghost small" onClick={() => void load()} disabled={busy}>
          刷新状态
        </button>
      </div>

      {error && (
        <div className="sv-error" role="alert">
          {error}
        </div>
      )}

      {status && (
        <dl className="sv-facts">
          <div>
            <dt>状态</dt>
            <dd>运行中</dd>
          </div>
          <div>
            <dt>进程</dt>
            <dd>pid {status.pid}</dd>
          </div>
          <div>
            <dt>监听</dt>
            <dd>
              {status.host}:{status.port}
            </dd>
          </div>
          <div>
            <dt>运行时长</dt>
            <dd>{fmtDuration(status.uptimeMs)}</dd>
          </div>
          <div>
            <dt>日志</dt>
            <dd className="sv-path" title={status.logPath}>
              {status.logPath}
            </dd>
          </div>
          {status.lastAction && (
            <div>
              <dt>上次动作</dt>
              <dd>
                {status.lastAction.action} · {new Date(status.lastAction.at).toLocaleTimeString()}
              </dd>
            </div>
          )}
        </dl>
      )}

      {!manageable && status && (
        <div className="sv-note">共享模式下不提供命令管理（只读阅读），按钮已禁用。</div>
      )}

      <div className="sv-actions">
        <button className="btn" disabled={!manageable || busy} onClick={() => setConfirm('restart')}>
          重启服务
        </button>
        <button className="btn ghost" disabled={!manageable || busy} onClick={() => setConfirm('stop')}>
          停止服务
        </button>
      </div>

      {note && <div className="sv-note">{note}</div>}

      <div className="sv-hint">
        重启会先停掉当前进程、再用同一条命令拉起来（日志追加到上面的文件）。
        停止后界面就没法再启动它了 —— 回到命令行跑 <code>npm start</code>。
      </div>

      {confirm && (
        <Dialog title={confirm === 'restart' ? '重启服务？' : '停止服务？'} onClose={() => setConfirm(null)}>
          <p className="confirm-text">
            {confirm === 'restart'
              ? '当前进程会退出，随后由独立 worker 拉起新进程（约 2~5 秒）。这段时间页面上的请求会失败，稍后刷新即可。'
              : '服务会立即退出，之后这个页面就打不开了。要重新启动，请在命令行运行 npm start。'}
          </p>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setConfirm(null)}>
              取消
            </button>
            <button className="btn" onClick={() => void run(confirm)}>
              {confirm === 'restart' ? '重启' : '停止'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
