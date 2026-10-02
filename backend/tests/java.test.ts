/** Java：类名与静态方法经 import 跳转。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, gotoDefinition } from './helpers';

const FILES = {
  'src/com/demo/Util.java': `package com.demo;

public class Util {
    public static final int LIMIT = 10;

    public static int add(int a, int b) {
        return a + b;
    }

    public int value() {
        return LIMIT;
    }
}
`,
  'src/com/demo/Main.java': `package com.demo;

import com.demo.Util;

public class Main {
    private int count = 0;

    public static void main(String[] args) {
        Util u = new Util();
        int x = Util.add(1, 2);
        System.out.println(u.value());
        helper(x);
        System.out.println(Util.LIMIT + u.count);
    }

    static void helper(int v) {
        System.out.println(v);
    }
}
`,
};

test('java: 类名与静态方法经 import 跳转', async () => {
  const fx = await makeProject(FILES);
  try {
    const created = locate(fx.project, 'src/com/demo/Main.java', 'new Util()');
    const r = gotoDefinition(fx.project, 'src/com/demo/Main.java', created.line, created.col + 4);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'src/com/demo/Util.java');
    assert.equal(r.locations[0].range.start.line, 3); // public class Util

    const call = locate(fx.project, 'src/com/demo/Main.java', 'Util.add(1, 2)');
    const r2 = gotoDefinition(fx.project, 'src/com/demo/Main.java', call.line, call.col + 5);
    assert.equal(r2.reason, 'resolved');
    assert.equal(r2.locations[0].range.start.line, 6); // public static int add
  } finally {
    await fx.cleanup();
  }
});
