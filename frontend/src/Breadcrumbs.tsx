/**
 * 面包屑（FR-0012）：显示当前打开文件的路径层级（项目名 › 目录… › 文件名）。
 *
 * 点任一段打开下拉，列出该目录下的条目：点目录继续下钻、点文件直接打开（对齐 VS Code 的面包屑）。
 * 渲染层只读 `store.tree`（已是全量索引树），不再往后端要「列一层」的接口。
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { FileNode } from './api';
import { useI18n } from './i18n';

interface Props {
  file: string | null;
  tree: FileNode | null;
  onOpen: (file: string) => void;
}

/** 在文件树里按路径找节点（找不到返回 null）。 */
function findNode(node: FileNode | null, path: string): FileNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

/** 下拉里的排序：目录在前、各自按名称升序（与文件树一致）。 */
function sortChildren(node: FileNode): FileNode[] {
  return [...(node.children ?? [])].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function Breadcrumbs({ file, tree, onOpen }: Props) {
  const { t } = useI18n();
  /** 下拉当前展示的目录路径；null = 没开。项目根是空串（要与「没开」区分）。 */
  const [menuDir, setMenuDir] = useState<string | null>(null);

  // 换文件 / 换项目就收起下拉（路径变了，旧下拉没有意义）
  useEffect(() => setMenuDir(null), [file, tree]);

  // Esc 收起（捕获阶段：不让编辑器抢这个键）
  useEffect(() => {
    if (menuDir === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuDir(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menuDir]);

  const parts = (file ?? '').split('/').filter(Boolean);
  const dirs = parts.slice(0, -1).map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  const menuNode = useMemo(() => (menuDir === null ? null : findNode(tree, menuDir)), [tree, menuDir]);
  const parentOf = (dir: string) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');

  if (!file) return null;

  return (
    <div className="breadcrumbs">
      <button
        className={`crumb root${menuDir === '' ? ' open' : ''}`}
        onClick={() => setMenuDir((prev) => (prev === '' ? null : ''))}
        title={tree?.name ?? t('filetree.projectRoot')}
      >
        {tree?.name ?? t('filetree.projectRoot')}
      </button>
      {dirs.map((d) => (
        <Fragment key={d.path}>
          <span className="crumb-sep" aria-hidden>
            ›
          </span>
          <button
            className={`crumb${menuDir === d.path ? ' open' : ''}`}
            onClick={() => setMenuDir((prev) => (prev === d.path ? null : d.path))}
            title={d.path}
          >
            {d.name}
          </button>
        </Fragment>
      ))}
      <span className="crumb-sep" aria-hidden>
        ›
      </span>
      <span className="crumb current" title={file}>
        {parts[parts.length - 1] ?? file}
      </span>

      {menuDir !== null && (
        <>
          <div className="breadcrumbs-backdrop" onClick={() => setMenuDir(null)} />
          <div className="breadcrumbs-menu" role="menu">
            {menuDir !== '' && (
              <button className="crumb-item up" onClick={() => setMenuDir(parentOf(menuDir))}>
                ↑ {parentOf(menuDir) || tree?.name || t('filetree.projectRoot')}
              </button>
            )}
            {menuNode ? (
              sortChildren(menuNode).map((child) => (
                <button
                  key={child.path}
                  className={`crumb-item${child.type === 'directory' ? ' dir' : ''}${
                    child.path === file ? ' current' : ''
                  }`}
                  onClick={() => {
                    if (child.type === 'directory') setMenuDir(child.path);
                    else {
                      onOpen(child.path);
                      setMenuDir(null);
                    }
                  }}
                >
                  {child.name}
                  {child.type === 'directory' ? '/' : ''}
                </button>
              ))
            ) : (
              <div className="crumb-empty">{t('filetree.noFiles')}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
