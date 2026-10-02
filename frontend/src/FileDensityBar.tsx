/** 行密度概览条（02-lens §3.4 / L10）：贴 minimap 左缘，把整文件压成一条可扫的带子。
 *  只统计每段的代码 / 注释 / 空白行占比，与 01 地图的「符号密度（每文件定义数）」不是一个概念。 */
import { useEffect, useState } from 'react';
import type { DensitySegment, FileDensity } from './api';
import { api } from './api';

interface Props {
  projectId: string | null;
  file: string | null;
  /** 索引完成 / 文件变更时 +1，用于重拉密度。 */
  highlightsToken: number;
  /** 距编辑器容器右缘的像素（minimap + 纵向滚动条宽度），由 Editor 按布局给出。 */
  rightInset: number;
  /** 点击某格：跳到该段起始行。 */
  onJump: (line: number) => void;
}

/**
 * 三档配色口径（只回答「这一段是什么」，不评价好坏）：
 * - 注释堆 comment：注释占比 ≥ 0.45 且不低于代码占比；
 * - 空壳 blank：空白占比 ≥ 0.45 且不低于代码占比（声明多、实现少的段空白必然多）；
 * - 代码密 code：其余情况，含三项都低时的兜底。
 */
function tierOf(seg: DensitySegment): 'code' | 'comment' | 'blank' {
  if (seg.comment >= 0.45 && seg.comment >= seg.code) return 'comment';
  if (seg.blank >= 0.45 && seg.blank >= seg.code) return 'blank';
  return 'code';
}

/** tooltip：段起止行 + 主要符号名（没有符号就只给行区间）。 */
function segTitle(seg: DensitySegment): string {
  const range = `第 ${seg.startLine}-${seg.endLine} 行`;
  return seg.symbols.length ? `${range} · ${seg.symbols.join('、')}` : range;
}

export function FileDensityBar({ projectId, file, highlightsToken, rightInset, onJump }: Props) {
  const [density, setDensity] = useState<FileDensity | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!projectId || !file) return;
    let cancelled = false;
    void api
      .density(projectId, file)
      .then((res) => {
        if (!cancelled) setDensity(res);
      })
      .catch(() => {
        /* 密度拿不到不影响阅读，静默 */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, file, highlightsToken]);

  if (!file) return null; // 没有打开文件就不渲染
  // 只认当前文件的统计：切换文件时旧数据不显示，也不必额外清 state
  const shown = density?.file === file ? density : null;
  const segments = shown?.segments ?? [];

  return (
    <div
      className={`density-bar${collapsed ? ' collapsed' : ''}`}
      style={{ right: rightInset }}
      title="行密度（代码 / 注释 / 空白占比）：悬停看行区间与主要符号，点击跳到该段起始行"
    >
      <button
        className="density-toggle"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? '展开行密度' : '收起行密度'}
      >
        {collapsed ? '‹' : '›'}
      </button>
      {!collapsed && segments.length > 0 && (
        <div className="density-track">
          {segments.map((seg) => (
            <div
              key={seg.startLine}
              className={`density-seg density-${tierOf(seg)}`}
              title={segTitle(seg)}
              onClick={() => onJump(seg.startLine)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
