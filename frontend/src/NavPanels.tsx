/**
 * 导航的层级面板（N16 调用层级 / N17 类型层级 / N15 跳到实现）。
 *
 * 共同纪律（03-navigator-plan §0）：拿不到的关系如实标注，不用启发式凑数；
 * 调用层级面板底部固定显示覆盖率，让用户知道「这份结果覆盖了多少」。
 */
import { useMemo, useState } from 'react';
import type { CallHierarchyResult, CallNode, ImplementationsResult, TypeHierarchyResult, TypeNode } from './api';
import { useI18n } from './i18n';
import './guide.css';

const REL_LABEL: Record<TypeNode['relation'], string> = {
  extends: '继承',
  implements: '实现',
  embeds: '嵌入',
  overrides: '重写',
};

function TypeRow({
  node,
  onJump,
  onCopy,
  prefix,
}: {
  node: TypeNode;
  onJump: (file: string, line: number, col: number) => void;
  onCopy: (file: string, line: number, col: number) => void;
  prefix?: string;
}) {
  return (
    <div
      className="nav-row"
      title={`${node.file}:${node.location.range.start.line}`}
      onClick={() => onJump(node.file, node.location.range.start.line, node.location.range.start.col)}
    >
      <span className="nav-rel">{prefix ?? REL_LABEL[node.relation]}</span>
      <span className="nav-name">{node.name}</span>
      {node.isTest && <span className="refs-badge">测试</span>}
      <button
        className="copy-btn"
        title="复制位置 path:line:col"
        onClick={(e) => {
          e.stopPropagation();
          onCopy(node.file, node.location.range.start.line, node.location.range.start.col);
        }}
      >
        ⧉
      </button>
      <span className="nav-path">
        {node.file}:{node.location.range.start.line}
      </span>
    </div>
  );
}

function CallRow({
  node,
  depth,
  onJump,
  onCopy,
  defaultOpen,
}: {
  node: CallNode;
  depth: number;
  onJump: (file: string, line: number, col: number) => void;
  onCopy: (file: string, line: number, col: number) => void;
  defaultOpen: boolean;
}) {
  const expandable = !!node.children?.length;
  const [open, setOpen] = useState(defaultOpen && expandable);
  const leaf = node.external || node.unresolved || !node.file;
  return (
    <>
      <div
        className={`nav-row call ${leaf ? 'leaf' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => {
          if (expandable) setOpen((v) => !v);
          if (!leaf) onJump(node.file, node.location.range.start.line, node.location.range.start.col);
        }}
        title={leaf ? node.name : `${node.file}:${node.location.range.start.line}`}
      >
        <span className="nav-caret">{expandable ? (open ? '▾' : '▸') : '·'}</span>
        <span className={node.external ? 'nav-dim' : node.unresolved ? 'nav-warn' : 'nav-name'}>
          {node.name}
        </span>
        {node.isEntry && <span className="refs-badge entry">入口候选</span>}
        {node.isTest && <span className="refs-badge">测试</span>}
        <span className="nav-count">{node.callCount} 处</span>
        {!leaf && (
          <button
            className="copy-btn"
            title="复制位置 path:line:col"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(node.file, node.location.range.start.line, node.location.range.start.col);
            }}
          >
            ⧉
          </button>
        )}
      </div>
      {open &&
        node.children?.map((c, i) => (
          <CallRow
            key={`${c.name}:${c.file}:${i}`}
            node={c}
            depth={depth + 1}
            onJump={onJump}
            onCopy={onCopy}
            defaultOpen={false}
          />
        ))}
    </>
  );
}

/** N16：调用层级（in=谁调用我 / out=我调用了谁），深度 1~3，覆盖率如实显示。 */
export function CallsPanel({
  data,
  busy,
  direction,
  depth,
  onDirection,
  onDepth,
  onJump,
  onCopy,
  onExplain,
  onFlow,
}: {
  data: CallHierarchyResult | null;
  busy: boolean;
  direction: 'in' | 'out';
  depth: number;
  onDirection: (d: 'in' | 'out') => void;
  onDepth: (d: number) => void;
  onJump: (file: string, line: number, col: number) => void;
  onCopy: (file: string, line: number, col: number) => void;
  /** W4：拿当前根符号发起结构性解释。 */
  onExplain?: (file: string, line: number, col: number) => void;
  /** W5：把当前根符号展开成调用流图。 */
  onFlow?: (file: string, line: number, col: number) => void;
}) {
  const { t } = useI18n();
  const root = data?.root ?? null;
  const rootAt = root?.file ? root.location.range.start : null;
  return (
    <div className="nav-panel">
      <div className="nav-head">
        <div className="nav-switch">
          <button className={direction === 'in' ? 'active' : ''} onClick={() => onDirection('in')}>
            谁调用我
          </button>
          <button className={direction === 'out' ? 'active' : ''} onClick={() => onDirection('out')}>
            我调用了谁
          </button>
        </div>
        <label className="nav-depth">
          深度
          <select className="ov-select" value={depth} onChange={(e) => onDepth(Number(e.target.value))}>
            <option value={1}>1 层</option>
            <option value={2}>2 层</option>
            <option value={3}>3 层</option>
          </select>
        </label>
      </div>
      {/* W4 / W5：把当前根符号交给解释面板 / 流视图（没有根符号就不给假入口） */}
      {root && rootAt && (onExplain || onFlow) && (
        <div className="nav-actions">
          {onExplain && (
            <button
              className="nav-act"
              onClick={() => onExplain(root.file, rootAt.line, rootAt.col)}
              title={t('explain.entryTitle')}
            >
              {t('explain.entry')}
            </button>
          )}
          {onFlow && (
            <button
              className="nav-act"
              onClick={() => onFlow(root.file, rootAt.line, rootAt.col)}
              title={t('flow.entryTitle')}
            >
              {t('flow.entry')}
            </button>
          )}
        </div>
      )}
      <div className="nav-body">
        {busy && <div className="panel-empty">查询中…</div>}
        {!busy && !data && <div className="panel-empty">把光标放在一个符号上，这里显示调用层级</div>}
        {!busy && data && !data.root && <div className="panel-empty">{data.message ?? '无法展开'}</div>}
        {!busy && data?.root && <CallRow node={data.root} depth={0} onJump={onJump} onCopy={onCopy} defaultOpen />}
      </div>
      {data && (
        <div className="nav-foot">
          {data.coverage.resolved + data.coverage.unresolved + data.coverage.external > 0
            ? `已解析 ${data.coverage.resolved} 处 · 未归属 ${data.coverage.unresolved} 处 · 外部 ${data.coverage.external} 处`
            : '没有调用关系'}
          {data.coverage.unresolved > 0 && <span className="nav-warn">（未归属需要类型推断）</span>}
        </div>
      )}
    </div>
  );
}

/** N17：类型层级（显式继承 / 实现，双向）。 */
export function TypesPanel({
  data,
  busy,
  impls,
  implsBusy,
  onJump,
  onCopy,
}: {
  data: TypeHierarchyResult | null;
  busy: boolean;
  impls: ImplementationsResult | null;
  implsBusy: boolean;
  onJump: (file: string, line: number, col: number) => void;
  onCopy: (file: string, line: number, col: number) => void;
}) {
  const implItems = useMemo(() => impls?.items ?? [], [impls]);
  return (
    <div className="nav-panel">
      <div className="nav-body">
        {busy && <div className="panel-empty">查询中…</div>}
        {!busy && !data && <div className="panel-empty">把光标放在一个类 / 接口上，这里显示类型层级</div>}
        {!busy && data && data.reason !== 'resolved' && (
          <div className="panel-empty">{data.message ?? '无法给出类型层级'}</div>
        )}
        {!busy && data?.reason === 'resolved' && (
          <>
            <div className="nav-section">父类 / 接口（{data.bases.length}）</div>
            {data.bases.map((b) => (
              <TypeRow key={`b:${b.file}:${b.name}`} node={b} onJump={onJump} onCopy={onCopy} />
            ))}
            {!data.bases.length && <div className="nav-empty-line">没有项目内的显式基类</div>}
            {data.unresolvedBases.length > 0 && (
              <div className="nav-empty-line">
                无法定位的基名：{data.unresolvedBases.join('、')}
                <span className="nav-warn">（外部依赖或未索引）</span>
              </div>
            )}
            <div className="nav-section">谁继承 / 实现它（{data.derived.length}）</div>
            {data.derived.map((d) => (
              <TypeRow key={`d:${d.file}:${d.name}`} node={d} onJump={onJump} onCopy={onCopy} />
            ))}
            {!data.derived.length && <div className="nav-empty-line">项目内没有显式继承它的类型</div>}
            <div className="nav-section">实现（N15）{implsBusy ? ' · 查询中…' : ''}</div>
            {implItems.map((i) => (
              <TypeRow key={`i:${i.file}:${i.name}`} node={i} onJump={onJump} onCopy={onCopy} />
            ))}
            {!implsBusy && !implItems.length && (
              <div className="nav-empty-line">{impls?.message ?? '没有显式实现'}</div>
            )}
          </>
        )}
      </div>
      <div className="nav-foot">只覆盖源码里显式写出的继承 / 实现；动态注册与鸭子类型不覆盖</div>
    </div>
  );
}
