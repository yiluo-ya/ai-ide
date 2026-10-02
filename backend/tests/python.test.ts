/** Python：跨文件 from-import 跳转。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, locate, gotoDefinition } from './helpers';

const SERVICE = `"""service 模块"""
import os
from util import helper as hp, CONST


class UserService:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return hp(self.name)


def handle_user(user, limit=3):
    svc = UserService(user)
    for i in range(limit):
        os.path.join(svc.greet(), str(i))
    return svc
`;

const UTIL = `CONST = 42


def helper(value):
    return value
`;

test('python: 跨文件 from-import 跳转', async () => {
  const fx = await makeProject({ 'service.py': SERVICE, 'util.py': UTIL });
  try {
    const call = locate(fx.project, 'service.py', 'hp(self.name)');
    const result = gotoDefinition(fx.project, 'service.py', call.line, call.col);
    assert.equal(result.reason, 'resolved');
    assert.equal(result.locations[0].file, 'util.py');
    assert.equal(result.locations[0].range.start.line, 4); // def helper
  } finally {
    await fx.cleanup();
  }
});
