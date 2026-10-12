/**
 * SQL 的跳转能力（2026-10-10）：默认支持 SQL 的高亮 + 跳定义 / 查引用。
 *
 * 口径：
 * - 定义：`CREATE ...` 声明的库对象（既有能力，行式扫描）；
 * - 引用：`lineRefs` 扫 FROM / JOIN / INTO / UPDATE / TABLE … 后面的对象名；
 * - 解析：同文件同名定义优先，再落到同项目的其它 `.sql`（库内全局可见）；
 * - 名字：未加引号的标识符折叠小写（`Users` = `users`），加引号的保留字面大小写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeProject,
  documentSymbols,
  gotoDefinition,
  findReferences,
  hover,
  locate,
} from './helpers';

const FILES: Record<string, string> = {
  'db/schema.sql': `-- 初始建表
CREATE TABLE users (
  id INT,
  name TEXT
);

CREATE TABLE orders (id INT, user_id INT);

CREATE UNIQUE INDEX idx_users_name ON users (name);

CREATE VIEW active_users AS SELECT id FROM users WHERE id > 0;

CREATE TABLE "Camel" (id INT);

-- Hive 方言：EXTERNAL + schema 限定名
CREATE EXTERNAL TABLE \`aipdc\`.\`events\` (id INT, ts TIMESTAMP);
`,
  'db/queries/report.sql': `-- 从 users 读（这行只是注释）
SELECT u.name
FROM Users u
JOIN orders o ON o.user_id = u.id
WHERE u.id IN (SELECT id FROM active_users);

SELECT * FROM (SELECT 1 AS n) t;

SELECT * FROM camel;

SELECT * FROM aipdc.events;
`,
};

test('SQL：CREATE 声明的对象名仍进大纲', async () => {
  const fx = await makeProject(FILES);
  try {
    assert.deepEqual(
      documentSymbols(fx.project, 'db/schema.sql').map((s) => `${s.kind} ${s.name}`),
      [
        'struct users',
        'struct orders',
        'property idx_users_name',
        'interface active_users',
        'struct Camel',
        'struct aipdc.events',
      ],
    );
  } finally {
    await fx.cleanup();
  }
});

test('SQL：关键字后面的对象名成为引用，定义自身与注释不算', async () => {
  const fx = await makeProject(FILES);
  try {
    const fi = fx.project.files.get('db/queries/report.sql');
    assert.ok(fi && fi.indexed);
    const names = fi.references.map((r) => r.name);
    assert.ok(names.includes('users'), 'FROM Users → users');
    assert.ok(names.includes('orders'), 'JOIN orders');
    assert.ok(names.includes('active_users'), 'FROM active_users');
    assert.ok(!names.includes('ghost'), '注释里的 FROM 不该产生引用');
    assert.ok(!names.includes('t'), 'FROM (subquery) 之后没有裸表名');
    assert.ok(names.includes('camel'), '未解析的 FROM camel 仍是引用（只是跳不到）');

    // INDEX 行的 `ON users` 也是引用；定义名自身不算引用
    const schema = fx.project.files.get('db/schema.sql');
    assert.ok(schema);
    assert.ok(schema.references.some((r) => r.name === 'users' && r.range.start.line === 9));
    assert.ok(!schema.references.some((r) => r.name === 'idx_users_name'));
  } finally {
    await fx.cleanup();
  }
});

test('SQL：同文件跳定义（引用 → CREATE 行）', async () => {
  const fx = await makeProject(FILES);
  try {
    const pos = locate(fx.project, 'db/schema.sql', 'FROM users');
    const out = gotoDefinition(fx.project, 'db/schema.sql', pos.line, pos.col + 5);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.locations[0].file, 'db/schema.sql');
    assert.equal(out.locations[0].range.start.line, 2);
  } finally {
    await fx.cleanup();
  }
});

test('SQL：跨文件跳定义（表定义在另一个 .sql）', async () => {
  const fx = await makeProject(FILES);
  try {
    const pos = locate(fx.project, 'db/queries/report.sql', 'FROM Users');
    const out = gotoDefinition(fx.project, 'db/queries/report.sql', pos.line, pos.col + 5);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.locations[0].file, 'db/schema.sql');
    assert.equal(out.locations[0].range.start.line, 2);

    const view = locate(fx.project, 'db/queries/report.sql', 'FROM active_users');
    const viewOut = gotoDefinition(fx.project, 'db/queries/report.sql', view.line, view.col + 5);
    assert.equal(viewOut.reason, 'resolved');
    assert.equal(viewOut.locations[0].file, 'db/schema.sql');
    assert.equal(viewOut.locations[0].range.start.line, 11);
  } finally {
    await fx.cleanup();
  }
});

test('SQL：查引用（F12 反向，含跨文件与定义行）', async () => {
  const fx = await makeProject(FILES);
  try {
    const decl = locate(fx.project, 'db/schema.sql', 'CREATE TABLE users');
    const out = findReferences(fx.project, 'db/schema.sql', decl.line, decl.col + 13, true);
    assert.equal(out.reason, 'resolved');
    const files = new Set(out.locations.map((l) => l.file));
    assert.deepEqual([...files].sort(), ['db/queries/report.sql', 'db/schema.sql']);
    const schemaLines = out.locations
      .filter((l) => l.file === 'db/schema.sql')
      .map((l) => l.range.start.line);
    assert.deepEqual(schemaLines, [2, 9, 11], '定义行 + INDEX 的 ON users + VIEW 的 FROM users');
  } finally {
    await fx.cleanup();
  }
});

test('SQL：悬停引用给出定义位置', async () => {
  const fx = await makeProject(FILES);
  try {
    const pos = locate(fx.project, 'db/queries/report.sql', 'JOIN orders');
    const out = hover(fx.project, 'db/queries/report.sql', pos.line, pos.col + 5);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.symbol, 'orders');
    assert.equal(out.definitions?.[0].location.file, 'db/schema.sql');
    assert.equal(out.definitions?.[0].location.range.start.line, 7);
  } finally {
    await fx.cleanup();
  }
});

test('SQL：Hive 方言 CREATE EXTERNAL TABLE + schema 限定名可跳转', async () => {
  const fx = await makeProject(FILES);
  try {
    // EXTERNAL TABLE 的定义进了索引
    const syms = documentSymbols(fx.project, 'db/schema.sql');
    assert.ok(syms.some((s) => s.name === 'aipdc.events'), 'EXTERNAL TABLE 进了大纲');

    // 跨文件：FROM aipdc.events → CREATE EXTERNAL TABLE `aipdc`.`events`
    const pos = locate(fx.project, 'db/queries/report.sql', 'FROM aipdc.events');
    const out = gotoDefinition(fx.project, 'db/queries/report.sql', pos.line, pos.col + 5);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.locations[0].file, 'db/schema.sql');
    assert.equal(out.symbol, 'aipdc.events');
  } finally {
    await fx.cleanup();
  }
});

test('SQL：加引号的名字按字面大小写（不折叠）', async () => {
  const fx = await makeProject(FILES);
  try {
    // `CREATE TABLE "Camel"` 保留 Camel；未加引号的 camel 不指向它
    const pos = locate(fx.project, 'db/queries/report.sql', 'FROM camel');
    const out = gotoDefinition(fx.project, 'db/queries/report.sql', pos.line, pos.col + 5);
    assert.equal(out.reason, 'unresolved');
    const quoted = locate(fx.project, 'db/schema.sql', 'CREATE TABLE "Camel"');
    const quotedOut = gotoDefinition(fx.project, 'db/schema.sql', quoted.line, quoted.col + 13);
    assert.equal(quotedOut.reason, 'resolved');
    assert.equal(quotedOut.symbol, 'Camel');
  } finally {
    await fx.cleanup();
  }
});

test('SQL：反引号列别名大小写不敏感（Hive 方言）', async () => {
  const fx = await makeProject({
    'db/cte.sql': `WITH t1 AS (
  SELECT
    aicloud_mid AS \`ageScore\`,
    aicloud_costmillisecond AS wake_cost
  FROM aipdc.events
)
SELECT t1.ageScore, t1.wake_cost FROM t1
`,
  });
  try {
    // 反引号定义的 ageScore 与无引号引用的 ageScore 应能匹配（均折叠小写）
    const pos = locate(fx.project, 'db/cte.sql', 't1.ageScore');
    const out = gotoDefinition(fx.project, 'db/cte.sql', pos.line, pos.col + 3);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.symbol, 'agescore');
    assert.equal(out.locations[0].file, 'db/cte.sql');
  } finally {
    await fx.cleanup();
  }
});

test('SQL：CTE 内无别名字段隐式取列名', async () => {
  const fx = await makeProject({
    'db/cte.sql': `WITH t1 AS (
  SELECT
    record.env,
    record.clientid,
    mid
  FROM aipdc.events
)
SELECT t1.env, t1.clientid FROM t1
`,
  });
  try {
    // record.env 无 AS，列名隐含为 env
    const pos = locate(fx.project, 'db/cte.sql', 't1.env');
    const out = gotoDefinition(fx.project, 'db/cte.sql', pos.line, pos.col + 3);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.symbol, 'env');
    // 裸列名 mid 无 AS，列名就是 mid
    const pos2 = locate(fx.project, 'db/cte.sql', 't1.clientid');
    const out2 = gotoDefinition(fx.project, 'db/cte.sql', pos2.line, pos2.col + 3);
    assert.equal(out2.reason, 'resolved');
    assert.equal(out2.symbol, 'clientid');
  } finally {
    await fx.cleanup();
  }
});

test('SQL：FROM 子查询别名可字段跳转', async () => {
  const fx = await makeProject({
    'db/sub.sql': `INSERT OVERWRITE TABLE aipdc.report
SELECT
    t.aicloud_mid,
    t.response,
    t.event_day
FROM (
    SELECT
        aicloud_mid,
        get_json_object(content, '$.response') AS response,
        event_day
    FROM aipdc.events
) t
`,
  });
  try {
    // t.response → 子查询内 AS response（有 alias 的列名能跳转）
    const pos = locate(fx.project, 'db/sub.sql', 't.response');
    const out = gotoDefinition(fx.project, 'db/sub.sql', pos.line, pos.col + 3);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.symbol, 'response');
    // t.event_day → 子查询内 event_day（无 alias 的裸列名，子查询进入 namespace scope 后也能跳转）
    const pos2 = locate(fx.project, 'db/sub.sql', 't.event_day');
    const out2 = gotoDefinition(fx.project, 'db/sub.sql', pos2.line, pos2.col + 3);
    assert.equal(out2.reason, 'resolved');
    assert.equal(out2.symbol, 'event_day');
  } finally {
    await fx.cleanup();
  }
});

test('SQL：INSERT OVERWRITE TABLE 表名引用正确解析', async () => {
  const fx = await makeProject({
    'db/insert.sql': `INSERT OVERWRITE TABLE aipdc.report PARTITION (event_day)
SELECT aicloud_mid, event_day FROM aipdc.events
`,
    'db/ddl.sql': `CREATE TABLE aipdc.report (aicloud_mid STRING, event_day INT)
`,
  });
  try {
    // INSERT OVERWRITE TABLE aipdc.report → 跳转到 CREATE TABLE
    const pos = locate(fx.project, 'db/insert.sql', 'aipdc.report');
    const out = gotoDefinition(fx.project, 'db/insert.sql', pos.line, pos.col + 6);
    assert.equal(out.reason, 'resolved');
    assert.equal(out.symbol, 'aipdc.report');
  } finally {
    await fx.cleanup();
  }
});
