# 阅读笔记（04 Guide · W2 行级笔记 / G4.1–G4.4）—— 为什么移除、怎么恢复

**移除时间**：2026-10-03，与「书签」「批注」一并从代码中摘除（用户决定：这三样在自己的使用场景里
都没有立得住的位置 —— 讨论去 PR/MR，跳转由位置记忆 + 大纲 + 搜索覆盖）。

**这不是一个完整功能的墓碑**：笔记是 04 向导主题的一部分，而向导面板的入口早在同一天早些时候
就被移除了（组件按当时的决定保留）。笔记的宿主没了、只剩编辑器行槽上的一层标记，因此一并摘除。

## 恢复

```bash
git apply docs/patches/reading-notes.patch     # 重建被删的 4 个文件 + 把接线点加回来
```

补丁内容 = ① 4 个被删文件（`notes.ts` / `notesState.ts` / `NoteLayer.tsx` / `notes.test.ts`）的完整内容；
② 9 个接线点文件的反向 diff（apply 即还原）。

例外：**`frontend/src/App.tsx` 不在补丁里**（该文件当时有其它未提交改动，直接把它的 diff 打进补丁会
混入无关内容）。手工加回下面 3 处即可：

1. 顶部 import：`import { useNotesStore } from './notesState';`
2. 项目切换的 reset 块里，`useGuideStore.getState().reset();` 之后加 `useNotesStore.getState().reset();`
3. 项目切换的 load 块里，`void useGuideStore.getState().load(id);` 之后加 `useNotesStore.getState().load(id);`

恢复后还要跑一遍 `npm run typecheck && npm run test:unit` —— 补丁基于当时的代码，若周边已改动
（比如 `Editor.tsx` 又加了别的装饰池），需要手工对齐。

## 当时摘掉的东西（接线点清单）

| 文件 | 摘掉的内容 |
|---|---|
| `frontend/src/notes.ts` `notesState.ts` `NoteLayer.tsx` `notes.test.ts` | 整文件删除 |
| `frontend/src/Editor.tsx` | 笔记 import、`notePool`、行槽点击开浮层、`noteLine/noteAnchorPos` 状态、`mineNotes` + 行槽装饰 effect、`FileNoteBar` / `NotePopover`、`closeNote` |
| `frontend/src/App.tsx` | 3 处（见上；未进补丁） |
| `frontend/src/ExplainPanel.tsx` | 「保存为笔记」按钮与 `saveAsNote` |
| `frontend/src/explainState.ts` | `explainNoteBody()`（只为存笔记服务） |
| `frontend/src/GuidePanel.tsx` | `NotesSection`（笔记汇总：分组 / 筛选 / 导出 / 导入） |
| `frontend/src/readSnapshot.ts` | `ReadSnapshot.noteLocs`、`buildSnapshot` 的 `notes` 参数 |
| `frontend/src/changes.test.ts` | 笔记相关的快照断言 |
| `frontend/src/i18n/{zh,en}.ts` | `guide.notes.*` 26 键、`explain.save/saved/saveFailed` 3 键 |
| `frontend/src/guide.css` | 行级笔记 / 文件级笔记 / 面板笔记段样式（原 437–685 行） |

## 与「批注」「书签」的关系

三者是独立的三套：书签（`state.ts`，纯位置路标）、批注（`annotations.*`，行级讨论线程）、
笔记（`notes.*`，带内容锚点的行级/文件级备注）。摘除时三者都删干净，没有共用存储键。
