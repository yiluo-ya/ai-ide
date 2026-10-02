/**
 * 概览首页（01-map 形态一）：打开项目先看到一张「项目地图」。
 *
 * 三条纪律（对齐 docs/01-map.md §7 的共同约束）：
 * 1) 每个数字都能点开看到构成 —— 点数字会拉一次 `?files=1` 并列出具体文件，杜绝不可核对的汇总；
 * 2) 不阻塞首屏 —— 索引未完成时给「部分地图 + 进度」，且绝不把「还没索引到」显示成 0；
 * 3) 只陈列索引与文件系统里能确认的事实（不生成式摘要、不做优劣裁决）。
 */
import { useMemo, useState } from 'react';
import type {
  DirDuty,
  FileFact,
  GraphLayer,
  HotMetric,
  OverviewEntry,
  OverviewFile,
} from '../../shared/types';
import { useMapStore } from './mapState';
import { useStore } from './state';
import { ROUTE_KINDS } from './guide';
import { useGuideStore } from './guideState';
import { staleNoteCount, useChangesStore } from './changesState';
import { snapshotAge } from './readSnapshot';
import { timeAgoMs } from './timeAgo';
import { useI18n } from './i18n';
import { Welcome } from './Welcome';
import './overview.css';
import './guide.css';

interface Props {
  onOpenFile: (file: string, line?: number) => void;
  onOpenGraph: () => void;
  /** P9 出口：后端提供索引报告端点时才传（拿不到就隐藏入口，不报错）。 */
  onOpenReport?: () => void;
  /** W3 / G8：切到变更面板（「看全部 →」）。 */
  onOpenChanges?: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtWhen(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  const days = Math.floor(diff / (24 * 60 * minute));
  if (days < 30) return `${days} 天前`;
  return new Date(ms).toLocaleDateString();
}

/** M3.2 六档口径的中文说明。 */
const HOT_LABEL: Record<HotMetric, string> = {
  files: '被引用文件数',
  refs: '被引用条目数',
  symbols: '符号被引用数',
  defined: '定义数',
  unique: '独有依赖',
  recent: '新近度',
};

/** 分层名字（M4.2）。 */
const LAYER_LABEL: Record<GraphLayer, string> = {
  entry: '入口层',
  domain: '领域层',
  infra: '基础设施层',
  utility: '工具层',
  isolated: '孤立 / 测试',
};

/** 「点数字列出构成」的抽屉内容。 */
type Drawer =
  | null
  | { kind: 'files'; title: string; note?: string; files: string[] }
  | { kind: 'facts'; title: string; note?: string; pick: (f: FileFact) => boolean; sort?: (a: FileFact, b: FileFact) => number };

const bySize = (a: FileFact, b: FileFact) => b.size - a.size;
const byLines = (a: FileFact, b: FileFact) => b.lines - a.lines;

function FileRow({
  file,
  note,
  extra,
  onOpen,
  onIgnore,
}: {
  file: string;
  note?: string;
  extra?: string;
  onOpen: (file: string) => void;
  onIgnore?: (file: string) => void;
}) {
  return (
    <div className="ov-row">
      <button className="ov-row-main" onClick={() => onOpen(file)} title={file}>
        <span className="ov-file">{file}</span>
        {note && <span className="ov-note">{note}</span>}
      </button>
      {extra && <span className="ov-extra">{extra}</span>}
      {onIgnore && (
        <button className="ov-row-act" onClick={() => onIgnore(file)} title="不再出现在孤立清单里">
          标记忽略
        </button>
      )}
    </div>
  );
}

function EntryRow({
  item,
  rank,
  onOpen,
}: {
  item: OverviewEntry;
  rank: number;
  onOpen: (file: string, line?: number) => void;
}) {
  return (
    <div className="ov-entry">
      <span className={`ov-rank ${item.kind}`}>{rank}</span>
      <button className="ov-row-main" onClick={() => onOpen(item.file)} title={item.file}>
        <span className="ov-file">{item.file}</span>
      </button>
      {item.kind === 'entry' && <span className="ov-badge entry">入口</span>}
      <span className="ov-note">{item.reasons.join(' · ') || '—'}</span>
      <span className="ov-extra">{item.lines} 行</span>
    </div>
  );
}

/** G1.1–G1.4 / G2：总览顶部「从这里开始」——推荐路线 / 继续阅读 / 已读进度。 */
function GuideStart({ onOpenFile }: { onOpenFile: (file: string, line?: number) => void }) {
  const { t } = useI18n();
  const routes = useGuideStore((s) => s.routes);
  const kind = useGuideStore((s) => s.kind);
  const setKind = useGuideStore((s) => s.setKind);
  const readstate = useGuideStore((s) => s.readstate);
  const sourceFiles = useGuideStore((s) => s.sourceFiles);
  const read = useMapStore((s) => s.read);

  const route = routes?.routes.find((r) => r.kind === kind) ?? null;
  const steps = route?.steps.slice(0, 6) ?? [];
  const readCount = Object.keys(read).length;

  const cycle = () => {
    const i = ROUTE_KINDS.indexOf(kind);
    setKind(ROUTE_KINDS[(i + 1) % ROUTE_KINDS.length]);
  };

  return (
    <section className="ov-card ov-wide guide-start-card">
      <h3>{t('guide.start.title')}</h3>
      <div className="guide-start">
        <div className="guide-start-row">
          <b>{t('guide.start.route')}</b>
          {route ? (
            <span className="guide-muted">
              {t('guide.start.routeLine', { label: route.label, total: route.total })}
            </span>
          ) : (
            <span className="guide-muted">{t('guide.start.noRoute')}</span>
          )}
          <span className="spacer" />
          {steps.length > 0 && (
            <button className="btn ghost small" onClick={() => onOpenFile(steps[0].file, 1)}>
              {t('guide.start.begin')}
            </button>
          )}
          <button className="btn ghost small" onClick={cycle}>
            {t('guide.start.change')}
          </button>
        </div>
        {steps.length > 0 && (
          <div className="guide-start-steps">
            {steps.map((s) => (
              <button
                key={s.file}
                className="guide-start-step"
                onClick={() => onOpenFile(s.file, 1)}
                title={s.reason}
              >
                {s.order}. {s.file}
              </button>
            ))}
          </div>
        )}
        {readstate && (
          <div className="guide-start-row">
            <b>{t('guide.start.continue')}</b>
            <button
              className="guide-start-step"
              onClick={() => onOpenFile(readstate.file, readstate.line)}
            >
              {readstate.file}:{readstate.line}
            </button>
            <button
              className="btn ghost small"
              onClick={() => onOpenFile(readstate.file, readstate.line)}
            >
              {t('guide.start.continueBtn')}
            </button>
          </div>
        )}
        <div className="guide-muted">
          {sourceFiles
            ? t('guide.start.progress', { read: readCount, total: sourceFiles })
            : t('guide.start.progressNoTotal', { read: readCount })}
        </div>
      </div>
    </section>
  );
}

/**
 * W3 / G8.2–G8.4：首屏「自上次阅读以来」摘要卡（紧接「从这里开始」之后）。
 *
 * 没有基线时不填假数字，整块改成「记录当前为阅读基线」；
 * 无 git 时只报「变了几个文件」，不显示增删行（后端给的是 null）。
 */
function ChangesHint({ onOpenChanges }: { onOpenChanges?: () => void }) {
  const { t } = useI18n();
  const projectId = useChangesStore((s) => s.projectId);
  const summary = useChangesStore((s) => s.summary);
  const snapshot = useChangesStore((s) => s.snapshot);
  const hasSnapshot = useChangesStore((s) => s.hasSnapshot);
  const busy = useChangesStore((s) => s.busy);
  const recordBaseline = useChangesStore((s) => s.recordBaseline);
  const refresh = useChangesStore((s) => s.refresh);
  /** G8.1：SSE 报过的文件（20 秒后自动消失）——只说「刚有变更」，不描述变了什么。 */
  const pulse = useMapStore((s) => s.pulse);

  const changed = summary?.files.length ?? 0;
  const added = summary?.counts.added ?? 0;
  const staleNotes = staleNoteCount(summary);
  const age = snapshotAge(snapshot);

  return (
    <section className="ov-card ov-wide changes-card">
      <h3>{t('changes.startTitle')}</h3>
      <div className="guide-start">
        {Object.keys(pulse).length > 0 && (
          <div className="guide-start-row">
            <span className="changes-live-inline">
              {t('changes.live', { n: Object.keys(pulse).length })}
            </span>
            <button
              className="btn ghost small"
              onClick={() => void refresh()}
              disabled={!hasSnapshot || busy}
            >
              {t('changes.refresh')}
            </button>
          </div>
        )}
        {!hasSnapshot ? (
          <div className="guide-start-row">
            <span className="guide-muted">{t('changes.noBaseline')}</span>
            <span className="spacer" />
            <button
              className="btn ghost small"
              onClick={() => void recordBaseline()}
              disabled={!projectId || busy}
            >
              {t('changes.record')}
            </button>
          </div>
        ) : (
          <>
            <div className="guide-start-row">
              <b>{changed > 0 ? t('changes.startChanged', { n: changed }) : t('changes.empty')}</b>
              {summary?.source === 'git' && (
                <span className="guide-muted">
                  {t('changes.lines', {
                    added: summary.counts.addedLines,
                    removed: summary.counts.removedLines,
                  })}
                </span>
              )}
              {added > 0 && <span className="guide-muted">{t('changes.startNew', { n: added })}</span>}
              {staleNotes > 0 && (
                <span className="guide-muted">{t('changes.startStale', { n: staleNotes })}</span>
              )}
              <span className="spacer" />
              <button className="btn ghost small" onClick={onOpenChanges} disabled={!onOpenChanges}>
                {t('changes.seeAll')}
              </button>
            </div>
            {summary?.source === 'snapshot' && (
              <div className="guide-muted">
                {summary.git === 'no-head' ? t('changes.noGitHead') : t('changes.noGit')}
              </div>
            )}
            {age != null && (
              <div className="guide-muted">{t('changes.baselineAge', { age: timeAgoMs(age, t) })}</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** 可点开的数字：点了就列出「这个数字由哪些文件构成」。 */
function Metric({
  value,
  label,
  note,
  onClick,
  tone,
}: {
  value: string | number;
  label: string;
  note?: string;
  onClick?: () => void;
  tone?: 'warn';
}) {
  const body = (
    <>
      <b>{value}</b> {label}
    </>
  );
  return (
    <span className={`ov-metric ${tone ?? ''} ${onClick ? 'is-clickable' : ''}`} title={note ?? label}>
      {onClick ? (
        <button className="ov-metric-btn" onClick={onClick}>
          {body}
        </button>
      ) : (
        body
      )}
    </span>
  );
}

export function Overview({ onOpenFile, onOpenGraph, onOpenReport, onOpenChanges }: Props) {
  const overview = useMapStore((s) => s.overview);
  const timeline = useMapStore((s) => s.timeline);
  const busy = useMapStore((s) => s.busy);
  const options = useMapStore((s) => s.options);
  const setOptions = useMapStore((s) => s.setOptions);
  const toggleIgnored = useMapStore((s) => s.toggleIgnored);
  const ignored = useMapStore((s) => s.ignored);
  const read = useMapStore((s) => s.read);
  const toggleRead = useMapStore((s) => s.toggleRead);
  const markReadMany = useMapStore((s) => s.markReadMany);
  const status = useStore((s) => s.status);
  const [showReadme, setShowReadme] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [facts, setFacts] = useState<FileFact[] | null>(null);
  const [dirSort, setDirSort] = useState<'files' | 'deps' | 'name'>('files');
  const [complexSort, setComplexSort] = useState<'branches' | 'nesting' | 'longestFunction' | 'exports'>('branches');

  /** 打开抽屉：没有全量事实时先按需拉一次（这也是「数字都能点开」的实现）。 */
  const openDrawer = async (next: Drawer) => {
    setDrawer(next);
    if (next && ['facts'].includes(next.kind) && !facts) {
      const data = await useMapStore.getState().loadFileFacts();
      setFacts(data ?? []);
    }
  };

  const sortedComplex = useMemo(() => {
    if (!overview) return [];
    return [...overview.complex].sort((a, b) => {
      const pick = (f: OverviewFile) => complexSort === 'nesting' ? f.nesting : complexSort === 'longestFunction' ? f.longestFunction : complexSort === 'exports' ? f.exports : f.branches;
      return pick(b) - pick(a) || b.lines - a.lines;
    });
  }, [overview, complexSort]);

  if (!overview) {
    // P16：空状态给三步引导（真正可达的欢迎页），"正在生成"仍保留原提示
    if (busy) {
      return (
        <div className="overview">
          <div className="ov-empty">正在生成项目地图…</div>
        </div>
      );
    }
    return (
      <div className="overview">
        <Welcome variant="first" onOpenReport={onOpenReport} />
      </div>
    );
  }

  const { identity, meta, readme, entries, hot, orphans, largestFiles, largestDirs, cycles, recent, dirs, partial, notes, agentMarks } =
    overview;
  const totalLangFiles = identity.langs.reduce((n, l) => n + l.files, 0) || 1;
  const orphanVisible = orphans.filter((o) => !ignored[o.file]);
  const readCount = Object.keys(read).length;
  const indexing = partial.indexing || status?.indexing === true;

  // 索引还没给出任何事实时，宁可说「正在建立」，也不显示一排 0（共同约束）
  if (indexing && identity.indexedFiles === 0 && identity.langs.length === 0) {
    return (
      <div className="overview">
        <div className="ov-partial">
          <b>正在建立项目地图…</b>
          <span>
            已索引 {partial.filesIndexed}/{partial.filesTotal || '?'} 个文件
            {partial.filesTotal > 0 ? `（${Math.round((partial.progress ?? 0) * 100)}%）` : ''}
          </span>
          <span className="ov-note">
            这一步只是把文件读进索引；跑完语言分布、热点榜、孤立文件与环检测会同时出现。
          </span>
        </div>
        <div className="ov-grid">
          <section className="ov-card">
            <h3>它是什么</h3>
            <div className="ov-stats">
              <Metric value={identity.files} label="个文件（含测试）" note={notes.files?.label} />
              <Metric value={identity.dirs} label="个目录" note={notes.dirs?.label} />
              <Metric value={fmtBytes(identity.bytes)} label="字节" note={notes.bytes?.label} />
            </div>
            <div className="ov-note">规模与目录树来自扫描结果，此刻已可信；其余指标等索引完成。</div>
          </section>
        </div>
      </div>
    );
  }

  // 已打开项目但一个可读文件都没有（全被忽略 / 二进制 / 超大）：同样是引导的落点
  if (!indexing && identity.files === 0) {
    return (
      <div className="overview">
        <Welcome variant="empty" onOpenReport={onOpenReport} />
      </div>
    );
  }

  const open = (file: string, line?: number) => {
    onOpenFile(file, line ?? 1);
    if (!read[file]) toggleRead(file);
  };

  const sortedDirs = [...dirs].sort((a, b) => {
    if (dirSort === 'name') return a.dir.localeCompare(b.dir);
    if (dirSort === 'deps') return b.inboundDirs.length + b.outboundDirs.length - (a.inboundDirs.length + a.outboundDirs.length);
    return b.files - a.files;
  });

  const factsFor = (pick: (f: FileFact) => boolean, sort?: (a: FileFact, b: FileFact) => number) =>
    (facts ?? []).filter(pick).sort(sort);

  return (
    <div className="overview">
      <header className="ov-head">
        <h2>
          项目地图 · <span className="ov-project">{overview.project.name}</span>
        </h2>
        <div className="ov-head-actions">
          {indexing && (
            <span className="ov-indexing" title={partial.notes.join('；')}>
              索引中 {Math.round((partial.progress ?? 0) * 100)}%（{partial.filesIndexed}/{partial.filesTotal}）
            </span>
          )}
          <span className="ov-note" title="所有数字的口径见各自的悬浮说明；点数字可列出构成">
            口径可点
          </span>
          {onOpenReport && (
            <button className="btn ghost" onClick={onOpenReport} title="哪些文件没进索引、为什么">
              索引报告
            </button>
          )}
          <button className="btn ghost" onClick={onOpenGraph}>
            看依赖图 →
          </button>
        </div>
      </header>

      {indexing && (
        <div className="ov-partial">
          <b>还在索引：这是部分地图</b>
          {partial.notes.map((n) => (
            <span key={n} className="ov-note">
              {n}
            </span>
          ))}
        </div>
      )}

      <GuideStart onOpenFile={onOpenFile} />

      {/* W3 / G8.2：自上次阅读以来的变化（与阅读状态、笔记联动） */}
      <ChangesHint onOpenChanges={onOpenChanges} />

      <div className="ov-grid">
        {/* ---------------------------------------------------- 它是什么 */}
        <section className="ov-card">
          <h3>它是什么</h3>
          <div className="ov-langs">
            {identity.langs.map((l) => (
              <div className="ov-lang" key={l.lang}>
                <span className="ov-lang-name">{l.lang}</span>
                <span className="ov-lang-bar">
                  <span
                    className="ov-lang-seg"
                    data-lang={l.lang}
                    style={{ width: `${(l.files / totalLangFiles) * 100}%` }}
                  />
                </span>
                <button
                  className="ov-lang-num ov-metric-btn"
                  title={`点开列出 ${l.lang} 的 ${l.files} 个文件（其中测试 ${l.tests} 个）`}
                  onClick={() =>
                    void openDrawer({
                      kind: 'facts',
                      title: `${l.lang} 的文件（${l.files} 个，含测试 ${l.tests} 个）`,
                      note: '按字节降序；这个数来自文件扩展名归类',
                      pick: (f) => f.lang === l.lang,
                      sort: bySize,
                    })
                  }
                >
                  {l.files} 文件 · {Math.round((l.files / totalLangFiles) * 100)}%
                </button>
              </div>
            ))}
            {!identity.langs.length && <div className="ov-note">没有已索引的源码文件。</div>}
          </div>
          <div className="ov-stats">
            <Metric
              value={identity.files}
              label="文件"
              note={notes.files?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: `全部 ${identity.files} 个文件`, note: notes.files?.label, pick: () => true, sort: bySize })}
            />
            <Metric
              value={identity.dirs}
              label="目录"
              note={notes.dirs?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: `出现的目录（${dirs.length} 个）`, note: notes.dirs?.label, pick: () => false })}
            />
            <Metric
              value={fmtBytes(identity.bytes)}
              label=""
              note={notes.bytes?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: '全部文件按大小降序', note: notes.bytes?.label, pick: () => true, sort: bySize })}
            />
            <Metric
              value={identity.indexedFiles}
              label="索引"
              note={notes.indexedFiles?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: `已进符号索引的 ${identity.indexedFiles} 个文件`, note: notes.indexedFiles?.label, pick: (f) => f.indexed, sort: byLines })}
            />
            <Metric
              value={identity.testFiles}
              label="测试/示例"
              note="按目录名与文件名判定（tests / spec / __tests__ / examples …）"
              onClick={() => void openDrawer({ kind: 'facts', title: `测试 / 示例文件（${identity.testFiles} 个）`, note: '这批文件在热点榜里默认被降噪', pick: (f) => f.test, sort: bySize })}
            />
            <Metric
              value={identity.lines.toLocaleString()}
              label="行"
              note={notes.lines?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: '已索引源码按行数降序', note: notes.lines?.label, pick: (f) => f.indexed, sort: byLines })}
            />
          </div>
          <div className="ov-meta">
            <span>包类型：{meta.kind}</span>
            {meta.name && <span>包名：{meta.name}</span>}
            {meta.modulePath && <span>module：{meta.modulePath}</span>}
            {meta.scripts.length > 0 && <span>脚本：{meta.scripts.slice(0, 6).join(' / ')}</span>}
          </div>
          {readme && (
            <div className="ov-readme">
              <button className="ov-linklike" onClick={() => setShowReadme((v) => !v)}>
                {showReadme ? '收起' : '展开'} README（{readme.path}）
              </button>
              <button className="ov-row-act" onClick={() => onOpenFile(readme.path, 1)}>
                打开全文
              </button>
              {showReadme && <pre className="ov-readme-body">{readme.excerpt}</pre>}
            </div>
          )}
        </section>

        {/* ---------------------------------------------------- 从哪看起 */}
        <section className="ov-card ov-wide">
          <h3>
            从哪看起
            <span className="ov-h3-actions">
              <select
                className="ov-select"
                value={options.hot}
                onChange={(e) => setOptions({ hot: e.target.value as HotMetric })}
                title="热点排序口径（M3.2）：换了口径，榜单会跟着换"
              >
                {(Object.keys(HOT_LABEL) as HotMetric[]).map((key) => (
                  <option key={key} value={key}>
                    {HOT_LABEL[key]}
                  </option>
                ))}
              </select>
              <label className="ov-check">
                <input
                  type="checkbox"
                  checked={options.denoise}
                  onChange={(e) => setOptions({ denoise: e.target.checked })}
                />
                测试/示例降噪
              </label>
            </span>
          </h3>
          {entries.length ? (
            entries.map((e, i) => <EntryRow key={e.file} item={e} rank={i + 1} onOpen={open} />)
          ) : (
            <div className="ov-note">还没算出可读的起点（索引可能没跑完）。</div>
          )}
          {hot.length > 0 && (
            <details className="ov-details">
              <summary>
                热点榜（{HOT_LABEL[options.hot]}，Top {hot.length}）
              </summary>
              {hot.map((h) => (
                <FileRow
                  key={h.file}
                  file={h.file}
                  note={`入度 ${h.inDegree} 文件 · 出度 ${h.outDegree} 文件 · 独有依赖 ${h.uniqueUpstream}`}
                  extra={`${h.lines} 行 · ${h.exports} 个导出 · ${h.longestFunction} 行最长函数`}
                  onOpen={open}
                />
              ))}
              <div className="ov-note">
                口径：{HOT_LABEL[options.hot]}
                {options.denoise ? '（已排除测试 / 示例文件及其引用）' : '（含测试 / 示例）'}。
                「独有依赖」= 只有这个文件提供了某个符号，且有多少个文件在用它。
              </div>
            </details>
          )}
        </section>

        {/* ------------------------------------------- 结构与目录职责 */}
        <section className="ov-card ov-wide">
          <h3>
            结构
            {cycles.length > 0 && <span className="ov-warn">{cycles.length} 处循环依赖</span>}
          </h3>
          <div className="ov-stats">
            <Metric
              value={cycles.length}
              label="处循环依赖"
              note="Tarjan 强连通分量，文件级；只报事实，不给「该重构了」的结论"
              onClick={() => void openDrawer({ kind: 'files', title: '环上的文件', note: '同一个环里的文件互相引用', files: cycles.flat() })}
              tone={cycles.length ? 'warn' : undefined}
            />
            <Metric
              value={orphanVisible.length}
              label="个孤立文件"
              note="入度为 0，且不是入口 / 文档 / 测试 —— 通常可以先跳过"
            />
            <Metric
              value={dirs.length}
              label="个目录"
              note="含根目录；点开看每个目录的职责与依赖面"
            />
          </div>

          {cycles.length > 0 && (
            <details className="ov-details" open>
              <summary>循环依赖（{cycles.length}）</summary>
              {cycles.map((group, i) => (
                <div className="ov-cycle" key={group.join('|')}>
                  <span className="ov-note">
                    环 {i + 1}（{group.length} 个文件）
                  </span>
                  {group.map((f) => (
                    <button key={f} className="ov-chip" onClick={() => open(f)}>
                      {f}
                    </button>
                  ))}
                </div>
              ))}
            </details>
          )}

          {orphanVisible.length > 0 && (
            <details className="ov-details">
              <summary>孤立文件（{orphanVisible.length}）：没人引用，通常可以先跳过</summary>
              {orphanVisible.map((o: OverviewFile) => (
                <FileRow
                  key={o.file}
                  file={o.file}
                  note={`${o.lines} 行 · ${o.defs} 个定义`}
                  extra={fmtBytes(o.size)}
                  onOpen={open}
                  onIgnore={(f) => toggleIgnored(f)}
                />
              ))}
            </details>
          )}

          <details className="ov-details" open>
            <summary>
              目录职责与分层（{dirs.length}）
              <select
                className="ov-select"
                value={dirSort}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDirSort(e.target.value as typeof dirSort)}
              >
                <option value="files">按文件数</option>
                <option value="deps">按依赖面</option>
                <option value="name">按名字</option>
              </select>
            </summary>
            <div className="ov-note">
              分层是按「依赖方向 + 目录名惯例」判的（每条都给了依据），不是架构真值；职责一句话只截取原文，拿不到原文就写事实句。
            </div>
            {sortedDirs.map((d: DirDuty) => (
              <div className="ov-dir" key={d.dir || '.'}>
                <div className="ov-dir-head">
                  <span className={`ov-layer layer-${d.layer}`}>{LAYER_LABEL[d.layer]}</span>
                  <span className="ov-file">{d.dir ? `${d.dir}/` : './'}</span>
                  <span className="ov-note">{d.files} 文件 · {fmtBytes(d.bytes)}</span>
                  <span className="ov-extra" title={d.layerReason}>
                    被 {d.inboundDirs.length} 目录依赖 · 依赖 {d.outboundDirs.length} 目录
                  </span>
                </div>
                <div className="ov-dir-duty">
                  {d.duty}
                  {d.dutyFrom ? (
                    <button className="ov-linklike" onClick={() => open(d.dutyFrom!)}>
                      （据 {d.dutyFrom}）
                    </button>
                  ) : (
                    <span className="ov-note">（事实句）</span>
                  )}
                </div>
                {(d.keyFiles.length > 0 || d.inboundDirs.length > 0) && (
                  <div className="ov-chips">
                    {d.keyFiles.map((f) => (
                      <button key={f} className="ov-chip" onClick={() => open(f)}>
                        {f}
                      </button>
                    ))}
                    {d.inboundDirs.length > 0 && (
                      <span className="ov-note">← 依赖它：{d.inboundDirs.join(' ')}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </details>

          <details className="ov-details">
            <summary>最大文件 Top {largestFiles.length}</summary>
            {largestFiles.map((f) => (
              <FileRow
                key={f.file}
                file={f.file}
                note={`${f.lines} 行 · ${f.lang}`}
                extra={fmtBytes(f.size)}
                onOpen={open}
              />
            ))}
          </details>

          <details className="ov-details">
            <summary>目录规模 / 依赖面 Top {largestDirs.length}</summary>
            {largestDirs.map((d) => (
              <div className="ov-row" key={d.dir || '.'}>
                <span className="ov-file">{d.dir ? `${d.dir}/` : './'}</span>
                <span className="ov-note">
                  {d.files} 文件 · {fmtBytes(d.bytes)} · 被 {d.inbound} 个目录依赖 · 依赖 {d.outbound} 个目录
                </span>
              </div>
            ))}
          </details>

          <details className="ov-details">
            <summary>
              复杂度 Top {sortedComplex.length}
              <select
                className="ov-select"
                value={complexSort}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setComplexSort(e.target.value as typeof complexSort)}
              >
                <option value="branches">按分支数</option>
                <option value="nesting">按嵌套深度</option>
                <option value="longestFunction">按最长函数</option>
                <option value="exports">按导出数</option>
              </select>
            </summary>
            {sortedComplex.map((c) => (
              <FileRow
                key={c.file}
                file={c.file}
                note={`分支 ${c.branches} · 嵌套 ${c.nesting} · 最长函数 ${c.longestFunction} 行 · 平均 ${c.avgFunction} 行`}
                extra={`${c.exports} 导出 · ${c.lines} 行`}
                onOpen={open}
              />
            ))}
            <div className="ov-note">
              分支数是 AST 分支节点的近似圈复杂度，函数长度按定义的行范围算；只给客观计数，不做「该重构了」的裁决。
            </div>
          </details>
        </section>

        {/* ------------------------------------------------------ 最近 */}
        <section className="ov-card ov-wide">
          <h3>最近</h3>
          <div className="ov-stats">
            <Metric
              value={recent.today}
              label="今天"
              note={notes.recent?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: '今天改动过的文件', note: notes.recent?.label, pick: (f) => f.mtimeMs >= new Date().setHours(0, 0, 0, 0), sort: (a, b) => b.mtimeMs - a.mtimeMs })}
            />
            <Metric
              value={recent.last3d}
              label="3 天内"
              note={notes.recent?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: '3 天内改动过的文件', note: notes.recent?.label, pick: (f) => f.mtimeMs >= Date.now() - 3 * 86_400_000, sort: (a, b) => b.mtimeMs - a.mtimeMs })}
            />
            <Metric
              value={recent.last7d}
              label="7 天内"
              note={notes.recent?.label}
              onClick={() => void openDrawer({ kind: 'facts', title: '7 天内改动过的文件', note: notes.recent?.label, pick: (f) => f.mtimeMs >= Date.now() - 7 * 86_400_000, sort: (a, b) => b.mtimeMs - a.mtimeMs })}
            />
            <Metric value={recent.older} label="更早" note={notes.recent?.label} />
          </div>
          {timeline?.source === 'git' && (
            <div className="ov-meta">
              <span>git {timeline.git.branch ?? '（无分支）'}</span>
              {timeline.git.committedAt && <span>最近提交 {fmtWhen(timeline.git.committedAt)}</span>}
              {timeline.git.dirty.length > 0 && <span>未提交 {timeline.git.dirty.length} 个文件</span>}
            </div>
          )}
          {timeline?.source === 'fs' && <div className="ov-note">不是 git 仓库：只看文件修改时间。</div>}

          {agentMarks.length > 0 && (
            <div className="ov-agent-marks">
              <div className="ov-note">
                宿主上报的 agent 产出（{agentMarks.length} 个文件：
                {agentMarks.filter((m) => m.lines.length > 0).length} 个带行范围）
                <button className="ov-row-act" onClick={() => markReadMany(agentMarks.map((m) => m.file))}>
                  全部标记已读
                </button>
              </div>
              <div className="ov-chips">
                {agentMarks.slice(0, 16).map((m) => (
                  <button
                    key={m.file}
                    className="ov-chip is-agent"
                    title={m.lines.length ? `变更行：${m.lines.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')}` : '只标到文件级'}
                    onClick={() => open(m.file, m.lines[0]?.[0] ?? 1)}
                  >
                    ▣ {m.file}
                  </button>
                ))}
                {agentMarks.length > 16 && <span className="ov-note">…等 {agentMarks.length} 个</span>}
              </div>
            </div>
          )}

          <div className="ov-recent">
            {recent.newest.map((f) => (
              <FileRow key={f.file} file={f.file} note={fmtWhen(f.mtimeMs)} onOpen={open} />
            ))}
          </div>
          {timeline && timeline.batches.length > 0 && (
            <details className="ov-details">
              <summary>改动批次（{timeline.batches.length}）</summary>
              {timeline.batches.slice(0, 8).map((b) => (
                <div className="ov-batch" key={`${b.at}:${b.label}`}>
                  <span className="ov-note">
                    {fmtWhen(b.at)} · {b.label ?? '未命名批次'} · {b.files.length} 个文件
                  </span>
                  <div className="ov-chips">
                    {b.files.slice(0, 12).map((f) => (
                      <button key={f} className="ov-chip" onClick={() => open(f)}>
                        {f}
                      </button>
                    ))}
                    {b.files.length > 12 && <span className="ov-note">…等 {b.files.length} 个</span>}
                  </div>
                </div>
              ))}
            </details>
          )}
          {readCount > 0 && <div className="ov-note">已标记读过 {readCount} 个文件（文件树里会变灰）。</div>}
        </section>
      </div>

      {/* 「点数字列出构成」的抽屉 */}
      {drawer && (
        <div className="ov-drawer">
          <div className="ov-drawer-head">
            <b>{drawer.title}</b>
            <button className="ov-row-act" onClick={() => setDrawer(null)}>
              关闭
            </button>
          </div>
          {drawer.note && <div className="ov-note">口径：{drawer.note}</div>}
          {!facts && <div className="ov-note">正在取文件清单…</div>}
          <div className="ov-drawer-body">
            {drawer.kind === 'files' &&
              (drawer.files.length
                ? [...new Set(drawer.files)].map((f) => <FileRow key={f} file={f} onOpen={open} />)
                : <div className="ov-note">没有内容。</div>)}
            {drawer.kind === 'facts' &&
              (() => {
                const list = factsFor(drawer.pick, drawer.sort);
                if (!facts) return null;
                return list.length ? (
                  list.map((f) => (
                    <FileRow
                      key={f.file}
                      file={f.file}
                      note={`${f.lines} 行 · 入度 ${f.inDegree} · 出度 ${f.outDegree}${f.test ? ' · 测试' : ''}`}
                      extra={fmtBytes(f.size)}
                      onOpen={open}
                    />
                  ))
                ) : (
                  <div className="ov-note">没有符合条件的文件。</div>
                );
              })()}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 侧栏「总览」Tab（决策 C：首屏给主页，侧栏保留常驻入口）。
 * 只放最关键的几行：规模、起点 Top 6、结构告警、本轮产出；细看交给完整地图。
 */
export function OverviewPanel({
  onOpenFile,
  onOpenMap,
  onOpenGraph,
}: {
  onOpenFile: (file: string, line?: number) => void;
  onOpenMap: () => void;
  onOpenGraph: () => void;
}) {
  const overview = useMapStore((s) => s.overview);
  const ignored = useMapStore((s) => s.ignored);
  const toggleIgnored = useMapStore((s) => s.toggleIgnored);
  const read = useMapStore((s) => s.read);
  const markReadMany = useMapStore((s) => s.markReadMany);
  /** 侧栏也有「点数字看构成」：环 / 孤立 就地展开，最大直接打开（与主页同一纪律）。 */
  const [openSection, setOpenSection] = useState<'cycles' | 'orphans' | null>(null);

  if (!overview) {
    return <div className="panel-empty">项目地图正在生成…</div>;
  }
  const { identity, entries, orphans, largestFiles, cycles, meta, agentMarks, partial } = overview;
  const orphanVisible = orphans.filter((o) => !ignored[o.file]);
  const unreadMarks = agentMarks.filter((m) => !read[m.file]);

  return (
    <div className="ov-panel">
      <div className="ov-panel-head">
        <span>{meta.name ?? overview.project.name}</span>
        <span className="ov-note">{meta.kind}</span>
      </div>
      {partial.indexing && (
        <div className="ov-note">索引中 {Math.round((partial.progress ?? 0) * 100)}% · 这是部分地图</div>
      )}
      <div className="ov-panel-stats">
        <span>文件 {identity.files}</span>
        <span>目录 {identity.dirs}</span>
        <span>{fmtBytes(identity.bytes)}</span>
      </div>
      <div className="ov-panel-langs">
        {identity.langs.slice(0, 4).map((l) => (
          <span key={l.lang}>
            {l.lang} {l.files}
          </span>
        ))}
      </div>

      {/* M10.3：一轮 agent 产出成组呈现，可批量划掉 */}
      {agentMarks.length > 0 && (
        <>
          <div className="ov-panel-title">
            本轮产出（宿主上报 {agentMarks.length}）
            {unreadMarks.length > 0 && (
              <button className="ov-row-act" onClick={() => markReadMany(unreadMarks.map((m) => m.file))}>
                全标已读
              </button>
            )}
          </div>
          {agentMarks.map((m) => (
            <div className="ov-row" key={m.file}>
              <button className="ov-row-main" onClick={() => onOpenFile(m.file, m.lines[0]?.[0] ?? 1)} title={m.file}>
                <span className="ov-file">{read[m.file] ? '✓ ' : ''}{m.file}</span>
              </button>
              {m.lines.length > 0 && <span className="ov-note">{m.lines.length} 段变更行</span>}
            </div>
          ))}
        </>
      )}

      <div className="ov-panel-title">从哪看起</div>
      {entries.slice(0, 6).map((e, i) => (
        <div className="ov-entry" key={e.file}>
          <span className={`ov-rank ${e.kind}`}>{i + 1}</span>
          <button className="ov-row-main" onClick={() => onOpenFile(e.file, 1)} title={e.file}>
            <span className="ov-file">{e.file}</span>
          </button>
        </div>
      ))}

      <div className="ov-panel-title">结构</div>
      <div className="ov-panel-stats">
        <button
          className={`ov-stat${cycles.length ? ' ov-stat-warn' : ''}`}
          onClick={() => setOpenSection((s) => (s === 'cycles' ? null : 'cycles'))}
          title={cycles.length ? '点开看是哪些文件构成了环' : '没有循环依赖'}
        >
          环 {cycles.length}
        </button>
        <button
          className="ov-stat"
          onClick={() => setOpenSection((s) => (s === 'orphans' ? null : 'orphans'))}
          title={`点开看全部 ${orphanVisible.length} 个孤立文件`}
        >
          孤立 {orphanVisible.length}
        </button>
        {largestFiles[0] && (
          <button
            className="ov-stat"
            onClick={() => onOpenFile(largestFiles[0].file, 1)}
            title={`打开 ${largestFiles[0].file}`}
          >
            最大 {largestFiles[0].lines} 行
          </button>
        )}
      </div>
      {openSection === 'cycles' &&
        (cycles.length ? (
          <div className="ov-sub">
            {cycles.map((cycle, i) => (
              <div className="ov-sub-row" key={`${i}-${cycle.join('>')}`}>
                <div className="ov-note">
                  环 {i + 1} · {cycle.length} 个文件
                </div>
                {cycle.map((f) => (
                  <button className="ov-row-main" key={f} onClick={() => onOpenFile(f, 1)} title={f}>
                    <span className="ov-file">{f}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="ov-note">没有循环依赖。</div>
        ))}
      {(openSection === 'orphans' ? orphanVisible : orphanVisible.slice(0, 3)).map((o) => (
        <div className="ov-row" key={o.file}>
          <button className="ov-row-main" onClick={() => onOpenFile(o.file, 1)} title={o.file}>
            <span className="ov-file">{o.file}</span>
          </button>
          <button className="ov-row-act" onClick={() => toggleIgnored(o.file)}>
            忽略
          </button>
        </div>
      ))}

      <div className="ov-panel-actions">
        <button className="btn ghost" onClick={onOpenMap}>
          完整地图
        </button>
        <button className="btn ghost" onClick={onOpenGraph}>
          依赖图
        </button>
      </div>
    </div>
  );
}
