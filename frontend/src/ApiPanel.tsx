/**
 * API 面板（FR-0001）：精简 Post 工具，挂在右侧活动栏 `api` 视图。
 *
 * 数据源是项目根 `.api/` 目录（后端 `readApiTree` 返回树），本组件只做：
 *   1) 目录树展示（多层递归）+ 新建目录 / 接口
 *   2) 顶部环境选择（切换 `environments.json` 的 active）
 *   3) 点接口弹窗编辑 method/url/headers/body，发送后展示 response
 *   4) 导出 postman / swagger
 *
 * 变量替换在**前端**完成：发送前把 url/headers/body 里的 `{{key}}` 换成 active 环境的值，
 * 后端 `send` 只做纯转发（绕过 CORS）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiAuth,
  ApiEnvironment,
  ApiEnvironments,
  ApiRequestDef,
  ApiSendResult,
  ApiTreeNode,
  ApiTreeResult,
} from '../../shared/types';
import { api } from './api';
import { Dialog } from './Dialog';
import { translate, useI18n } from './i18n';
import { showToast } from './state';
import './apipanel.css';

/** 把文本里的 `{{key}}` 换成变量表里的值；找不到保留原样。 */
function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
}

/** 把 JSON 文本美化（缩进 2 空格）；非 JSON 原样返回。 */
function prettyJson(text: string): string {
  if (!text) return text;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 递归替换对象里的所有字符串（body 的深拷贝）。 */
function substituteDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return substitute(value, vars);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substituteDeep(v, vars);
    return out;
  }
  return value;
}

/** 在行上右键时触发 NodeMenu 打开。挂到行的 onContextMenu。 */
function triggerRowMenu(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const btn = (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('.api-menu-wrap > button');
  btn?.click();
}

function NodeMenu({
  items,
}: {
  items: Array<{ label: string; action: () => void; danger?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="api-menu-wrap" ref={ref}>
      <button
        className="api-icon-btn"
        type="button"
        title={translate('apiPanel.more')}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋮
      </button>
      {open && (
        <div className="api-dropdown" role="menu" onClick={() => setOpen(false)}>
          {items.map((item) => (
            <button
              key={item.label}
              className={`api-dropdown-item${item.danger ? ' danger' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** HTTP method 彩色标签。 */
function MethodTag({ method }: { method: string }) {
  const m = method.toUpperCase();
  const cls = m === 'GET' ? 'api-method-get' : m === 'POST' ? 'api-method-post' : m === 'DELETE' ? 'api-method-del' : m === 'PUT' || m === 'PATCH' ? 'api-method-put' : 'api-method-other';
  return <span className={`api-method-tag ${cls}`}>{m}</span>;
}

/** 递归过滤树：保留匹配的接口节点和它的祖先目录。 */
function filterTree(nodes: ApiTreeNode[], query: string): ApiTreeNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  const walk = (items: ApiTreeNode[]): ApiTreeNode[] => {
    const out: ApiTreeNode[] = [];
    for (const n of items) {
      if (n.type === 'dir') {
        const children = walk(n.children ?? []);
        if (children.length > 0 || n.name.toLowerCase().includes(q)) {
          out.push({ ...n, children });
        }
      } else if (n.name.toLowerCase().includes(q) || (n.method ?? '').toLowerCase().includes(q)) {
        out.push(n);
      }
    }
    return out;
  };
  return walk(nodes);
}

/** 树节点：递归渲染（目录展开 / 接口点击）。操作挂节点上，hover 出现。 */
function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  onOpen,
  onAddApi,
  onAddDir,
  onDelete,
  onRename,
  onCopy,
  onMove,
  onClone,
  isRoot,
  onExport,
}: {
  node: ApiTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (node: ApiTreeNode) => void;
  onAddApi: (parentPath: string) => void;
  onAddDir: (parentPath: string) => void;
  onDelete: (node: ApiTreeNode) => void;
  onRename: (node: ApiTreeNode) => void;
  /** 复制接口到其他目录。 */
  onCopy?: (node: ApiTreeNode) => void;
  /** 移动接口到其他目录。 */
  onMove?: (node: ApiTreeNode) => void;
  /** 克隆接口到当前目录。 */
  onClone?: (node: ApiTreeNode) => void;
  /** 是否根节点（root，不可删；带导出菜单）。 */
  isRoot?: boolean;
  onExport?: (format: 'postman' | 'swagger') => void;
}) {
  const { t } = useI18n();

  if (node.type === 'dir') {
    const open = expanded.has(node.path);
    const menuItems: Array<{ label: string; action: () => void; danger?: boolean }> = [];
    menuItems.push({ label: t('apiPanel.newApi'), action: () => onAddApi(node.path) });
    menuItems.push({ label: t('apiPanel.newDir'), action: () => onAddDir(node.path) });
    if (onExport) {
      menuItems.push({ label: t('apiPanel.exportPostman'), action: () => onExport('postman') });
      menuItems.push({ label: t('apiPanel.exportSwagger'), action: () => onExport('swagger') });
    }
    if (!isRoot) {
      if (onClone) menuItems.push({ label: t('apiPanel.clone'), action: () => onClone(node) });
      menuItems.push({ label: t('apiPanel.rename'), action: () => onRename(node) });
      menuItems.push({ label: t('apiPanel.deleteDir'), action: () => onDelete(node), danger: true });
    }
    return (
      <>
        <div className="api-row api-dir" style={{ paddingLeft: depth * 14 }} onClick={() => onToggle(node.path)} onContextMenu={triggerRowMenu}>
          <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
          <span className="api-dir-icon">📁</span>
          <span className="api-name">{node.name}</span>
          <span className="api-node-actions">
            <button className="api-icon-btn" type="button" title={t('apiPanel.newApi')} onClick={(e) => { e.stopPropagation(); onAddApi(node.path); }}>+</button>
            <NodeMenu items={menuItems} />
          </span>
        </div>
        {open &&
          (node.children ?? []).map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
              onAddApi={onAddApi}
              onAddDir={onAddDir}
              onDelete={onDelete}
              onRename={onRename}
              onCopy={onCopy}
              onMove={onMove}
              onClone={onClone}
            />
          ))}
      </>
    );
  }

  if (node.type === 'request') {
    return (
      <div className="api-row api-req" style={{ paddingLeft: depth * 14 }} onContextMenu={triggerRowMenu}>
        {node.method && <MethodTag method={node.method} />}
        <button className="api-name api-open" type="button" onClick={() => onOpen(node)}>
          {node.name}
        </button>
        <span className="api-node-actions">
          <NodeMenu items={[
            ...(onCopy ? [{ label: t('apiPanel.copy'), action: () => onCopy(node) }] : []),
            ...(onMove ? [{ label: t('apiPanel.move'), action: () => onMove(node) }] : []),
            { label: t('apiPanel.rename'), action: () => onRename(node) },
            { label: t('apiPanel.deleteApi'), action: () => onDelete(node), danger: true },
          ]} />
        </span>
      </div>
    );
  }

  return (
    <div className="api-row api-file" style={{ paddingLeft: depth * 14 }}>
      <span className="api-name dim">{node.name}</span>
    </div>
  );
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** key-value 表格编辑器：headers 和 params 共用。 */
function PairEditor({
  pairs,
  onChange,
  keyPlaceholder,
  valPlaceholder,
}: {
  pairs: Array<{ key: string; value: string; enabled: boolean }>;
  onChange: (next: Array<{ key: string; value: string; enabled: boolean }>) => void;
  keyPlaceholder?: string;
  valPlaceholder?: string;
}) {
  const update = (i: number, patch: Partial<{ key: string; value: string; enabled: boolean }>) => {
    const next = pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
    onChange(next);
  };
  const add = () => onChange([...pairs, { key: '', value: '', enabled: true }]);
  const remove = (i: number) => onChange(pairs.filter((_, idx) => idx !== i));

  return (
    <div className="api-pair-editor">
      {pairs.map((p, i) => (
        <div key={i} className="api-pair-row">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => update(i, { enabled: e.target.checked })}
            title="enable / disable"
          />
          <input
            className="text-input api-pair-key"
            value={p.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder ?? 'Key'}
            spellCheck={false}
          />
          <input
            className="text-input api-pair-val"
            value={p.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valPlaceholder ?? 'Value'}
            spellCheck={false}
          />
          <button className="api-icon-btn" type="button" title="Remove" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <button className="api-pair-add" type="button" onClick={add}>+ Add</button>
    </div>
  );
}

/** 把 PairEditor 的 pairs 转成 Record<string,string>（只取 enabled 且 key 非空的）。 */
function pairsToRecord(pairs: Array<{ key: string; value: string; enabled: boolean }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    if (p.enabled && p.key.trim()) out[p.key.trim()] = p.value;
  }
  return out;
}

/** 把 Record<string,string> 转成 pairs。 */
function recordToPairs(obj: Record<string, string>): Array<{ key: string; value: string; enabled: boolean }> {
  return Object.entries(obj).map(([key, value]) => ({ key, value, enabled: true }));
}

/** 格式化字节数。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 接口编辑 / 发送弹窗（URL 栏 + Tab 页 + Response 区）。 */
function RequestDialog({
  projectId,
  def,
  initialPath,
  vars,
  onClose,
  onSaved,
}: {
  projectId: string;
  def: ApiRequestDef;
  initialPath: string;
  vars: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [method, setMethod] = useState(def.method.toUpperCase());
  const [url, setUrl] = useState(def.url);
  const [headerPairs, setHeaderPairs] = useState(() => recordToPairs(def.headers ?? {}));
  const [body, setBody] = useState(() =>
    def.body === undefined || def.body === null ? '' : typeof def.body === 'string' ? def.body : JSON.stringify(def.body, null, 2),
  );
  const [bodyType, setBodyType] = useState<'json' | 'text'>(() => {
    if (!body.trim()) return 'json';
    const t2 = body.trim();
    return t2.startsWith('{') || t2.startsWith('[') ? 'json' : 'text';
  });
  const [description, setDescription] = useState(def.description ?? '');
  const [auth, setAuth] = useState<ApiAuth>(def.auth ?? { type: 'none' });
  const [activeTab, setActiveTab] = useState<'body' | 'headers' | 'auth' | 'description'>('body');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ApiSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prettyBody, setPrettyBody] = useState(true);
  const [prettyResp, setPrettyResp] = useState(true);

  /** 把 auth 配置注入到 headers 和 url。 */
  const applyAuth = (rawUrl: string, rawHeaders: Record<string, string>): { url: string; headers: Record<string, string> } => {
    if (!auth || auth.type === 'none') return { url: rawUrl, headers: rawHeaders };
    const headers = { ...rawHeaders };
    let finalUrl = rawUrl;
    if (auth.type === 'basic') {
      const cred = btoa(`${substitute(auth.username ?? '', vars)}:${substitute(auth.password ?? '', vars)}`);
      headers['Authorization'] = `Basic ${cred}`;
    } else if (auth.type === 'bearer') {
      const prefix = (auth.prefix ?? 'Bearer').trim() || 'Bearer';
      const token = substitute(auth.token ?? '', vars);
      headers['Authorization'] = `${prefix} ${token}`.trim();
    } else if (auth.type === 'apikey') {
      const key = substitute(auth.key ?? '', vars);
      const val = substitute(auth.value ?? '', vars);
      if (key) {
        if (auth.location === 'query') {
          const sep = finalUrl.includes('?') ? '&' : '?';
          finalUrl = `${finalUrl}${sep}${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
        } else {
          headers[key] = val;
        }
      }
    }
    return { url: finalUrl, headers };
  };

  /** 构建发送用的 request（含变量替换 + auth 注入）。 */
  const buildRequest = (): { method: string; url: string; headers: Record<string, string>; body?: unknown } | null => {
    const parsedHeaders = pairsToRecord(headerPairs);
    let parsedBody: unknown;
    if (body.trim()) {
      if (bodyType === 'json') {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          setError(t('apiPanel.badJson'));
          return null;
        }
      } else {
        parsedBody = body;
      }
    }
    const subHeaders = Object.fromEntries(Object.entries(parsedHeaders).map(([k, v]) => [k, substitute(String(v), vars)]));
    const { url: authedUrl, headers: authedHeaders } = applyAuth(substitute(url, vars), subHeaders);
    return {
      method,
      url: authedUrl,
      headers: authedHeaders,
      ...(body.trim() ? { body: substituteDeep(parsedBody, vars) } : {}),
    };
  };

  const send = async () => {
    setError(null);
    setResult(null);
    const req = buildRequest();
    if (!req) return;
    setSending(true);
    try {
      setResult(await api.apiSend(projectId, { method: req.method, url: req.url, headers: req.headers, body: req.body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const save = async () => {
    setError(null);
    const parsedHeaders = pairsToRecord(headerPairs);
    let parsedBody: unknown;
    if (body.trim()) {
      if (bodyType === 'json') {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          setError(t('apiPanel.badJson'));
          return;
        }
      } else {
        parsedBody = body;
      }
    }
    const next: ApiRequestDef = {
      name: def.name,
      method,
      url,
      headers: parsedHeaders,
      ...(body.trim() ? { body: parsedBody } : {}),
      ...(description.trim() ? { description } : {}),
      ...(auth.type !== 'none' ? { auth } : {}),
    };
    try {
      await api.apiSave(projectId, { path: initialPath, content: JSON.stringify(next, null, 2) });
      showToast(t('apiPanel.saved'), true);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** URL 里替换后的预览值。 */
  const urlPreview = useMemo(() => substitute(url, vars), [url, vars]);

  /** response body 大小。 */
  const respSize = result ? new Blob([result.body]).size : 0;

  /** header 计数 badge。 */
  const headerCount = headerPairs.filter((p) => p.enabled && p.key.trim()).length;

  return (
    <Dialog title={def.name} onClose={onClose} wide>
      <div className="api-editor">
        {/* URL 栏：method 下拉 + URL 输入 + Send 按钮 */}
        <div className="api-url-bar">
          <select className="api-method-select" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            className="text-input api-url-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/api/path"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter' && !sending) void send(); }}
          />
          <button
            className={`btn api-send-btn${sending ? ' sending' : ''}`}
            disabled={sending}
            onClick={() => void send()}
          >
            {sending ? t('apiPanel.sending') : t('apiPanel.send')}
          </button>
        </div>
        {url !== urlPreview && (
          <div className="api-url-preview">{urlPreview}</div>
        )}

        {/* Tab 栏 */}
        <div className="api-tabs">
          <button className={`api-tab${activeTab === 'body' ? ' active' : ''}`} onClick={() => setActiveTab('body')}>
            {t('apiPanel.body')}
            <select
              className="api-body-type"
              value={bodyType}
              onChange={(e) => setBodyType(e.target.value as 'json' | 'text')}
              onClick={(e) => e.stopPropagation()}
            >
              <option value="json">JSON</option>
              <option value="text">Text</option>
            </select>
          </button>
          <button className={`api-tab${activeTab === 'headers' ? ' active' : ''}`} onClick={() => setActiveTab('headers')}>
            {t('apiPanel.headers')}
            {headerCount > 0 && <span className="api-tab-badge">{headerCount}</span>}
          </button>
          <button className={`api-tab${activeTab === 'auth' ? ' active' : ''}`} onClick={() => setActiveTab('auth')}>
            {t('apiPanel.auth')}
            {auth.type !== 'none' && <span className="api-tab-badge">{auth.type}</span>}
          </button>
          <button className={`api-tab${activeTab === 'description' ? ' active' : ''}`} onClick={() => setActiveTab('description')}>
            {t('apiPanel.description')}
          </button>
        </div>

        {/* Tab 内容 */}
        <div className="api-tab-content">
          {activeTab === 'body' && (
            <div className="api-body-editor">
              <div className="api-field-head">
                <span>{bodyType === 'json' ? 'JSON' : 'Text'}</span>
                {bodyType === 'json' && (
                  <button className="btn ghost small" type="button" onClick={() => setBody((b) => prettyJson(b))} title={t('apiPanel.prettify')}>
                    {t('apiPanel.prettify')}
                  </button>
                )}
              </div>
              <textarea
                className="api-editor-area api-body-area"
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
                placeholder={bodyType === 'json' ? '{"key": "value"}' : 'Request body'}
              />
            </div>
          )}
          {activeTab === 'headers' && (
            <PairEditor
              pairs={headerPairs}
              onChange={setHeaderPairs}
              keyPlaceholder="Content-Type"
              valPlaceholder="application/json"
            />
          )}
          {activeTab === 'auth' && (
            <div className="api-auth-editor">
              <select
                className="api-auth-select"
                value={auth.type}
                onChange={(e) => setAuth({ type: e.target.value as ApiAuth['type'] })}
              >
                <option value="none">No Auth</option>
                <option value="basic">Basic Auth</option>
                <option value="bearer">Bearer Token</option>
                <option value="apikey">API Key</option>
              </select>
              {auth.type === 'basic' && (
                <div className="api-auth-fields">
                  <input className="text-input" value={auth.username ?? ''} onChange={(e) => setAuth({ ...auth, username: e.target.value })} placeholder="Username" spellCheck={false} />
                  <input className="text-input" type="password" value={auth.password ?? ''} onChange={(e) => setAuth({ ...auth, password: e.target.value })} placeholder="Password" spellCheck={false} />
                </div>
              )}
              {auth.type === 'bearer' && (
                <div className="api-auth-fields">
                  <input className="text-input api-auth-prefix" value={auth.prefix ?? ''} onChange={(e) => setAuth({ ...auth, prefix: e.target.value })} placeholder="Bearer" spellCheck={false} />
                  <input className="text-input" type="password" value={auth.token ?? ''} onChange={(e) => setAuth({ ...auth, token: e.target.value })} placeholder="Token" spellCheck={false} />
                </div>
              )}
              {auth.type === 'apikey' && (
                <div className="api-auth-fields">
                  <select className="api-auth-location" value={auth.location ?? 'header'} onChange={(e) => setAuth({ ...auth, location: e.target.value as 'header' | 'query' })}>
                    <option value="header">Header</option>
                    <option value="query">Query Param</option>
                  </select>
                  <input className="text-input" value={auth.key ?? ''} onChange={(e) => setAuth({ ...auth, key: e.target.value })} placeholder={auth.location === 'query' ? 'param_name' : 'Header-Name'} spellCheck={false} />
                  <input className="text-input" type="password" value={auth.value ?? ''} onChange={(e) => setAuth({ ...auth, value: e.target.value })} placeholder="Value" spellCheck={false} />
                </div>
              )}
            </div>
          )}
          {activeTab === 'description' && (
            <textarea
              className="api-editor-area api-desc-area"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              spellCheck={false}
              placeholder={t('apiPanel.descPlaceholder')}
            />
          )}
        </div>

        {error && <div className="changes-error api-error">{error}</div>}

        {/* Response 区 */}
        {result && (
          <div className="api-response">
            <div className="api-response-head">
              <span className={`api-status-tag ${result.status >= 200 && result.status < 300 ? 'ok' : result.status < 400 ? 'redirect' : 'err'}`}>
                {result.status} {result.statusText}
              </span>
              <span className="api-meta-sep">•</span>
              <span className="api-duration">{result.durationMs} ms</span>
              <span className="api-meta-sep">•</span>
              <span className="api-size">{formatBytes(respSize)}</span>
              <button
                className="btn ghost small api-resp-toggle"
                type="button"
                onClick={() => setPrettyResp((v) => !v)}
                title={t(prettyResp ? 'apiPanel.showRaw' : 'apiPanel.prettify')}
              >
                {t(prettyResp ? 'apiPanel.showRaw' : 'apiPanel.prettify')}
              </button>
            </div>
            {result.error && <div className="api-error">{result.error}</div>}
            <div className="api-response-tabs">
              <div className="api-response-body-wrap">
                <div className="api-field-head">
                  <span>Body</span>
                  <button className="btn ghost small" type="button" onClick={() => setPrettyBody((v) => !v)} title={t(prettyBody ? 'apiPanel.showRaw' : 'apiPanel.prettify')}>
                    {t(prettyBody ? 'apiPanel.showRaw' : 'apiPanel.prettify')}
                  </button>
                </div>
                <pre className="api-response-body">{(prettyBody ? prettyJson(result.body) : result.body) || '(empty)'}</pre>
              </div>
              {Object.keys(result.headers).length > 0 && (
                <details className="api-response-headers">
                  <summary>Headers ({Object.keys(result.headers).length})</summary>
                  <div className="api-headers-list">
                    {Object.entries(result.headers).map(([k, v]) => (
                      <div key={k} className="api-header-row">
                        <span className="api-header-key">{k}</span>
                        <span className="api-header-val">{v}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>
        )}

        <div className="confirm-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn" disabled={sending} onClick={() => void save()}>
            {t('apiPanel.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function ApiPanel({ projectId: pid }: { projectId: string }) {
  const { t } = useI18n();
  const [tree, setTree] = useState<ApiTreeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 目录展开状态持久化到 localStorage（按项目隔离，root 默认展开）
  const EXPAND_KEY = `api:expanded:${pid}`;
  const [expanded, setExpandedRaw] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(EXPAND_KEY);
      if (saved) return new Set<string>(JSON.parse(saved));
    } catch { /* ignore */ }
    return new Set<string>(['']);
  });
  const setExpanded = (updater: (prev: Set<string>) => Set<string>) => {
    setExpandedRaw((prev) => {
      const next = updater(prev);
      try { localStorage.setItem(EXPAND_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  const [editing, setEditing] = useState<{ def: ApiRequestDef; path: string } | null>(null);
  const [newType, setNewType] = useState<'api' | 'dir' | null>(null);
  const [newName, setNewName] = useState('');
  const [newParentPath, setNewParentPath] = useState('');
  const [newMethod, setNewMethod] = useState<string>('GET');
  const [searchQuery, setSearchQuery] = useState('');
  const [renaming, setRenaming] = useState<ApiTreeNode | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [envEditOpen, setEnvEditOpen] = useState(false);
  // 复制/移动：选目标目录
  const [copyMove, setCopyMove] = useState<{ node: ApiTreeNode; mode: 'copy' | 'move' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.apiTree(pid);
      setTree(r);
      if (!r.initialized) {
        await api.apiEnsure(pid);
        setTree(await api.apiTree(pid));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pid]);

  useEffect(() => {
    void load();
  }, [load]);

  const env = useMemo(() => {
    const envs = tree?.environments?.environments ?? [];
    const active = tree?.environments?.active ?? '';
    const current = envs.find((e) => e.name === active) ?? envs[0] ?? null;
    return { envs, current };
  }, [tree]);

  const vars = env.current?.variables ?? {};

  const switchEnv = async (name: string) => {
    if (!tree?.environments) return;
    const next = { ...tree.environments, active: name };
    try {
      await api.apiSave(pid, { path: '', content: '', environments: next });
      setTree({ ...tree, environments: next });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const readDef = async (path: string): Promise<ApiRequestDef> => {
    const fallback = { name: path.split('/').pop()?.replace(/\.json$/, '') ?? path, method: 'GET', url: '' };
    try {
      const r = await api.fileText(pid, `.api/collections/${path}`);
      return { ...fallback, ...(JSON.parse(r.text) as ApiRequestDef) };
    } catch {
      return fallback;
    }
  };

  /** 搜索过滤后的树。 */
  const filteredTree = useMemo(
    () => (tree ? filterTree(tree.tree, searchQuery) : []),
    [tree, searchQuery],
  );

  /** 在某目录下新建接口/目录：弹出输入框，parentPath 已由点击的节点带入。 */
  const startNew = (type: 'api' | 'dir', parentPath: string) => {
    setNewType(type);
    setNewName('');
    setNewParentPath(parentPath);
    setNewMethod('GET');
  };

  /** 重命名：弹输入框。 */
  const startRename = (node: ApiTreeNode) => {
    setRenaming(node);
    setRenameVal(node.name);
  };

  /** 执行重命名：调后端 rename 端点（fs.rename，保留子节点）。 */
  const doRename = async () => {
    if (!renaming || !renameVal.trim()) return;
    const newNameTrim = renameVal.trim();
    try {
      if (renaming.type === 'request') {
        // 接口：旧路径去掉 .json → 改名 → 加 .json；后端同步更新 name 字段
        const dotIdx = renaming.path.lastIndexOf('.json');
        const base = dotIdx > 0 ? renaming.path.slice(0, dotIdx) : renaming.path;
        const parent = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
        const to = parent ? `${parent}/${newNameTrim}.json` : `${newNameTrim}.json`;
        await api.apiRename(pid, { from: renaming.path, to });
      } else {
        // 目录：旧路径 → 新路径
        const parent = renaming.path.includes('/') ? renaming.path.slice(0, renaming.path.lastIndexOf('/')) : '';
        const to = parent ? `${parent}/${newNameTrim}` : newNameTrim;
        await api.apiRename(pid, { from: renaming.path, to });
      }
      showToast(t('apiPanel.renamed'), true);
      setRenaming(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 复制/移动接口：弹出目录树选择目标目录。 */
  const startCopyMove = (node: ApiTreeNode, mode: 'copy' | 'move') => {
    setCopyMove({ node, mode });
  };

  /** 确认复制/移动：读源文件 → 写到目标目录 → 移动时删源文件。 */
  const doCopyMove = async (targetDir: string) => {
    if (!copyMove) return;
    const { node, mode } = copyMove;
    try {
      const r = await api.fileText(pid, `.api/collections/${node.path}`);
      const fileName = node.path.split('/').pop() ?? 'untitled.json';
      const to = targetDir ? `${targetDir}/${fileName}` : fileName;
      await api.apiSave(pid, { path: to, content: r.text });
      if (mode === 'move') {
        await api.apiDelete(pid, { path: node.path });
      }
      showToast(mode === 'copy' ? t('apiPanel.copied') : t('apiPanel.moved'), true);
      setCopyMove(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 克隆接口到同目录：读源文件 → 改 name → 写到同目录下新文件。 */
  const doClone = async (node: ApiTreeNode) => {
    try {
      const r = await api.fileText(pid, `.api/collections/${node.path}`);
      const def = JSON.parse(r.text) as ApiRequestDef;
      def.name = `${def.name} (副本)`;
      const baseName = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/') + 1) : '';
      const origName = (node.path.split('/').pop() ?? 'untitled.json').replace(/\.json$/, '');
      const to = `${baseName}${origName}-copy.json`;
      await api.apiSave(pid, { path: to, content: JSON.stringify(def, null, 2) });
      showToast(t('apiPanel.cloned'), true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 保存环境到后端。 */
  const saveEnvironments = async (next: ApiEnvironments) => {
    try {
      await api.apiSave(pid, { path: '', content: '', environments: next });
      setTree((prev) => (prev ? { ...prev, environments: next } : prev));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openApi = async (node: ApiTreeNode) => {
    const def = await readDef(node.path);
    setEditing({ def, path: node.path });
  };

  const createNode = async () => {
    if (!newName.trim()) return;
    const isDir = newType === 'dir';
    const base = newParentPath ? `${newParentPath}/` : '';
    const rel = isDir ? `${base}${newName.trim()}` : `${base}${newName.trim()}.json`;
    try {
      if (isDir) {
        await api.apiSave(pid, { path: `${rel}/`, content: '' });
      } else {
        const def: ApiRequestDef = { name: newName.trim(), method: newMethod, url: '' };
        await api.apiSave(pid, { path: rel, content: JSON.stringify(def, null, 2) });
      }
      showToast(t('apiPanel.created'), true);
      setNewType(null);
      setNewName('');
      setNewParentPath('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteNode = async (node: ApiTreeNode) => {
    const confirmed = window.confirm(node.type === 'dir' ? t('apiPanel.confirmDelDir', { name: node.name }) : t('apiPanel.confirmDelApi', { name: node.name }));
    if (!confirmed) return;
    try {
      await api.apiDelete(pid, { path: node.path });
      showToast(t('apiPanel.deleted'), true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doExport = async (format: 'postman' | 'swagger') => {
    try {
      const r = await api.apiExport(pid, format);
      const blob = new Blob([r.content], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      showToast((e as Error).message, false);
    }
  };

  /** 虚拟 root：把 collections/ 下的内容统一包在一个根节点里，操作挂在根上。 */
  const rootExpanded = expanded.has('');
  const toggleRoot = () =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has('')) next.delete('');
      else next.add('');
      return next;
    });

  return (
    <div className="api-panel">
      <div className="changes-head">
        <h3>{t('apiPanel.title')}</h3>
        <div className="changes-head-actions">
          <select
            className="ov-select"
            value={env.current?.name ?? ''}
            onChange={(e) => void switchEnv(e.target.value)}
            disabled={env.envs.length === 0}
            title={t('apiPanel.envTitle')}
          >
            {env.envs.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
          <button
            className="api-icon-btn api-env-edit-btn"
            type="button"
            title={t('apiPanel.editEnv')}
            onClick={() => setEnvEditOpen(true)}
          >
            ⚙
          </button>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="api-search-wrap">
        <input
          className="text-input api-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('apiPanel.searchPlaceholder')}
          spellCheck={false}
        />
      </div>

      {loading && <div className="changes-note-summary">{t('apiPanel.loading')}</div>}
      {error && (
        <div className="changes-error" role="alert">
          {error}
        </div>
      )}

      {tree && !tree.initialized && !loading && <div className="changes-nogit">{t('apiPanel.notInit')}</div>}

      {tree && (
        <div className="api-tree">
          <div className="api-row api-dir api-root" onClick={toggleRoot} onContextMenu={triggerRowMenu}>
            <span className={`chevron ${rootExpanded ? 'open' : ''}`}>▸</span>
            <span className="api-dir-icon">📁</span>
            <span className="api-name">{t('apiPanel.rootName')}</span>
            <span className="api-node-actions">
              <button className="api-icon-btn" type="button" title={t('apiPanel.newDir')} onClick={(e) => { e.stopPropagation(); startNew('dir', ''); }}>+</button>
              <NodeMenu
                items={[
                  { label: t('apiPanel.newDir'), action: () => startNew('dir', '') },
                  { label: t('apiPanel.exportPostman'), action: () => void doExport('postman') },
                  { label: t('apiPanel.exportSwagger'), action: () => void doExport('swagger') },
                ]}
              />
            </span>
          </div>
          {rootExpanded &&
            (filteredTree.length === 0 ? (
              <div className="changes-nobase">{searchQuery ? t('apiPanel.noResults') : t('apiPanel.empty')}</div>
            ) : (
              filteredTree.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={1}
                  expanded={expanded}
                  onToggle={(p) =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(p)) next.delete(p);
                      else next.add(p);
                      return next;
                    })
                  }
                  onOpen={(n) => void openApi(n)}
                  onAddApi={(parent) => startNew('api', parent)}
                  onAddDir={(parent) => startNew('dir', parent)}
                  onDelete={(n) => void deleteNode(n)}
                  onRename={(n) => startRename(n)}
                  onCopy={(n) => startCopyMove(n, 'copy')}
                  onMove={(n) => startCopyMove(n, 'move')}
                  onClone={(n) => doClone(n)}
                />
              ))
            ))}
        </div>
      )}

      {env.current && (
        <div className="api-env-vars">
          <div className="api-env-title">{t('apiPanel.envVars')}</div>
          {Object.keys(vars).length === 0 ? (
            <div className="dim api-env-empty">{t('apiPanel.envEmpty')}</div>
          ) : (
            Object.entries(vars).map(([k, v]) => (
              <div key={k} className="api-var-row">
                <span className="api-var-key">{k}</span>
                <span className="api-var-val">{v}</span>
              </div>
            ))
          )}
        </div>
      )}

      {newType && (
        <Dialog title={newType === 'dir' ? t('apiPanel.newDir') : t('apiPanel.newApi')} onClose={() => setNewType(null)}>
          {newParentPath && <p className="confirm-text">{t('apiPanel.under')} {newParentPath}</p>}
          <div className="api-form-row">
            <input
              className="text-input"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              placeholder={newType === 'dir' ? '订单' : '创建用户'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) void createNode();
              }}
            />
            {newType === 'api' && (
              <select className="ov-select" value={newMethod} onChange={(e) => setNewMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}
          </div>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setNewType(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn" disabled={!newName.trim()} onClick={() => void createNode()}>
              {t('apiPanel.create')}
            </button>
          </div>
        </Dialog>
      )}

      {/* 重命名弹窗 */}
      {renaming && (
        <Dialog title={t('apiPanel.rename')} onClose={() => setRenaming(null)}>
          <div className="api-form-row">
            <input
              className="text-input"
              value={renameVal}
              autoFocus
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameVal.trim()) void doRename();
              }}
            />
          </div>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setRenaming(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn" disabled={!renameVal.trim() || renameVal.trim() === renaming.name} onClick={() => void doRename()}>
              {t('apiPanel.rename')}
            </button>
          </div>
        </Dialog>
      )}

      {/* 环境编辑弹窗 */}
      {envEditOpen && tree?.environments && (
        <EnvEditDialog
          environments={tree.environments}
          onSave={async (next) => { await saveEnvironments(next); }}
          onClose={() => setEnvEditOpen(false)}
        />
      )}

      {/* 复制/移动：选目标目录弹窗 */}
      {copyMove && tree && (
        <DirPickerDialog
          title={copyMove.mode === 'copy' ? t('apiPanel.copy') : t('apiPanel.move')}
          dirs={tree.tree}
          onConfirm={(dir) => void doCopyMove(dir)}
          onClose={() => setCopyMove(null)}
        />
      )}

      {editing && (
        <RequestDialog
          projectId={pid}
          def={editing.def}
          initialPath={editing.path}
          vars={vars}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}

/** 环境编辑弹窗：新建/编辑/删除环境，用 PairEditor 编辑变量。 */
function EnvEditDialog({
  environments,
  onSave,
  onClose,
}: {
  environments: ApiEnvironments;
  onSave: (next: ApiEnvironments) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [envs, setEnvs] = useState<ApiEnvironment[]>(environments.environments);
  const [active, setActive] = useState(environments.active);
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const idx = envs.findIndex((e) => e.name === active);
    return idx >= 0 ? idx : 0;
  });
  // draft pairs：独立于 envs 的编辑草稿，切环境时重置。save 时才写回 variables。
  const [draftPairs, setDraftPairs] = useState<Array<{ key: string; value: string; enabled: boolean }>>(() => {
    const cur = envs.find((e) => e.name === active) ?? envs[0];
    return cur ? Object.entries(cur.variables).map(([key, value]) => ({ key, value, enabled: true })) : [];
  });

  const current = envs[selectedIdx] ?? null;

  /** 切环境时重置 draft pairs。 */
  const selectEnv = (i: number) => {
    // 先把当前 draft 写回当前环境
    flushDraft();
    setSelectedIdx(i);
    const env = envs[i];
    setDraftPairs(env ? Object.entries(env.variables).map(([key, value]) => ({ key, value, enabled: true })) : []);
  };

  /** 把 draftPairs 写回当前环境的 variables（过滤空 key）。 */
  const flushDraft = () => {
    const vars: Record<string, string> = {};
    for (const p of draftPairs) {
      if (p.enabled && p.key.trim()) vars[p.key.trim()] = p.value;
    }
    setEnvs((prev) => prev.map((e, i) => (i === selectedIdx ? { ...e, variables: vars } : e)));
  };

  /** 更新环境名。 */
  const updateName = (name: string) => {
    setEnvs((prev) => prev.map((e, i) => (i === selectedIdx ? { ...e, name } : e)));
  };

  /** 新建环境。 */
  const addEnv = () => {
    flushDraft();
    const name = `环境 ${envs.length + 1}`;
    const newEnv: ApiEnvironment = { name, variables: {} };
    const idx = envs.length;
    setEnvs([...envs, newEnv]);
    setSelectedIdx(idx);
    setDraftPairs([]);
  };

  /** 删除当前环境。 */
  const deleteEnv = () => {
    if (envs.length <= 1) return;
    const next = envs.filter((_, i) => i !== selectedIdx);
    setEnvs(next);
    if (active === envs[selectedIdx].name) setActive(next[0].name);
    setSelectedIdx(0);
    setDraftPairs(next[0] ? Object.entries(next[0].variables).map(([key, value]) => ({ key, value, enabled: true })) : []);
  };

  const handleSave = async () => {
    // 先把 draft 写回
    const vars: Record<string, string> = {};
    for (const p of draftPairs) {
      if (p.enabled && p.key.trim()) vars[p.key.trim()] = p.value;
    }
    const finalEnvs = envs.map((e, i) => (i === selectedIdx ? { ...e, variables: vars } : e));
    const next: ApiEnvironments = { environments: finalEnvs, active };
    await onSave(next);
    onClose();
  };

  return (
    <Dialog title={t('apiPanel.editEnv')} onClose={onClose} wide>
      <div className="api-env-editor">
        <div className="api-env-editor-layout">
          {/* 左侧：环境列表 */}
          <div className="api-env-list">
            {envs.map((e, i) => (
              <div
                key={i}
                className={`api-env-item${i === selectedIdx ? ' active' : ''}`}
                onClick={() => selectEnv(i)}
              >
                <span className="api-env-item-name">{e.name}</span>
                {e.name === active && <span className="api-env-active-dot" />}
              </div>
            ))}
            <button className="api-pair-add" type="button" onClick={addEnv}>+ {t('apiPanel.addEnv')}</button>
          </div>
          {/* 右侧：变量编辑 */}
          <div className="api-env-detail">
            {current ? (
              <>
                <div className="api-env-name-row">
                  <input
                    className="text-input api-env-name-input"
                    value={current.name}
                    onChange={(e) => updateName(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    className="btn ghost small"
                    type="button"
                    title={t('apiPanel.setActive')}
                    disabled={current.name === active}
                    onClick={() => setActive(current.name)}
                  >
                    {current.name === active ? '✓' : t('apiPanel.setActive')}
                  </button>
                  <button className="btn ghost small api-env-del-btn" type="button" onClick={deleteEnv} disabled={envs.length <= 1}>
                    {t('apiPanel.deleteEnv')}
                  </button>
                </div>
                <div className="api-field-head">
                  <span>{t('apiPanel.envVars')}</span>
                </div>
                <PairEditor
                  pairs={draftPairs}
                  onChange={setDraftPairs}
                  keyPlaceholder="baseUrl"
                  valPlaceholder="http://localhost:3000"
                />
              </>
            ) : (
              <div className="changes-nobase">{t('apiPanel.envEmpty')}</div>
            )}
          </div>
        </div>
        <div className="confirm-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn" onClick={() => void handleSave()}>
            {t('apiPanel.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** 目录树选择器弹窗：用于复制/移动时选目标目录。 */
function DirPickerDialog({
  title,
  dirs,
  onConfirm,
  onClose,
}: {
  title: string;
  dirs: ApiTreeNode[];
  onConfirm: (dir: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState('');

  /** 递归收集所有目录路径。 */
  const allDirs: Array<{ path: string; name: string; depth: number }> = [];
  const collect = (nodes: ApiTreeNode[], depth: number) => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        allDirs.push({ path: n.path, name: n.name, depth });
        if (n.children?.length) collect(n.children, depth + 1);
      }
    }
  };
  collect(dirs, 0);

  return (
    <Dialog title={title} onClose={onClose}>
      <div className="api-dir-picker">
        <div className="api-dir-picker-list">
          {/* 根目录选项 */}
          <div
            className={`api-dir-picker-item${selected === '' ? ' active' : ''}`}
            onClick={() => setSelected('')}
          >
            <span className="api-dir-icon">📁</span>
            <span>{t('apiPanel.rootName')}</span>
          </div>
          {allDirs.map((d) => (
            <div
              key={d.path}
              className={`api-dir-picker-item${selected === d.path ? ' active' : ''}`}
              style={{ paddingLeft: 8 + d.depth * 14 }}
              onClick={() => setSelected(d.path)}
            >
              <span className="api-dir-icon">📁</span>
              <span>{d.name}</span>
            </div>
          ))}
        </div>
        <div className="confirm-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn" onClick={() => onConfirm(selected)}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}