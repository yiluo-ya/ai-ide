/**
 * Rust 语言模块：定义 / 引用 / 大纲 / 继承 / crate 路径解析。
 * 断言一律以现场 AST 的真实行为为准（见 rust.ts 的覆盖口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, gotoDefinition, documentSymbols, workspaceSymbols, findReferences } from './helpers';
import { rust } from '../src/languages/rust';
import { moduleFiles } from '../src/indexer/resolver';
import type { ImportRecord } from '../src/indexer/model';

const FILES = {
  'src/util.rs': `pub fn helper() -> i32 {
    1
}

pub struct User {
    pub name: String,
}
`,
  'src/main.rs': `//! crate 级文档
use crate::util::{helper, User};

#[derive(Debug, Clone)]
pub struct Point {
    pub x: i32,
    y: i32,
}

pub enum Shape {
    Circle(f64),
    Rect { w: f64 },
}

pub trait Draw {
    fn draw(&self) -> String;
}

/// 点的绘制实现
impl Draw for Point {
    fn draw(&self) -> String {
        format!("{}", self.x)
    }
}

impl Point {
    fn new(x: i32) -> Self {
        Point { x, y: 0 }
    }
}

pub const LIMIT: usize = 10;
pub type Alias = String;

macro_rules! twice {
    ($x:expr) => { $x * 2 };
}

mod inner {
    pub fn helper2() -> i32 { 1 }
}

pub fn main() {
    let _ = helper();
    let u = User { name: String::new() };
    let _ = u.name;
    let pt = Point::new(1);
    let _ = pt.x;
    let _ = twice!(2);
    let _ = inner::helper2();
    println!("{} {} {}", LIMIT, Shape::Circle(1.0), 0);
}
`,
};

test('rust: 定义 — fn / struct / enum / trait / mod / const / type / macro_rules! 都被识别', async () => {
  const fx = await makeProject(FILES);
  try {
    const names = documentSymbols(fx.project, 'src/main.rs').map((s) => s.name);
    for (const expected of ['Point', 'Shape', 'Draw', 'LIMIT', 'Alias', 'twice', 'inner', 'main']) {
      assert.ok(names.includes(expected), `定义缺少 ${expected}（实际：${names.join(', ')}）`);
    }
    const macro = workspaceSymbols(fx.project, 'twice', null);
    assert.equal(macro[0]?.location.file, 'src/main.rs');
  } finally {
    await fx.cleanup();
  }
});

test('rust: 定义 — impl 内的方法/字段带 containerName，kind 为 method / field', async () => {
  const fx = await makeProject(FILES);
  try {
    const symbols = documentSymbols(fx.project, 'src/main.rs');
    const defs = fx.project.files.get('src/main.rs')!.definitions;
    const drawOf = (container: string) => defs.find((d) => d.name === 'draw' && d.containerName === container);
    assert.equal(drawOf('Draw')?.kind, 'method');
    assert.equal(drawOf('Point')?.kind, 'method');
    const newFn = defs.find((d) => d.name === 'new');
    assert.equal(newFn?.kind, 'method');
    assert.equal(newFn?.containerName, 'Point');
    const field = defs.find((d) => d.name === 'x' && d.kind === 'field');
    assert.equal(field?.containerName, 'Point');
    // 顶层函数不应被当作方法
    assert.equal(defs.find((d) => d.name === 'main')?.kind, 'function');
    assert.ok(symbols.length > 0);
  } finally {
    await fx.cleanup();
  }
});

test('rust: 引用 — use crate::util::helper 跨文件跳转', async () => {
  const fx = await makeProject(FILES);
  try {
    const call = locate(fx.project, 'src/main.rs', 'helper()');
    const r = gotoDefinition(fx.project, 'src/main.rs', call.line, call.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'src/util.rs');
    assert.equal(r.locations[0].range.start.line, 1);
  } finally {
    await fx.cleanup();
  }
});

test('rust: 引用 — 类型引用与 find-references 指向同一定义', async () => {
  const fx = await makeProject(FILES);
  try {
    const use = locate(fx.project, 'src/main.rs', 'User {');
    const r = gotoDefinition(fx.project, 'src/main.rs', use.line, use.col);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.locations[0].file, 'src/util.rs');

    const helperDef = locate(fx.project, 'src/util.rs', 'helper');
    const refs = findReferences(fx.project, 'src/util.rs', helperDef.line, helperDef.col, false);
    assert.ok(
      refs.locations.some((e) => e.file === 'src/main.rs'),
      `find-references 应包含 main.rs 的引用（实际：${JSON.stringify(refs)}）`,
    );
  } finally {
    await fx.cleanup();
  }
});

test('rust: 大纲 — impl 内方法归到类型名下', async () => {
  const fx = await makeProject(FILES);
  try {
    const symbols = documentSymbols(fx.project, 'src/main.rs');
    const point = symbols.find((s) => s.name === 'Point');
    assert.ok(point, '大纲应有 Point');
    const container = fx.project.files
      .get('src/main.rs')!
      .definitions.filter((d) => d.containerName === 'Point')
      .map((d) => d.name);
    assert.ok(container.includes('draw'), `Point 下应有 draw（实际：${container.join(', ')}）`);
    assert.ok(container.includes('new'), `Point 下应有 new（实际：${container.join(', ')}）`);
  } finally {
    await fx.cleanup();
  }
});

test('rust: 继承 — impl Trait for Type 记为 implements 基名', async () => {
  const fx = await makeProject(FILES);
  try {
    const point = fx.project.defsByName.get('Point')?.[0];
    assert.ok(point, 'Point 应有定义');
    const bases = point.bases ?? [];
    assert.ok(
      bases.some((b) => b.name === 'Draw' && b.kind === 'implements'),
      `Point 的 bases 应含 Draw（实际：${JSON.stringify(bases)}）`,
    );
  } finally {
    await fx.cleanup();
  }
});

test('rust: 继承 — #[derive(...)] 记为 derive.X 形式的 implements 基名', async () => {
  const fx = await makeProject(FILES);
  try {
    const bases = fx.project.defsByName.get('Point')?.[0]?.bases ?? [];
    for (const name of ['derive.Debug', 'derive.Clone']) {
      assert.ok(
        bases.some((b) => b.name === name && b.kind === 'implements'),
        `bases 应含 ${name}（实际：${JSON.stringify(bases)}）`,
      );
    }
  } finally {
    await fx.cleanup();
  }
});

test('rust: 模块解析 — crate:: / super:: / self:: 各自的候选路径', () => {
  assert.deepEqual(rust.resolveModule?.('crate::util', 'src/main.rs', null as never), [
    { path: 'src/util.rs', kind: 'file' },
    { path: 'src/util/mod.rs', kind: 'file' },
  ]);
  assert.deepEqual(rust.resolveModule?.('super::sibling', 'src/a/b.rs', null as never), [
    { path: 'src/a/sibling.rs', kind: 'file' },
    { path: 'src/a/sibling/mod.rs', kind: 'file' },
  ]);
  // `self::sub`：sub 是文件模块 b 的子模块（b.rs 的子模块放 src/a/b/ 下），末位 candidate 是「sub 是当前模块内的项」的兜底
  assert.deepEqual(rust.resolveModule?.('self::sub', 'src/a/b.rs', null as never), [
    { path: 'src/a/b/sub.rs', kind: 'file' },
    { path: 'src/a/b/sub/mod.rs', kind: 'file' },
    { path: 'src/a/b.rs', kind: 'file' },
  ]);
  assert.deepEqual(rust.resolveModule?.('crate::a::b::c', 'src/main.rs', null as never), [
    { path: 'src/a/b/c.rs', kind: 'file' },
    { path: 'src/a/b/c/mod.rs', kind: 'file' },
  ]);
});

test('rust: 模块解析 — std:: 与第三方 crate 返回 null（落 external）', () => {
  assert.equal(rust.resolveModule?.('std::collections::HashMap', 'src/main.rs', null as never), null);
  assert.equal(rust.resolveModule?.('serde::Serialize', 'src/main.rs', null as never), null);
  assert.equal(rust.resolveModule?.('rand', 'src/main.rs', null as never), null);
});

test('rust: 模块解析 — 只有确实存在的候选文件才会被采用', async () => {
  const fx = await makeProject(FILES);
  try {
    const hint = fx.project.hint();
    const fi = fx.project.files.get('src/main.rs')!;
    const imp: ImportRecord = fi.imports.find((i) => i.localName === 'helper')!;
    assert.equal(imp.module, 'crate::util');
    assert.deepEqual(moduleFiles(fx.project, fi, imp), ['src/util.rs']);

    const ghost: ImportRecord = { ...imp, module: 'crate::nope' };
    assert.deepEqual(moduleFiles(fx.project, fi, ghost), []);
    assert.ok(hint.exists('src/util.rs'));
  } finally {
    await fx.cleanup();
  }
});
