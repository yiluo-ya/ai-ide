/**
 * 成员跳转「层 A」：源码里明写类型（注解 / `new X()`）时，`变量.成员` 在项目内应能跳定义。
 * 只读 AST 类型事实，不做类型推断；解析不出仍如实返回 unresolved。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gotoDefinition, locate, makeProject } from './helpers';

test('member-jump: TS 局部变量 new X() → 方法定义', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/a.ts': [
      'class Client {',
      '  doWork(): number { return 1; }',
      '}',
      'export function use() {',
      '  const c = new Client();',
      '  return c.doWork();',
      '}',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'src/a.ts', 'c.doWork');
  const out = gotoDefinition(project, 'src/a.ts', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].file, 'src/a.ts');
  assert.equal(out.locations[0].range.start.line, 2);
});

test('member-jump: TS 参数类型注解 → 方法定义', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/a.ts': [
      'class Client {',
      '  doWork(): number { return 1; }',
      '}',
      'export function use(c: Client) {',
      '  return c.doWork();',
      '}',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'src/a.ts', 'c.doWork');
  const out = gotoDefinition(project, 'src/a.ts', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].range.start.line, 2);
});

test('member-jump: TS 跨文件（import 的类 / 方法）', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/client.ts': 'export class Client {\n  doWork(): number { return 1; }\n}\n',
    'src/use.ts': [
      "import { Client } from './client';",
      'export function use(c: Client) {',
      '  return c.doWork();',
      '}',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'src/use.ts', 'c.doWork');
  const out = gotoDefinition(project, 'src/use.ts', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].file, 'src/client.ts');
  assert.equal(out.locations[0].range.start.line, 2);
});

test('member-jump: Java 字段 new X() → 方法定义', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/Use.java': [
      'class Client {',
      '  int doWork() { return 1; }',
      '}',
      'class Use {',
      '  Client c = new Client();',
      '  int use() { return c.doWork(); }',
      '}',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'src/Use.java', 'c.doWork');
  const out = gotoDefinition(project, 'src/Use.java', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].range.start.line, 2);
});

test('member-jump: Go 形参 *Client → 字段定义', async (t) => {
  const { project, cleanup } = await makeProject({
    'main.go': [
      'package main',
      '',
      'type Client struct {',
      '\tName string',
      '}',
      '',
      'func use(c *Client) string {',
      '\treturn c.Name',
      '}',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'main.go', 'c.Name');
  const out = gotoDefinition(project, 'main.go', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].range.start.line, 4);
});

test('member-jump: Python 形参注解 → 方法定义', async (t) => {
  const { project, cleanup } = await makeProject({
    'a.py': [
      'class Client:',
      '    def do_work(self):',
      '        return 1',
      '',
      'def use(c: Client):',
      '    return c.do_work()',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'a.py', 'c.do_work');
  const out = gotoDefinition(project, 'a.py', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].range.start.line, 2);
});

test('member-jump: Python self.x = Client() → 二跳方法定义', async (t) => {
  const { project, cleanup } = await makeProject({
    'a.py': [
      'class Client:',
      '    def do_work(self):',
      '        return 1',
      '',
      'class Holder:',
      '    def __init__(self):',
      '        self.client = Client()',
      '',
      '    def run(self):',
      '        return self.client.do_work()',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'a.py', 'self.client.do_work');
  const out = gotoDefinition(project, 'a.py', pos.line, pos.col + 'self.client.'.length);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].range.start.line, 2);
});

test('member-jump: Rust 形参注解 & impl 方法', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/lib.rs': [
      'struct Client;',
      '',
      'impl Client {',
      '    fn do_work(&self) -> i32 { 1 }',
      '}',
      '',
      'fn use_it(c: &Client) -> i32 {',
      '    c.do_work()',
      '}',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'src/lib.rs', 'c.do_work');
  const out = gotoDefinition(project, 'src/lib.rs', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].range.start.line, 4);
});

test('member-jump: 无注解、无初始化的接收者仍如实返回 unresolved', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/a.ts': 'export function use(c) {\n  return c.doWork();\n}\n',
  });
  t.after(cleanup);

  const pos = locate(project, 'src/a.ts', 'c.doWork');
  const out = gotoDefinition(project, 'src/a.ts', pos.line, pos.col + 2);
  assert.equal(out.reason, 'unresolved');
  assert.equal(out.detail, 'needs-type-info');
});

// ---------------------------------------------------------------- 层 B：从构造点回填形参类型

/**
 * 层 B（Python）：`core: Any` 读不出类型，从构造点 `SessionPool(self)` 得知它是 XchenCore，
 * 而 `self.core = core` 又把属性 core 的类型链到那个形参 —— 两跳都要通。
 */
test('member-jump(层B): Python 构造点 → 属性 → 形参 的类型链', async (t) => {
  const { project, cleanup } = await makeProject({
    'a.py': [
      'from typing import Any',
      '',
      'class ConfManager:',
      '    def get_core_config(self):',
      '        return 1',
      '',
      'class XchenCore:',
      '    def __init__(self):',
      '        self.conf_manager = ConfManager()',
      '        self.pool = SessionPool(self)',
      '',
      'class SessionPool:',
      '    def __init__(self, core: Any):',
      '        self.core = core',
      '',
      '    def use(self):',
      '        return self.core.conf_manager',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'a.py', 'conf_manager');
  const out = gotoDefinition(project, 'a.py', pos.line, pos.col + 2);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].range.start.line, 9); // self.conf_manager = ConfManager()
});

/** 层 B（TS）：`new Client(this)` —— 实参是 this，回填成调用点所在类。 */
test('member-jump(层B): TS new Client(this) → 参数成员（跨文件）', async (t) => {
  const { project, cleanup } = await makeProject({
    'src/client.ts': [
      'export class Client {',
      '  doWork(): number { return 1; }',
      '}',
      'export class Runner {',
      '  client: Client;',
      '  use(): number { return this.client.doWork(); }',
      '}',
    ].join('\n'),
    'src/main.ts': [
      "import { Client, Runner } from './client';",
      'export class App {',
      '  constructor(private runner: Runner) {}',
      '}',
      'export function boot() {',
      '  return new Runner();',
      '}',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'src/main.ts', 'new Runner');
  const out = gotoDefinition(project, 'src/main.ts', pos.line, pos.col + 5);
  assert.equal(out.reason, 'resolved');
  assert.equal(out.locations[0].file, 'src/client.ts');
});

/**
 * 层 B（Python）负例：两个构造点给出不同类 → 一致不了，宁可返回 unresolved。
 */
test('member-jump(层B): 构造点不一致时不猜', async (t) => {
  const { project, cleanup } = await makeProject({
    'a.py': [
      'from typing import Any',
      '',
      'class Pool:',
      '    def __init__(self, core: Any):',
      '        self.core = core',
      '',
      '    def use(self):',
      '        return self.core.conf_manager',
      '',
      'class A:',
      '    pass',
      '',
      'class B:',
      '    pass',
      '',
      'p1 = Pool(A())',
      'p2 = Pool(B())',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'a.py', 'conf_manager');
  const out = gotoDefinition(project, 'a.py', pos.line, pos.col + 2);
  assert.equal(out.reason, 'unresolved');
});

/**
 * 层 B 负例：非构造器的形参不套用实参回填（`Pool(a)` 与 `use(self, x)` 是两回事）。
 */
test('member-jump(层B): 普通方法的形参不套用构造点', async (t) => {
  const { project, cleanup } = await makeProject({
    'a.py': [
      'class A:',
      '    def ping(self):',
      '        return 1',
      '',
      'class Pool:',
      '    def run(self, other):',
      '        return other.ping',
      '',
      'p = Pool(A())',
    ].join('\n'),
  });
  t.after(cleanup);

  const pos = locate(project, 'a.py', 'other.ping');
  const out = gotoDefinition(project, 'a.py', pos.line, pos.col + 6);
  assert.equal(out.reason, 'unresolved');
});
