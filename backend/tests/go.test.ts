/** Go：go.mod module path 的跨包符号跳转（util.Helper / util.User）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, gotoDefinition } from './helpers';

const FILES = {
  'go.mod': 'module example.com/demo\n\ngo 1.21\n',
  'pkg/util/util.go': `package util

const Limit = 10

type User struct {
	Name string
	age  int
}

func Helper(v string) string {
	return v + "!"
}

func (u User) Greet() string {
	return Helper(u.Name)
}
`,
  'pkg/util/extra.go': `package util

func Extra() int {
	return Limit
}
`,
  'main.go': `package main

import (
	"fmt"

	"example.com/demo/pkg/util"
)

func main() {
	u := util.User{Name: "a"}
	fmt.Println(util.Helper(u.Name), u.Greet(), util.Limit)
}
`,
};

test('go: 跨包 util.Helper / util.User 跳转', async () => {
  const fx = await makeProject(FILES);
  try {
    const call = locate(fx.project, 'main.go', 'util.Helper');
    const r = gotoDefinition(fx.project, 'main.go', call.line, call.col + 'util.'.length);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'pkg/util/util.go');
    assert.equal(r.locations[0].range.start.line, 10); // func Helper

    const use = locate(fx.project, 'main.go', 'util.User{');
    const r2 = gotoDefinition(fx.project, 'main.go', use.line, use.col + 'util.'.length);
    assert.equal(r2.reason, 'resolved');
    assert.equal(r2.locations[0].range.start.line, 5); // type User struct
  } finally {
    await fx.cleanup();
  }
});
