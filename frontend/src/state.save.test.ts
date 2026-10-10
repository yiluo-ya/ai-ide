/**
 * FR-0008 自动保存的回归测试（2026-10-10 用户实测反馈「保存后回退功能消失」的护栏）。
 *
 * 被钉住的三条约定（都是实测出来的，别回退）：
 *   1) **保存串行化**：同一文件永不并发两个 PUT —— 否则第二个带的是上一次保存之前的
 *      mtime，到后端会被判成「外部改动」而 409（用户看到莫名其妙的冲突弹窗）；
 *      并且冲突判定不能用过期回执去回写 savedText / fileContent；
 *   2) **保存不回灌编辑器**：保存成功后 contentToken 不变 —— 一旦变了，编辑器会拿
 *      store 的正文 setValue() 覆盖，把保存期间敲进去的字打回（并清空 undo 栈）；
 *   3) 保存失败（409）要落到 conflict 状态，让用户裁决。
 *
 * 这里直接驱动 store（不起后端、不碰 Monaco），因此比 tmp 脚本更适合进 CI。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** api 的可控替身：`saveFile` 返回挂起的 promise，由测试决定何时、以何种结果回来。 */
const mock = vi.hoisted(() => {
  const calls: Array<{ path: string; text: string; base?: number }> = [];
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  return { calls, pending };
});

vi.mock('./api', () => {
  // 与 `api.ts:97-107` 的签名保持一致：(message, status, body)
  class ApiRequestError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiRequestError,
    subscribeEvents: () => () => undefined,
    api: {
      saveFile: (...[id, path, text, base]: [string, string, string, number?]) => {
        void id;
        mock.calls.push({ path, text, base });
        return new Promise((resolve, reject) => mock.pending.push({ resolve, reject }));
      },
      fileText: async () => ({ text: 'DISK', lang: 'plaintext', size: 4, mtimeMs: 999 }),
    },
  };
});

const { ApiRequestError } = await import('./api');
const { useStore } = await import('./state');

/** 摆好「已打开一个文件」的状态（跳过 selectProject 的那一堆 IO）。 */
function prime(content = 'A', mtimeMs = 100, contentToken = 3) {
  useStore.setState({
    projectId: 'p1',
    openFile: 'a.ts',
    fileContent: content,
    savedText: content,
    fileMtimeMs: mtimeMs,
    contentToken,
    saveStatus: 'idle',
    saveError: null,
    conflict: null,
  });
}

/** 让挂起的第 i 个保存成功返回。 */
async function settle(i: number, mtimeMs: number, size = 1) {
  mock.pending[i].resolve({ ok: true, size, mtimeMs });
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mock.calls.length = 0;
  mock.pending.length = 0;
  vi.useRealTimers();
});

describe('自动保存：串行化与状态回写', () => {
  it('保存进行中不再发第二个请求；完成后才按新 mtime 补发', async () => {
    vi.useFakeTimers();
    prime('A', 100);
    const s = () => useStore.getState();

    s().editorChanged('B');
    const first = s().flushSave(); // 不 await：让它在飞
    expect(mock.calls).toEqual([{ path: 'a.ts', text: 'B', base: 100 }]);

    // 保存进行中用户又敲了字，并且（防抖到点）再次 flush
    s().editorChanged('BC');
    await s().flushSave();
    expect(mock.calls).toHaveLength(1); // ★ 串行：没有并发第二个 PUT

    await settle(0, 200);
    await first;
    expect(s().savedText).toBe('B');
    expect(s().fileContent).toBe('B');
    expect(s().saveStatus).toBe('pending'); // 还有 'BC' 没落盘

    // 第一次回执里的新 mtime 必须成为下一次保存的基准（否则会被判成外部改动）
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]).toEqual({ path: 'a.ts', text: 'BC', base: 200 });

    await settle(1, 300);
    expect(s().savedText).toBe('BC');
    expect(s().saveStatus).toBe('saved');
    vi.useRealTimers();
  });

  it('保存不回灌编辑器：contentToken 不变（变了就会覆盖正在输入的内容）', async () => {
    prime('A', 100, 7);
    const s = () => useStore.getState();

    s().editorChanged('B');
    const p = s().flushSave();
    await settle(0, 200);
    await p;

    expect(s().contentToken).toBe(7); // ★ 编辑期 model 是唯一真相
    expect(s().fileMtimeMs).toBe(200);
  });

  it('「用磁盘上的」要显式重灌一次（contentToken +1）', async () => {
    prime('A', 100, 7);
    const s = () => useStore.getState();
    useStore.setState({ conflict: { file: 'a.ts', diskMtimeMs: 500 } });

    await s().resolveConflict('disk');

    expect(s().contentToken).toBe(8);
    expect(s().fileContent).toBe('DISK');
    expect(s().savedText).toBe('DISK');
    expect(s().conflict).toBeNull();
  });

  it('没有待保存内容时 flushSave 是一次空操作', async () => {
    prime('A', 100);
    await useStore.getState().flushSave();
    expect(mock.calls).toHaveLength(0);
  });

  it('409：落到 conflict 状态（带磁盘 mtime），选「保留我的」时不再带基准覆盖', async () => {
    prime('A', 100);
    const s = () => useStore.getState();

    s().editorChanged('B');
    const p = s().flushSave();
    mock.pending[0].reject(new ApiRequestError('磁盘上的文件已被其它改动覆盖', 409, { mtimeMs: 777, size: 3 }));
    await p;

    expect(s().conflict).toEqual({ file: 'a.ts', diskMtimeMs: 777 });
    expect(s().saveStatus).toBe('error');
    expect(s().savedText).toBe('A'); // 冲突不改基准

    const keepMine = s().resolveConflict('mine');
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]).toEqual({ path: 'a.ts', text: 'B', base: undefined }); // ★ 不带 baseMtimeMs
    await settle(1, 800);
    await keepMine;
    expect(s().savedText).toBe('B');
    expect(s().conflict).toBeNull();
  });

  it('编辑内容回到已保存状态时，清掉待保存标记并不再发请求', async () => {
    prime('A', 100);
    const s = () => useStore.getState();

    s().editorChanged('B');
    expect(s().saveStatus).toBe('pending');
    s().editorChanged('A'); // 又改回去

    expect(s().saveStatus).toBe('idle');
    await s().flushSave();
    expect(mock.calls).toHaveLength(0);
  });
});
