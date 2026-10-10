import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceWithRetry } from '../src/atomic.js';

test('瞬时共享冲突会重试，之后成功', async () => {
  let calls = 0;
  const slept = [];
  await replaceWithRetry('a', 'b', {
    rename: async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
    sleep: async ms => slept.push(ms),
  });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [50, 100]);
});

test('永久性错误不重试，持续冲突最终放弃', async () => {
  let calls = 0;
  await assert.rejects(replaceWithRetry('a', 'b', {
    rename: async () => { calls += 1; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
    sleep: async () => {},
  }), /nope/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(replaceWithRetry('a', 'b', {
    rename: async () => { calls += 1; throw Object.assign(new Error('always busy'), { code: 'EPERM' }); },
    sleep: async () => {},
    delays: [1, 2],
  }), /always busy/);
  assert.equal(calls, 3);
});
