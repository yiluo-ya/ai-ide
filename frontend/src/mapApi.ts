/**
 * 项目地图（01-map）的 API 客户端。
 *
 * 单独成文件的原因很实际：`api.ts` 正被其它主题（02 透镜 / 03 导航）持续扩展，
 * 地图这组请求放在这里可以避免互相踩到；共用的 `request` 从 api.ts 引入，不另起一套错误处理。
 */
import type {
  DependencyGraph,
  DependentsResult,
  DirDependentsResult,
  HotMetric,
  ProjectOverview,
  ProjectTimeline,
} from '../../shared/types';
import { request } from './api';

export type {
  DependencyGraph,
  DependentsResult,
  DirDependentsResult,
  HotMetric,
  ProjectOverview,
  ProjectTimeline,
};

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
};

export const mapApi = {
  /** 概览（M1/M2/M3/M8/M11）：身份卡 / 从哪看起 / 热点 / 孤立 / 环 / 最近改动。 */
  overview: (
    id: string,
    options: { hot?: HotMetric; denoise?: boolean; limit?: number; files?: boolean } = {},
  ) =>
    request<ProjectOverview>(
      `/projects/${id}/overview${qs({
        hot: options.hot,
        denoise: options.denoise === false ? '0' : undefined,
        limit: options.limit,
        files: options.files ? '1' : undefined,
      })}`,
    ),

  /** 目录级反向依赖（M6.2）：我动的这块，外面有几个入口依赖。 */
  dirDependents: (id: string, dir: string, depth = 2) =>
    request<DirDependentsResult>(
      `/projects/${id}/dir-dependents?dir=${encodeURIComponent(dir.replace(/\/+$/, '') || '.')}&depth=${depth}`,
    ),

  /** 某个文件被宿主声明的 agent 变更行（M10.2）。 */
  agentLines: (id: string, file: string) =>
    request<{ file: string; lines: Array<[number, number]> }>(
      `/projects/${id}/agent-lines?file=${encodeURIComponent(file)}`,
    ),

  /** 宿主上报本轮 agent 产出的文件（可选带行范围，M10.1/M10.2）。 */
  markOrigin: (
    id: string,
    files: Array<string | { file: string; lines?: Array<[number, number]> }>,
    clear = false,
  ) =>
    request<{ ok: boolean; tracked: number }>(`/projects/${id}/origin`, {
      method: 'POST',
      body: JSON.stringify({ files, clear }),
    }),

  /** 依赖图（M4/M5）：默认按目录聚合，expand 里的目录展开到文件级。 */
  graph: (
    id: string,
    options: { level?: 'dir' | 'file'; expand?: string[]; external?: number; focus?: string[] } = {},
  ) =>
    request<DependencyGraph>(
      `/projects/${id}/graph${qs({
        level: options.level,
        // 根目录的节点 id 是 `./`，展开它要发 `.`（后端把空串视作根目录）
        expand: options.expand?.map((dir) => dir.replace(/\/+$/, '') || '.').join(','),
        external: options.external,
        // 「把入口 / 热点提到文件级」的覆盖：传空串 = 不提升（目录级视图更干净）
        focus: options.focus ? options.focus.join(',') || '-' : undefined,
      })}`,
    ),

  /** 反向依赖（M6）：谁直接引用了它、谁间接依赖它、哪些测试覆盖它。 */
  dependents: (id: string, file: string, depth = 2) =>
    request<DependentsResult>(
      `/projects/${id}/dependents?file=${encodeURIComponent(file)}&depth=${depth}`,
    ),

  /** 时间与来源（M9/M10）：只读 git 批次 + mtime 分组 + 来源判定。 */
  timeline: (id: string, windowMinutes = 30) =>
    request<ProjectTimeline>(`/projects/${id}/timeline?window=${windowMinutes}`),
};
