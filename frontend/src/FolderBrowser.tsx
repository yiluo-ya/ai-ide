/**
 * 目录选择弹窗（2026-10-03 用户要求）：顶栏「添加项目」输入框末尾的文件夹图标点开的窗口。
 *
 * 外观用 @cubone/react-file-manager（用户拍板「找一个漂亮点的文件管理」），但只列目录：
 * 数据来自后端 `GET /api/fs/dirs`，它同样只返回目录名，且共享模式（HOST 非本机）下直接 403
 * —— 这里照实把原因显示出来，不假装成功。
 *
 * 组件行为（读它的 dist 源码确认，决定了本文件的写法）：
 * 1. `initialPath` 只在**挂载时**读一次 → 换目录 = 换 key 重挂载，改 prop 没用；
 * 2. 它只认 "/"，并把「当前目录的子项」定义为 `path === \`${当前路径}/${名字}\``
 *    → 我们给每个真实目录分配一条虚拟路径（父虚拟路径 + "/" + 名字），Windows 反斜杠不进 UI；
 * 3. 单击只选中、双击才进入 → 「单击进入」由本文件在 onSelectionChange 里主动导航补上；
 * 4. 它的 dist/style.css 里有 `.active`/`.file{width:86%}`/`.open` 这类全局类，会污染主界面
 *    → 整块 UI 放进 Shadow DOM，组件 CSS 用 `?inline` 只在影子树里注入（见 ShadowHost）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FileManager, type FileManagerFile } from '@cubone/react-file-manager';
import fmCss from '@cubone/react-file-manager/dist/style.css?inline';
import { api } from './api';
import { useI18n } from './i18n';
import fbCss from './folderbrowser.css?inline';
import './folderbrowser.css';

/** 组件自带的权限开关，全关掉 = 只读浏览（我们只读目录，不写、不传、不删）。 */
const READ_ONLY = {
  create: false,
  upload: false,
  move: false,
  copy: false,
  rename: false,
  download: false,
  delete: false,
};

interface Props {
  /** 打开时尝试定位到的路径（顶栏输入框里已有的内容），空则停在起点（盘符 / 主目录）。 */
  initialPath?: string;
  onClose: () => void;
  /** 用户确认后回传**真实**本机路径（虚拟路径只活在弹窗内部）。 */
  onPick: (root: string) => void;
}

/** 把弹窗内容挂进 Shadow DOM：组件 CSS 是全局的，不隔离会打到主界面。 */
function ShadowHost({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // StrictMode 下 effect 跑两次：已有影子树就复用，不再 attach
    setRoot(host.shadowRoot ?? host.attachShadow({ mode: 'open' }));
  }, []);

  return (
    <div className="fb-host" ref={hostRef}>
      {root &&
        createPortal(
          <>
            {/* 组件自带样式 + 本弹窗的深色覆盖（都只作用于这棵影子树） */}
            <style>{fmCss}</style>
            <style>{fbCss}</style>
            {children}
          </>,
          root,
        )}
    </div>
  );
}

export function FolderBrowser({ initialPath, onClose, onPick }: Props) {
  const { t, locale } = useI18n();
  const [files, setFiles] = useState<FileManagerFile[]>([]);
  /** 当前虚拟路径：'' = 起点（盘符 / 主目录列表）。 */
  const [current, setCurrent] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const realOf = useRef(new Map<string, string>()); // 虚拟路径 → 真实路径
  const virtualOf = useRef(new Map<string, string>()); // 真实路径 → 虚拟路径
  const loaded = useRef(new Set<string>());
  /** 供回调读最新值：onSelectionChange 里的比较不能靠 state 闭包。 */
  const currentRef = useRef('');
  const setPath = useCallback((v: string) => {
    currentRef.current = v;
    setCurrent(v);
  }, []);

  /** 把一批真实目录登记为某虚拟路径的子项（幂等，重复加载不会重复出现）。 */
  const register = useCallback((parentVirtual: string, dirs: Array<{ name: string; real: string }>) => {
    const entries = dirs.map((d) => ({ name: d.name, real: d.real, virtual: `${parentVirtual}/${d.name}` }));
    for (const e of entries) {
      realOf.current.set(e.real, e.virtual);
      virtualOf.current.set(e.virtual, e.real);
    }
    setFiles((prev) => {
      const known = new Set(prev.map((f) => f.path));
      const added = entries
        .filter((e) => !known.has(e.virtual))
        .map((e) => ({ name: e.name, isDirectory: true, path: e.virtual }));
      return added.length ? [...prev, ...added] : prev;
    });
  }, []);

  /** 读一个虚拟路径下的目录（幂等；''=起点）。 */
  const loadDir = useCallback(
    async (virtual: string) => {
      if (loaded.current.has(virtual)) return;
      loaded.current.add(virtual);
      setBusy(true);
      setError(null);
      try {
        const res = await api.fsDirs(virtualOf.current.get(virtual));
        // 后端回的是 resolve 过的真实路径，以它为准登记双向映射
        if (res.path) {
          realOf.current.set(virtual, res.path);
          virtualOf.current.set(res.path, virtual);
        }
        register(
          virtual,
          res.dirs.map((d) => ({
            // Windows 盘符：后端给 "D:\\"，界面显示成 "D:"
            name: /^[A-Za-z]:\\$/.test(d.path) ? d.path.slice(0, 2) : d.name,
            real: d.path,
          })),
        );
      } catch (e) {
        loaded.current.delete(virtual); // 失败不算加载过，允许重试
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [register],
  );

  /** 真实路径 → 虚拟路径：逐级把祖先目录补齐（手敲路径跳转用）。 */
  const virtualFor = useCallback(
    async (real: string, depth = 0): Promise<string> => {
      const hit = realOf.current.get(real);
      if (hit !== undefined) return hit;
      if (depth > 40) throw new Error(t('folderBrowser.tooDeep'));
      const res = await api.fsDirs(real);
      if (!res.path) throw new Error(t('folderBrowser.unresolved'));
      const abs = res.path;
      const known = realOf.current.get(abs);
      if (known !== undefined) return known;
      if (!res.parent) {
        // 已到根（盘符 / "/"）：起点列表里应该登记过它
        await loadDir('');
        const root = realOf.current.get(abs);
        if (root !== undefined) return root;
        throw new Error(t('folderBrowser.outOfScope'));
      }
      const parentVirtual = await virtualFor(res.parent, depth + 1);
      const name = abs.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? abs;
      register(parentVirtual, [{ name, real: abs }]);
      return `${parentVirtual}/${name}`;
    },
    [loadDir, register, t],
  );

  /** 进入某虚拟路径：先保证数据在，再换 key 让组件重挂载到该路径。 */
  const navigate = useCallback(
    async (virtual: string) => {
      if (virtual === currentRef.current) return;
      await loadDir(virtual);
      setPath(virtual);
    },
    [loadDir, setPath],
  );

  // 打开时：先拿起点（盘符 / 主目录），顶栏输入框里有路径就顺带定位过去
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadDir('');
      const start = initialPath?.trim();
      if (cancelled || !start) return;
      try {
        await navigate(await virtualFor(start));
      } catch {
        /* 输入框里的路径不可读时不打断：留在起点，错误由下面的跳转行显示 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在挂载时定位一次（initialPath 是打开弹窗那一刻的快照）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const goTyped = async () => {
    const raw = typed.trim();
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      await navigate(await virtualFor(raw));
      setTyped('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const picked = realOf.current.get(current) ?? '';

  return (
    <ShadowHost>
      <div className="fb-backdrop" onMouseDown={onClose}>
        <div
          className="fb-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('folderBrowser.title')}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="fb-head">
            <span className="fb-title">{t('folderBrowser.title')}</span>
            <button className="fb-close" onClick={onClose} title={t('dialog.close')} aria-label={t('dialog.close')}>
              ×
            </button>
          </div>

          <div className="fb-jump">
            <input
              className="fb-input"
              value={typed}
              autoFocus
              aria-label={t('folderBrowser.pathLabel')}
              placeholder={t('folderBrowser.pathPlaceholder')}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void goTyped();
                }
              }}
            />
            <button className="fb-btn" disabled={!typed.trim() || busy} onClick={() => void goTyped()}>
              {t('folderBrowser.go')}
            </button>
          </div>

          <div className="fb-body">
            <FileManager
              key={current}
              files={files}
              initialPath={current}
              height="360px"
              width="100%"
              layout="list"
              language={locale === 'en' ? 'en-US' : 'zh-CN'}
              primaryColor="#1177bb"
              fontFamily="inherit"
              permissions={READ_ONLY}
              defaultNavExpanded={false}
              enableFilePreview={false}
              isLoading={busy}
              onFolderChange={(p) => void navigate(p)}
              onSelectionChange={(sel) => {
                // 「单击进入」：选中的是目录就当成进入（组件本身双击才进）
                if (sel.length !== 1) return;
                const only = sel[0];
                if (only.isDirectory && only.path !== currentRef.current) void navigate(only.path);
              }}
              onRefresh={() => {
                const here = currentRef.current;
                loaded.current.delete(here);
                void loadDir(here);
              }}
            />
          </div>

          {error && <div className="fb-error">{error}</div>}

          <div className="fb-foot">
            <span className="fb-picked" title={picked}>
              {picked ? t('folderBrowser.picked', { path: picked }) : t('folderBrowser.pickHint')}
            </span>
            <button className="fb-btn" onClick={onClose}>
              {t('folderBrowser.cancel')}
            </button>
            <button className="fb-btn primary" disabled={!picked || busy} onClick={() => picked && onPick(picked)}>
              {t('folderBrowser.add')}
            </button>
          </div>
        </div>
      </div>
    </ShadowHost>
  );
}
