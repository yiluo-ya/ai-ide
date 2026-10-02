/** TypeScript：import 具名符号后调用跳转。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, gotoDefinition } from './helpers';

const FILES = {
  'src/util.ts': `export const CONST = 42;

export function helper(value: string): string {
  return value + CONST;
}

export interface Options {
  verbose: boolean;
}
`,
  'src/main.ts': `import { helper, CONST, type Options } from './util';
import * as u from './util';

export class Service {
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  run(opts: Options): string {
    return helper(this.label) + String(u.CONST) + String(CONST);
  }
}

const svc = new Service('x');
export const out = svc.run({ verbose: true });
`,
};

test('ts: import 具名符号后调用跳转', async () => {
  const fx = await makeProject(FILES);
  try {
    const call = locate(fx.project, 'src/main.ts', 'helper(this.label)');
    const r = gotoDefinition(fx.project, 'src/main.ts', call.line, call.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'src/util.ts');
    assert.equal(r.locations[0].range.start.line, 3); // export function helper
  } finally {
    await fx.cleanup();
  }
});
