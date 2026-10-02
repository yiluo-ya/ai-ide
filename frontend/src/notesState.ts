/**
 * 向导（04 Guide · W2）的笔记状态：全部笔记 / 待归位 / 当前文件已定位的笔记。
 *
 * 为什么不并入 `state.ts`：与 `guideState.ts` 同理由 —— 那个文件正被其它主题持续改写，
 * 笔记状态自成一体，放这里既不互相踩，也不必往共享文件里堆东西。
 *
 * 与 `guideState` 的一点差别：笔记的「锚定」要靠当前文件的正文才能算，
 * 所以 Editor 打开文件时会调 `syncFile(file, text)` 把正文同步进来；换项目时 App 调
 * `reset()`。存储与纯函数都在 `notes.ts`，这里只做状态与派生。
 */
import { create } from 'zustand';
import {
  addNote as addNoteTo,
  exportMarkdown as notesMarkdown,
  importJson as importNotesJson,
  readNotes,
  removeNote as removeNoteFrom,
  resolveNotes,
  subscribeNotes,
  updateNote as updateNoteIn,
  type NewNote,
  type Note,
  type ResolvedNote,
} from './notes';

interface NotesState {
  projectId: string | null;
  /** 当前项目的全部笔记（顺序固定：文件 → 文件级在前 → 行号升序）。 */
  notes: Note[];
  /** 当前文件里 anchor 失配的行级笔记（「待归位」）。 */
  orphans: Note[];
  /**
   * 当前文件里能定位的行级笔记（`resolvedLine` 是恢复出来的行号）。
   * 面板的「待归位」只看 `orphans`；这份派生结果是给「按当前文件取已定位笔记」的调用点用的
   * （编辑器内部按自己的窗口算，分屏时不会互相影响）。
   */
  currentFileNotes: ResolvedNote[];

  /** 切项目 / 首屏加载：读本机存储并开始订阅变化。 */
  load: (projectId: string) => void;
  reset: () => void;
  /** Editor 打开 / 重载文件时同步正文（anchor 恢复的唯一依据）。 */
  syncFile: (file: string | null, fileText: string) => void;
  /** 新增一条；正文为空时不做（返回 null）。文件级笔记一个文件只留一条。 */
  add: (input: Omit<NewNote, 'level'> & { level?: 'line' | 'file' }) => Note | null;
  /** 改正文；正文为空 = 删除这一条（与浮层「空内容保存 = 删除」一致）。 */
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  /** 导入 JSON（合并去重），返回新增条数；JSON 坏掉时抛错。 */
  importJson: (json: string) => number;
  /** 导出 Markdown 文本。 */
  exportMarkdown: (projectName: string) => string;
}

/** 当前文件的正文（不进 state：它是几万字符的字符串，放外面避免无谓的重渲染）。 */
let currentFile: string | null = null;
let currentText = '';

/** 从「全部笔记 + 当前文件正文」派生待归位与已定位两份清单（三层兜底的入口）。 */
function derive(
  notes: Note[],
  file: string | null,
  text: string,
): Pick<NotesState, 'orphans' | 'currentFileNotes'> {
  if (!file) return { orphans: [], currentFileNotes: [] };
  const { located, orphans } = resolveNotes(
    notes.filter((n) => n.file === file),
    text,
  );
  return { orphans, currentFileNotes: located };
}

export const useNotesStore = create<NotesState>((set, get) => ({
  projectId: null,
  notes: [],
  orphans: [],
  currentFileNotes: [],

  load(projectId) {
    if (get().projectId !== projectId) {
      currentFile = null;
      currentText = '';
      set({ projectId, notes: readNotes(projectId), orphans: [], currentFileNotes: [] });
    } else {
      set({ notes: readNotes(projectId) });
    }
    subscribe();
  },

  reset() {
    currentFile = null;
    currentText = '';
    set({ projectId: null, notes: [], orphans: [], currentFileNotes: [] });
  },

  syncFile(file, fileText) {
    const same = file === currentFile && fileText === currentText;
    currentFile = file;
    currentText = fileText;
    if (same) return; // 正文没变就不重算（避免每次渲染都 set 一轮）
    set(derive(get().notes, file, fileText));
  },

  add(input) {
    const projectId = get().projectId;
    if (!projectId) return null;
    const level = input.level ?? 'line';
    const body = input.body.trim();
    if (!body) return null;

    // 文件级笔记一个文件只留一条（「一个文件的整体印象」只有一句）：已有就改
    if (level === 'file') {
      const existing = get().notes.find((n) => n.file === input.file && n.level === 'file');
      if (existing) {
        updateNoteIn(projectId, existing.id, body);
        return existing;
      }
    }
    return addNoteTo(projectId, { ...input, body, level });
  },

  update(id, body) {
    const projectId = get().projectId;
    if (!projectId) return;
    // 空内容保存 = 删除（用户把话删干净了，就是不想留着这条）
    if (!body.trim()) {
      removeNoteFrom(projectId, id);
      return;
    }
    updateNoteIn(projectId, id, body.trim());
  },

  remove(id) {
    const projectId = get().projectId;
    if (!projectId) return;
    removeNoteFrom(projectId, id);
  },

  importJson(json) {
    const projectId = get().projectId;
    if (!projectId) return 0;
    return importNotesJson(projectId, json);
  },

  exportMarkdown(projectName) {
    return notesMarkdown(get().notes, projectName);
  },
}));

/**
 * 订阅存储变化一次（本页内其它代码也可能写笔记）；
 * 回调里按「当前项目」过滤，并顺带重算待归位 / 已定位。
 */
let subscribed = false;
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  subscribeNotes((projectId) => {
    const state = useNotesStore.getState();
    if (state.projectId !== projectId) return;
    const notes = readNotes(projectId);
    useNotesStore.setState({ notes, ...derive(notes, currentFile, currentText) });
  });
}
