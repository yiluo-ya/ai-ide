/**
 * 活动栏（最左 / 最右竖条窄栏，VS Code 布局迁移，2026-10-08）。
 *
 * 竖排图标，点击选中该侧视图；拖拽图标到另一条活动栏 = 换侧；在同一条活动栏内拖到某图标上 = 上下排序。
 * 六个视图：files / search / git / agent / overview / outline。
 */
import { useState, type DragEvent, type ReactNode } from 'react';
import { useI18n } from './i18n';
import type { ViewId, ViewSide } from './layout';

/** 拖拽数据：视图 id + 来源侧（用于区分「换侧」与「同侧排序」）。 */
const DRAG_ID = 'application/x-wcr-view';
const DRAG_FROM = 'application/x-wcr-view-from';

/** 全部视图的 i18n label。 */
const LABEL: Record<ViewId, string> = {
  files: 'app.activityFiles',
  search: 'app.activitySearch',
  git: 'app.activityGit',
  agent: 'app.activityAgent',
  overview: 'app.tab.overview',
  outline: 'app.activityOutline',
};

/** 内联图标（与 TopBar 里一致的线性 SVG 风格）。 */
function icon(id: ViewId): ReactNode {
  switch (id) {
    case 'files':
      return <path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h4.4l1.7 2h8.5A1.7 1.7 0 0 1 21 9.2v7.6A1.7 1.7 0 0 1 19.3 18.5H4.7A1.7 1.7 0 0 1 3 16.8V7.2Z" />;
    case 'search':
      return (
        <>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </>
      );
    case 'git':
      return (
        <>
          <circle cx="6" cy="6" r="2.6" />
          <circle cx="6" cy="18" r="2.6" />
          <circle cx="18" cy="6" r="2.6" />
          <path d="M6 8.6v6.8M6.9 6.9c2-2 3.1-2 5.1 0M7 17.1c2 2 3 2 5 0M12 7c0 3.3 0 6.7 0 10" />
        </>
      );
    case 'agent':
      return (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M8.5 10.5h.01M15.5 10.5h.01M9 14.5c1.8 1.4 4.2 1.4 6 0" />
        </>
      );
    case 'overview':
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M4 15h16M10 4v16M14 9l3 2-3 2" />
        </>
      );
    case 'outline':
      return (
        <>
          <path d="M6 6h12M6 12h12M6 18h8" />
          <circle cx="4" cy="6" r="1" />
          <circle cx="4" cy="12" r="1" />
          <circle cx="4" cy="18" r="1" />
        </>
      );
  }
}

export function ActivityBar({
  side,
  views,
  active,
  onSelect,
  onMove,
  onReorder,
  gitCount,
}: {
  side: ViewSide;
  /** 该侧活动栏要显示的视图（顺序已决定）。 */
  views: ViewId[];
  active: ViewId;
  onSelect: (id: ViewId) => void;
  /** 把某个视图拖到目标侧（跨栏换侧）；可选插入下标。 */
  onMove: (id: ViewId, to: ViewSide, toIndex?: number) => void;
  /** 同侧排序：把视图插到某下标位置。 */
  onReorder: (id: ViewId, toIndex: number) => void;
  /** 源码管理图标上的未提交改动计数徽标（可选）。 */
  gitCount?: number;
}) {
  const { t } = useI18n();
  /** 是否正有视图拖到本栏上方（用于高亮 drop 目标）。 */
  const [dragOver, setDragOver] = useState(false);
  /** 正在被拖走的视图 id（源图标半透明）。 */
  const [draggingId, setDraggingId] = useState<ViewId | null>(null);
  /** 同侧排序的插入位置提示（-1 = 无）。 */
  const [dropIndex, setDropIndex] = useState(-1);

  const clearDrag = () => {
    setDragOver(false);
    setDraggingId(null);
    setDropIndex(-1);
  };

  /** 整条栏作为 drop 目标：从另一侧拖来的视图 → 换侧（追加到本栏末尾）。 */
  const handleBarDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_ID) as ViewId;
    const from = e.dataTransfer.getData(DRAG_FROM) as ViewSide;
    clearDrag();
    if (!id) return;
    if (from && from !== side) onMove(id, side);
    // 同侧拖到栏空白处：忽略（保持原顺序）
  };

  /** 某个图标作为 drop 目标：同侧时按指针上下半算出插入下标。 */
  const handleItemDrop = (e: DragEvent<HTMLButtonElement>, targetId: ViewId) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData(DRAG_ID) as ViewId;
    const from = e.dataTransfer.getData(DRAG_FROM) as ViewSide;
    clearDrag();
    if (!id || id === targetId) return;
    if (from !== side) {
      // 从另一侧拖到某个图标上：换侧，并插到该图标附近
      const targetIndex = views.indexOf(targetId);
      onMove(id, side, targetIndex);
      return;
    }
    // 同侧排序：上下半决定插在 target 前还是后
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const idx = views.indexOf(targetId);
    onReorder(id, before ? idx : idx + 1);
  };

  const handleItemDragOver = (e: DragEvent<HTMLButtonElement>, targetId: ViewId) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const from = e.dataTransfer.getData(DRAG_FROM) as ViewSide;
    if (from === side) {
      const rect = e.currentTarget.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      setDropIndex(views.indexOf(targetId) + (before ? 0 : 1));
    }
  };

  return (
    <div
      className={`activitybar${dragOver ? ' drag-over' : ''}`}
      role="tablist"
      aria-label={t(side === 'left' ? 'app.activityBarLeft' : 'app.activityBarRight')}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={handleBarDrop}
    >
      {views.map((id, index) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`wcr-activity-${side}-${id}`}
          aria-selected={active === id}
          className={`activity-item${active === id ? ' active' : ''}${draggingId === id ? ' dragging' : ''}`}
          title={t(LABEL[id])}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_ID, id);
            e.dataTransfer.setData(DRAG_FROM, side);
            e.dataTransfer.effectAllowed = 'move';
            setDraggingId(id);
          }}
          onDragEnd={clearDrag}
          onDragOver={(e) => handleItemDragOver(e, id)}
          onDrop={(e) => handleItemDrop(e, id)}
          onClick={() => onSelect(id)}
        >
          {/* 同侧排序的落点指示线：插入到本图标之前 */}
          {dropIndex === index && <span className="activity-dropline activity-dropline-before" />}
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {icon(id)}
          </svg>
          {/* 插入到本图标之后（即下一个图标之前） */}
          {dropIndex === index + 1 && index === views.length - 1 && (
            <span className="activity-dropline activity-dropline-after" />
          )}
          {id === 'git' && gitCount != null && gitCount > 0 && (
            <span className="activity-badge">{gitCount}</span>
          )}
        </button>
      ))}
    </div>
  );
}