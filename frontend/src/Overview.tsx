/**
 * 概览首页（01-map 形态一）：打开项目先看到一张「项目地图」。
 *
 * 三条纪律（对齐 docs/01-map.md §7 的共同约束）：
 * 1) 每个数字都能点开看到构成 —— 点数字会拉一次 `?files=1` 并列出具体文件，杜绝不可核对的汇总；
 * 2) 不阻塞首屏 —— 索引未完成时给「部分地图 + 进度」，且绝不把「还没索引到」显示成 0；
 * 3) 只陈列索引与文件系统里能确认的事实（不生成式摘要、不做优劣裁决）。
 */
import { useMemo, useState } from 'react';
import { langLabel, langSegStyle } from './languages';
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
import { useChangesStore } from './changesState';
import { useI18n } from './i18n';
import { Welcome } from './Welcome';
import './overview.css';
import './guide.css';

interface Props {
  onOpenFile: (file: string, line?: number) => void;
  onOpenGraph: () => void;
  /** W3 / G8：切到变更面板（「看全部 →」）。 */
  onOpenChanges?: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** M3.2 六档口径的中文说明。 */
const HOT_LABEL: Record<HotMetric, string> = {
  files: 'overview.hotFiles',
  refs: 'overview.hotRefs',
  symbols: 'overview.hotSymbols',
  defined: 'overview.hotDefined',
  unique: 'overview.hotUnique',
  recent: 'overview.hotRecent',
};

/** 分层名字（M4.2）。 */
const LAYER_LABEL: Record<GraphLayer, string> = {
  entry: 'layer.entry',
  domain: 'layer.domain',
  infra: 'layer.infra',
  utility: 'layer.utility',
  isolated: 'layer.isolated',
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
  const { t } = useI18n();
  return (
    <div className="ov-row">
      <button className="ov-row-main" onClick={() => onOpen(file)} title={file}>
        <span className="ov-file">{file}</span>
        {note && <span className="ov-note">{note}</span>}
      </button>
      {extra && <span className="ov-extra">{extra}</span>}
      {onIgnore && (
        <button className="ov-row-act" onClick={() => onIgnore(file)} title={t('overview.ignoreTitle')}>
          {t('guide.nav.ignore')}
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
  const { t } = useI18n();
  return (
    <div className="ov-entry">
      <span className={`ov-rank ${item.kind}`}>{rank}</span>
      <button className="ov-row-main" onClick={() => onOpen(item.file)} title={item.file}>
        <span className="ov-file">{item.file}</span>
      </button>
      {item.kind === 'entry' && <span className="ov-badge entry">{t('flow.badgeEntry')}</span>}
      <span className="ov-extra">{t('overview.linesCount', { n: item.lines })}</span>
      {/* 理由换行另起一行：半宽卡片里挤在同一行只会被省略号吃掉（2026-10-03 布局） */}
      <span className="ov-note ov-entry-why">{item.reasons.join(' · ') || '—'}</span>
    </div>
  );
}

/** G1.1–G1.4 / G2：总览顶部「从这里开始」——推荐路线 / 继续阅读。 */
function GuideStart({ onOpenFile }: { onOpenFile: (file: string, line?: number) => void }) {
  const { t } = useI18n();
  const routes = useGuideStore((s) => s.routes);
  const kind = useGuideStore((s) => s.kind);
  const setKind = useGuideStore((s) => s.setKind);
  const readstate = useGuideStore((s) => s.readstate);

  const route = routes?.routes.find((r) => r.kind === kind) ?? null;
  const steps = route?.steps.slice(0, 6) ?? [];

  const cycle = () => {
    const i = ROUTE_KINDS.indexOf(kind);
    setKind(ROUTE_KINDS[(i + 1) % ROUTE_KINDS.length]);
  };

  return (
    <section className="ov-card guide-start-card tone-guide">
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
      </div>
    </section>
  );
}

/**
 * 变更摘要卡（2026-10-03：改为**以 git 为准**）。
 *
 * 显示「几个未提交改动」+ 分支名 + 增删行；不是 git 仓库就如实说，
 * 不再有「记录阅读基线」那种自记录对比（用户要求：不自己记录变更）。
 */
function ChangesHint({
  onOpenChanges,
  onOpen,
}: {
  onOpenChanges?: () => void;
  /** 点「本轮 agent 产出」的 chip：打开文件（与主页其它入口同一条口径）。 */
  onOpen: (file: string, line?: number) => void;
}) {
  const { t } = useI18n();
  const result = useChangesStore((s) => s.result);
  const busy = useChangesStore((s) => s.busy);
  const refresh = useChangesStore((s) => s.refresh);
  /** M10.3：宿主上报的 agent 产出（原「最近」卡的内容，2026-10-03 并进变更卡）。 */
  const agentMarks = useMapStore((s) => s.overview?.agentMarks ?? []);
  /** G8.1：SSE 报过的文件（20 秒后自动消失）——只说「刚有变更」，不描述变了什么。 */
  const pulse = useMapStore((s) => s.pulse);

  const entries = result?.entries ?? [];
  const added = entries.reduce((n, e) => n + (e.added ?? 0), 0);
  const removed = entries.reduce((n, e) => n + (e.removed ?? 0), 0);

  return (
    <section className="ov-card ov-wide changes-card tone-changes">
      <h3>{t('changes.startTitle')}</h3>
      <div className="guide-start">
        {Object.keys(pulse).length > 0 && (
          <div className="guide-start-row">
            <span className="changes-live-inline">{t('changes.live', { n: Object.keys(pulse).length })}</span>
            <button className="btn ghost small" onClick={() => void refresh()} disabled={busy}>
              {t('changes.refresh')}
            </button>
          </div>
        )}
        {result && !result.isRepo && <div className="guide-muted">{t('changes.noGit')}</div>}
        {result?.isRepo && (
          <div className="guide-start-row">
            <b>{entries.length > 0 ? t('changes.startChanged', { n: entries.length }) : t('changes.empty')}</b>
            <span className="guide-muted">
              {t('overview.branch', { name: result.branch ?? t('overview.noCommit') })}
            </span>
            {(added > 0 || removed > 0) && (
              <span className="guide-muted">{t('changes.lines', { added, removed })}</span>
            )}
            <span className="spacer" />
            <button className="btn ghost small" onClick={onOpenChanges} disabled={!onOpenChanges}>
              {t('changes.seeAll')}
            </button>
          </div>
        )}
        {!result && (
          <div className="guide-start-row">
            <span className="guide-muted">{busy ? t('overview.reading') : t('changes.noGit')}</span>
            <span className="spacer" />
            <button className="btn ghost small" onClick={() => void refresh()} disabled={busy}>
              {t('changes.refresh')}
            </button>
          </div>
        )}
        {agentMarks.length > 0 && (
          <div className="ov-agent-marks">
            <div className="ov-note">
              {t('overview.agentRound', {
                files: agentMarks.length,
                ranged: agentMarks.filter((m) => m.lines.length > 0).length,
              })}
            </div>
            <div className="ov-chips">
              {agentMarks.slice(0, 16).map((m) => (
                <button
                  key={m.file}
                  className="ov-chip is-agent"
                  title={m.lines.length
                    ? t('overview.changedLines', { list: m.lines.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ') })
                    : t('overview.fileLevelOnly')}
                  onClick={() => onOpen(m.file, m.lines[0]?.[0] ?? 1)}
                >
                  ▣ {m.file}
                </button>
              ))}
              {agentMarks.length > 16 && (
                <span className="ov-note">{t('overview.moreItems', { n: agentMarks.length })}</span>
              )}
            </div>
          </div>
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

/** 首屏指标带里的一个方块：数字在上、口径在下；能点开的仍然点开看构成。 */
function Stat({
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
  const inner = (
    <>
      <b>{value}</b>
      <span>{label}</span>
    </>
  );
  const cls = `ov-stat-block${onClick ? ' is-clickable' : ''}${tone ? ` ${tone}` : ''}`;
  return onClick ? (
    <button className={cls} title={note ?? label} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <span className={cls} title={note ?? label}>
      {inner}
    </span>
  );
}

export function Overview({ onOpenFile, onOpenGraph, onOpenChanges }: Props) {
  const { t } = useI18n();
  const overview = useMapStore((s) => s.overview);
  const busy = useMapStore((s) => s.busy);
  const options = useMapStore((s) => s.options);
  const setOptions = useMapStore((s) => s.setOptions);
  const toggleIgnored = useMapStore((s) => s.toggleIgnored);
  const ignored = useMapStore((s) => s.ignored);
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
          <div className="ov-empty">{t('overview.generatingMap')}</div>
        </div>
      );
    }
    return (
      <div className="overview">
        <Welcome variant="first" />
      </div>
    );
  }

  const { identity, meta, readme, entries, hot, orphans, largestFiles, largestDirs, cycles, dirs, partial, notes } =
    overview;
  const totalLangFiles = identity.langs.reduce((n, l) => n + l.files, 0) || 1;
  const orphanVisible = orphans.filter((o) => !ignored[o.file]);
  const indexing = partial.indexing || status?.indexing === true;

  // 索引还没给出任何事实时，宁可说「正在建立」，也不显示一排 0（共同约束）
  if (indexing && identity.indexedFiles === 0 && identity.langs.length === 0) {
    return (
      <div className="overview">
        <div className="ov-partial">
          <b>{t('overview.buildingMap')}</b>
          <span>
            {t('overview.indexedFiles', { indexed: partial.filesIndexed, total: partial.filesTotal || '?' })}
            {partial.filesTotal > 0 ? t('overview.percentParen', { n: Math.round((partial.progress ?? 0) * 100) }) : ''}
          </span>
          <span className="ov-note">{t('overview.buildingMapNote')}</span>
        </div>
        <div className="ov-grid">
          <section className="ov-card">
            <h3>{t('explain.target')}</h3>
            <div className="ov-stats">
              <Metric value={identity.files} label={t('overview.filesWithTests')} note={notes.files?.label} />
              <Metric value={identity.dirs} label={t('overview.dirCountLabel')} note={notes.dirs?.label} />
              <Metric value={fmtBytes(identity.bytes)} label={t('overview.bytesLabel')} note={notes.bytes?.label} />
            </div>
            <div className="ov-note">{t('overview.scaleNote')}</div>
          </section>
        </div>
      </div>
    );
  }

  // 已打开项目但一个可读文件都没有（全被忽略 / 二进制 / 超大）：同样是引导的落点
  if (!indexing && identity.files === 0) {
    return (
      <div className="overview">
        <Welcome variant="empty" />
      </div>
    );
  }

  const open = (file: string, line?: number) => {
    onOpenFile(file, line ?? 1);
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
          {t('app.projectMap')} · <span className="ov-project">{overview.project.name}</span>
        </h2>
        <div className="ov-head-actions">
          {indexing && (
            <span className="ov-indexing" title={partial.notes.join('；')}>
              {t('topbar.indexing', {
                percent: Math.round((partial.progress ?? 0) * 100),
                indexed: partial.filesIndexed,
                total: partial.filesTotal,
              })}
            </span>
          )}
          <span className="ov-note" title={t('overview.metricsNoteTitle')}>
            {t('overview.metricsClickable')}
          </span>
          <button className="btn ghost" onClick={onOpenGraph}>
            {t('overview.seeGraph')}
          </button>
        </div>
      </header>

      {indexing && (
        <div className="ov-partial">
          <b>{t('overview.partialMap')}</b>
          {partial.notes.map((n) => (
            <span key={n} className="ov-note">
              {n}
            </span>
          ))}
        </div>
      )}

      {/* 首屏指标带：规模数字从「它是什么」提到这里，滚动之前就能看到量级（2026-10-03 布局优化）。 */}
      <section className="ov-metrics">
        <Stat
          value={identity.files}
          label={t('overview.statFiles')}
          note={notes.files?.label}
          onClick={() => void openDrawer({ kind: 'facts', title: t('overview.allFilesTitle', { n: identity.files }), note: notes.files?.label, pick: () => true, sort: bySize })}
        />
        <Stat
          value={identity.dirs}
          label={t('overview.statDirs')}
          note={notes.dirs?.label}
          onClick={() => void openDrawer({ kind: 'facts', title: t('overview.dirsTitle', { n: dirs.length }), note: notes.dirs?.label, pick: () => false })}
        />
        <Stat
          value={identity.lines.toLocaleString()}
          label={t('overview.statLines')}
          note={notes.lines?.label}
          onClick={() => void openDrawer({ kind: 'facts', title: t('overview.indexedByLines'), note: notes.lines?.label, pick: (f) => f.indexed, sort: byLines })}
        />
        <Stat
          value={fmtBytes(identity.bytes)}
          label={t('overview.statSize')}
          note={notes.bytes?.label}
          onClick={() => void openDrawer({ kind: 'facts', title: t('overview.allBySize'), note: notes.bytes?.label, pick: () => true, sort: bySize })}
        />
        <Stat
          value={identity.indexedFiles}
          label={t('overview.statSymbolIndex')}
          note={notes.indexedFiles?.label}
          onClick={() => void openDrawer({ kind: 'facts', title: t('overview.indexedFilesTitle', { n: identity.indexedFiles }), note: notes.indexedFiles?.label, pick: (f) => f.indexed, sort: byLines })}
        />
        <Stat
          value={identity.testFiles}
          label={t('overview.statTests')}
          note={t('overview.testsNote')}
          onClick={() => void openDrawer({ kind: 'facts', title: t('overview.testFilesTitle', { n: identity.testFiles }), note: t('overview.testFilesNote'), pick: (f) => f.test, sort: bySize })}
        />
      </section>

      {/* W3 / G8.2：自上次阅读以来的变化（与阅读状态、笔记联动） */}
      <ChangesHint onOpenChanges={onOpenChanges} onOpen={open} />

      <div className="ov-grid">
        {/* 从这里开始：半宽，与「它是什么」同排（两张卡高度接近，不留空列）。 */}
        <GuideStart onOpenFile={onOpenFile} />

        {/* ---------------------------------------------------- 它是什么 */}
        <section className="ov-card tone-identity">
          <h3>
            {t('explain.target')}
            <span className="ov-h3-note">{t('overview.langCount', { n: identity.langs.length })}</span>
          </h3>
          <div className="ov-langs">
            {identity.langs.map((l) => (
              <div className="ov-lang" key={l.lang}>
                <span className="ov-lang-name">{langLabel(l.lang)}</span>
                <span className="ov-lang-bar">
                  <span
                    className="ov-lang-seg"
                    data-lang={l.lang}
                    style={{ width: `${(l.files / totalLangFiles) * 100}%`, ...langSegStyle(l.lang) }}
                  />
                </span>
                <button
                  className="ov-lang-num ov-metric-btn"
                  title={t('overview.langFilesTitle', { lang: langLabel(l.lang), files: l.files, tests: l.tests })}
                  onClick={() =>
                    void openDrawer({
                      kind: 'facts',
                      title: t('overview.langFilesDrawer', { lang: langLabel(l.lang), files: l.files, tests: l.tests }),
                      note: t('overview.langFilesNote'),
                      pick: (f) => f.lang === l.lang,
                      sort: bySize,
                    })
                  }
                >
                  {t('overview.langStat', { files: l.files, percent: Math.round((l.files / totalLangFiles) * 100) })}
                </button>
              </div>
            ))}
            {!identity.langs.length && <div className="ov-note">{t('overview.noIndexedSources')}</div>}
          </div>
          <div className="ov-meta">
            <span>{t('overview.pkgKind', { kind: meta.kind })}</span>
            {meta.name && <span>{t('overview.pkgName', { name: meta.name })}</span>}
            {meta.modulePath && <span>module：{meta.modulePath}</span>}
            {meta.scripts.length > 0 && <span>{t('overview.pkgScripts', { list: meta.scripts.slice(0, 6).join(' / ') })}</span>}
          </div>
          {readme && (
            <div className="ov-readme">
              <button className="ov-linklike" onClick={() => setShowReadme((v) => !v)}>
                {t(showReadme ? 'overview.readmeCollapse' : 'overview.readmeExpand', { path: readme.path })}
              </button>
              <button className="ov-row-act" onClick={() => onOpenFile(readme.path, 1)}>
                {t('overview.openFullText')}
              </button>
              {showReadme && <pre className="ov-readme-body">{readme.excerpt}</pre>}
            </div>
          )}
        </section>

        {/* ---------------------------------------------------- 从哪看起 */}
        <section className="ov-card ov-wide tone-entry">
          <h3>
            {t('overview.whereToStart')}
            <span className="ov-h3-actions">
              <select
                className="ov-select"
                value={options.hot}
                onChange={(e) => setOptions({ hot: e.target.value as HotMetric })}
                title={t('overview.hotSortTitle')}
              >
                {(Object.keys(HOT_LABEL) as HotMetric[]).map((key) => (
                  <option key={key} value={key}>
                    {t(HOT_LABEL[key])}
                  </option>
                ))}
              </select>
              <label className="ov-check">
                <input
                  type="checkbox"
                  checked={options.denoise}
                  onChange={(e) => setOptions({ denoise: e.target.checked })}
                />
                {t('overview.denoise')}
              </label>
            </span>
          </h3>
          {entries.length ? (
            entries.map((e, i) => <EntryRow key={e.file} item={e} rank={i + 1} onOpen={open} />)
          ) : (
            <div className="ov-note">{t('overview.noEntries')}</div>
          )}
          {hot.length > 0 && (
            <details className="ov-details">
              <summary>
                {t('overview.hotTitle', { label: t(HOT_LABEL[options.hot]), n: hot.length })}
              </summary>
              {hot.map((h) => (
                <FileRow
                  key={h.file}
                  file={h.file}
                  note={t('overview.hotRowNote', { inDegree: h.inDegree, outDegree: h.outDegree, unique: h.uniqueUpstream })}
                  extra={t('overview.hotRowExtra', { lines: h.lines, exports: h.exports, longest: h.longestFunction })}
                  onOpen={open}
                />
              ))}
              <div className="ov-note">
                {t('overview.hotNote', {
                  label: t(HOT_LABEL[options.hot]),
                  scope: t(options.denoise ? 'overview.denoiseOn' : 'overview.denoiseOff'),
                })}
              </div>
            </details>
          )}
        </section>

        {/* ------------------------------------------- 结构与目录职责 */}
        <section className="ov-card ov-wide tone-structure">
          <h3>
            {t('overview.structure')}
            {cycles.length > 0 && <span className="ov-warn">{t('overview.cycleWarn', { n: cycles.length })}</span>}
          </h3>
          <div className="ov-stats">
            <Metric
              value={cycles.length}
              label={t('overview.cycleLabel')}
              note={t('overview.cycleNote')}
              onClick={() => void openDrawer({ kind: 'files', title: t('overview.filesInCycle'), note: t('overview.cycleFilesNote'), files: cycles.flat() })}
              tone={cycles.length ? 'warn' : undefined}
            />
            <Metric
              value={orphanVisible.length}
              label={t('overview.orphanLabel')}
              note={t('overview.orphanNote')}
            />
            <Metric
              value={dirs.length}
              label={t('overview.dirCountLabel')}
              note={t('overview.dirMetricNote')}
            />
          </div>

          {cycles.length > 0 && (
            <details className="ov-details" open>
              <summary>{t('overview.cyclesTitle', { n: cycles.length })}</summary>
              {cycles.map((group, i) => (
                <div className="ov-cycle" key={group.join('|')}>
                  <span className="ov-note">
                    {t('overview.cycleN', { n: i + 1, files: group.length })}
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
              <summary>{t('overview.orphansTitle', { n: orphanVisible.length })}</summary>
              {orphanVisible.map((o: OverviewFile) => (
                <FileRow
                  key={o.file}
                  file={o.file}
                  note={t('overview.orphanRowNote', { lines: o.lines, defs: o.defs })}
                  extra={fmtBytes(o.size)}
                  onOpen={open}
                  onIgnore={(f) => toggleIgnored(f)}
                />
              ))}
            </details>
          )}

          <details className="ov-details">
            <summary>
              {t('overview.dirDutyTitle', { n: dirs.length })}
              <select
                className="ov-select"
                value={dirSort}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDirSort(e.target.value as typeof dirSort)}
              >
                <option value="files">{t('overview.sortByFiles')}</option>
                <option value="deps">{t('overview.sortByDeps')}</option>
                <option value="name">{t('overview.sortByName')}</option>
              </select>
            </summary>
            <div className="ov-note">{t('overview.dirDutyNote')}</div>
            {sortedDirs.map((d: DirDuty) => (
              <div className="ov-dir" key={d.dir || '.'}>
                <div className="ov-dir-head">
                  <span className={`ov-layer layer-${d.layer}`}>{t(LAYER_LABEL[d.layer])}</span>
                  <span className="ov-file">{d.dir ? `${d.dir}/` : './'}</span>
                  <span className="ov-note">{t('overview.dirStat', { files: d.files, bytes: fmtBytes(d.bytes) })}</span>
                  <span className="ov-extra" title={d.layerReason}>
                    {t('overview.dirDeps', { inbound: d.inboundDirs.length, outbound: d.outboundDirs.length })}
                  </span>
                </div>
                <div className="ov-dir-duty">
                  {d.duty}
                  {d.dutyFrom ? (
                    <button className="ov-linklike" onClick={() => open(d.dutyFrom!)}>
                      {t('overview.dutyFrom', { from: d.dutyFrom })}
                    </button>
                  ) : (
                    <span className="ov-note">{t('overview.dutyFact')}</span>
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
                      <span className="ov-note">{t('overview.inboundDirs', { dirs: d.inboundDirs.join(' ') })}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </details>

          <details className="ov-details">
            <summary>{t('overview.largestFilesTitle', { n: largestFiles.length })}</summary>
            {largestFiles.map((f) => (
              <FileRow
                key={f.file}
                file={f.file}
                note={t('overview.fileRowNote', { lines: f.lines, lang: f.lang })}
                extra={fmtBytes(f.size)}
                onOpen={open}
              />
            ))}
          </details>

          <details className="ov-details">
            <summary>{t('overview.largestDirsTitle', { n: largestDirs.length })}</summary>
            {largestDirs.map((d) => (
              <div className="ov-row" key={d.dir || '.'}>
                <span className="ov-file">{d.dir ? `${d.dir}/` : './'}</span>
                <span className="ov-note">
                  {t('overview.dirRowNote', { files: d.files, bytes: fmtBytes(d.bytes), inbound: d.inbound, outbound: d.outbound })}
                </span>
              </div>
            ))}
          </details>

          <details className="ov-details">
            <summary>
              {t('overview.complexTitle', { n: sortedComplex.length })}
              <select
                className="ov-select"
                value={complexSort}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setComplexSort(e.target.value as typeof complexSort)}
              >
                <option value="branches">{t('overview.sortByBranches')}</option>
                <option value="nesting">{t('overview.sortByNesting')}</option>
                <option value="longestFunction">{t('overview.sortByLongest')}</option>
                <option value="exports">{t('overview.sortByExports')}</option>
              </select>
            </summary>
            {sortedComplex.map((c) => (
              <FileRow
                key={c.file}
                file={c.file}
                note={t('overview.complexRowNote', { branches: c.branches, nesting: c.nesting, longest: c.longestFunction, avg: c.avgFunction })}
                extra={t('overview.complexRowExtra', { exports: c.exports, lines: c.lines })}
                onOpen={open}
              />
            ))}
            <div className="ov-note">{t('overview.complexNote')}</div>
          </details>
        </section>

      </div>

      {/* 「点数字列出构成」的抽屉 */}
      {drawer && (
        <div className="ov-drawer">
          <div className="ov-drawer-head">
            <b>{drawer.title}</b>
            <button className="ov-row-act" onClick={() => setDrawer(null)}>
              {t('common.close')}
            </button>
          </div>
          {drawer.note && <div className="ov-note">{t('overview.drawerNote', { note: drawer.note })}</div>}
          {!facts && <div className="ov-note">{t('overview.loadingFacts')}</div>}
          <div className="ov-drawer-body">
            {drawer.kind === 'files' &&
              (drawer.files.length
                ? [...new Set(drawer.files)].map((f) => <FileRow key={f} file={f} onOpen={open} />)
                : <div className="ov-note">{t('overview.noContent')}</div>)}
            {drawer.kind === 'facts' &&
              (() => {
                const list = factsFor(drawer.pick, drawer.sort);
                if (!facts) return null;
                return list.length ? (
                  list.map((f) => (
                    <FileRow
                      key={f.file}
                      file={f.file}
                      note={`${t('overview.factRowNote', { lines: f.lines, inDegree: f.inDegree, outDegree: f.outDegree })}${f.test ? t('overview.testSuffix') : ''}`}
                      extra={fmtBytes(f.size)}
                      onOpen={open}
                    />
                  ))
                ) : (
                  <div className="ov-note">{t('overview.noMatchingFiles')}</div>
                );
              })()}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 「总览」面板（决策 C：首屏给主页，另留一个常驻入口）。
 * 2026-10-03 起挂在右侧常驻栏（与变更 / 命令并排），不再是侧栏 tab。
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
  const { t } = useI18n();
  const overview = useMapStore((s) => s.overview);
  const ignored = useMapStore((s) => s.ignored);
  const toggleIgnored = useMapStore((s) => s.toggleIgnored);
  /** 侧栏也有「点数字看构成」：环 / 孤立 就地展开，最大直接打开（与主页同一纪律）。 */
  const [openSection, setOpenSection] = useState<'cycles' | 'orphans' | null>(null);

  if (!overview) {
    return <div className="panel-empty">{t('overview.mapGenerating')}</div>;
  }
  const { identity, entries, orphans, largestFiles, cycles, meta, agentMarks, partial } = overview;
  const orphanVisible = orphans.filter((o) => !ignored[o.file]);

  return (
    <div className="ov-panel">
      <div className="ov-panel-head">
        <span>{meta.name ?? overview.project.name}</span>
        <span className="ov-note">{meta.kind}</span>
      </div>
      {partial.indexing && (
        <div className="ov-note">{t('overview.indexingPartial', { percent: Math.round((partial.progress ?? 0) * 100) })}</div>
      )}
      <div className="ov-panel-stats">
        <span>{t('overview.panelFiles', { n: identity.files })}</span>
        <span>{t('overview.panelDirs', { n: identity.dirs })}</span>
        <span>{fmtBytes(identity.bytes)}</span>
      </div>
      <div className="ov-panel-langs">
        {identity.langs.slice(0, 4).map((l) => (
          <span key={l.lang}>
            {l.lang} {l.files}
          </span>
        ))}
      </div>

      {/* M10.3：一轮 agent 产出成组呈现 */}
      {agentMarks.length > 0 && (
        <>
          <div className="ov-panel-title">
            {t('overview.panelAgentTitle', { n: agentMarks.length })}
          </div>
          {agentMarks.map((m) => (
            <div className="ov-row" key={m.file}>
              <button className="ov-row-main" onClick={() => onOpenFile(m.file, m.lines[0]?.[0] ?? 1)} title={m.file}>
                <span className="ov-file">{m.file}</span>
              </button>
              {m.lines.length > 0 && <span className="ov-note">{t('overview.changedLineSegments', { n: m.lines.length })}</span>}
            </div>
          ))}
        </>
      )}

      <div className="ov-panel-title">{t('overview.whereToStart')}</div>
      {entries.slice(0, 6).map((e, i) => (
        <div className="ov-entry" key={e.file}>
          <span className={`ov-rank ${e.kind}`}>{i + 1}</span>
          <button className="ov-row-main" onClick={() => onOpenFile(e.file, 1)} title={e.file}>
            <span className="ov-file">{e.file}</span>
          </button>
        </div>
      ))}

      <div className="ov-panel-title">{t('overview.structure')}</div>
      <div className="ov-panel-stats">
        <button
          className={`ov-stat${cycles.length ? ' ov-stat-warn' : ''}`}
          onClick={() => setOpenSection((s) => (s === 'cycles' ? null : 'cycles'))}
          title={cycles.length ? t('overview.cyclesOpenTitle') : t('overview.noCycles')}
        >
          {t('overview.cyclesCount', { n: cycles.length })}
        </button>
        <button
          className="ov-stat"
          onClick={() => setOpenSection((s) => (s === 'orphans' ? null : 'orphans'))}
          title={t('overview.orphansOpenTitle', { n: orphanVisible.length })}
        >
          {t('overview.orphansCount', { n: orphanVisible.length })}
        </button>
        {largestFiles[0] && (
          <button
            className="ov-stat"
            onClick={() => onOpenFile(largestFiles[0].file, 1)}
            title={t('overview.openFileTitle', { file: largestFiles[0].file })}
          >
            {t('overview.largestCount', { n: largestFiles[0].lines })}
          </button>
        )}
      </div>
      {openSection === 'cycles' &&
        (cycles.length ? (
          <div className="ov-sub">
            {cycles.map((cycle, i) => (
              <div className="ov-sub-row" key={`${i}-${cycle.join('>')}`}>
                <div className="ov-note">
                  {t('overview.cycleRow', { n: i + 1, files: cycle.length })}
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
          <div className="ov-note">{t('overview.noCyclesDot')}</div>
        ))}
      {(openSection === 'orphans' ? orphanVisible : orphanVisible.slice(0, 3)).map((o) => (
        <div className="ov-row" key={o.file}>
          <button className="ov-row-main" onClick={() => onOpenFile(o.file, 1)} title={o.file}>
            <span className="ov-file">{o.file}</span>
          </button>
          <button className="ov-row-act" onClick={() => toggleIgnored(o.file)}>
            {t('overview.ignore')}
          </button>
        </div>
      ))}

      <div className="ov-panel-actions">
        <button className="btn ghost" onClick={onOpenMap}>
          {t('overview.fullMap')}
        </button>
        <button className="btn ghost" onClick={onOpenGraph}>
          {t('overview.depGraph')}
        </button>
      </div>
    </div>
  );
}
