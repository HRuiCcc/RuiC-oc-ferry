import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelResult, withRequestMeta, clientModelID, usableModelIds } from '../src/model-status.js';

const model = id => ({ id, name: id.replace('opencode/', '') });

test('失败归类：额度、限流、权限、超时、其它各自分开', () => {
  assert.equal(modelResult(true).category, 'available');
  assert.equal(modelResult(false, 'insufficient_quota: 额度不足').category, 'quota');
  assert.equal(modelResult(false, '额度已用尽').category, 'quota');
  assert.equal(modelResult(false, 'rate limit exceeded').category, 'rate_limit');
  assert.equal(modelResult(false, 'slow down', 429).category, 'rate_limit');
  assert.equal(modelResult(false, 'forbidden', 403).category, 'access');
  assert.equal(modelResult(false, 'Model probe timed out').category, 'timeout');
  assert.equal(modelResult(false, 'has been deprecated').category, 'error');
  const result = modelResult(false, 'boom', 502, 'upstream_error');
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.code, 'upstream_error');
  assert.ok(result.time);
});

test('请求观察值只抄有值的字段，不无中生有', () => {
  const result = withRequestMeta({ ok: true }, { calls: 2, nativeAttempts: 1, handoff: 'Read', repaired: { envelope: { ok: true } } });
  assert.equal(result.calls, 2);
  assert.equal(result.nativeAttempts, 1);
  assert.equal(result.handoff, 'Read');
  assert.deepEqual(result.repaired, { envelope: { ok: true } });
  assert.ok(!('steps' in result));
  assert.deepEqual(withRequestMeta({ ok: true }, null), { ok: true });
});

test('客户端可见 id 只有一个写法', () => {
  assert.equal(clientModelID({ name: 'Big Pickle' }), 'OC · Big Pickle');
});

test('可用清单：目录、判定、最近结果三样都满足才算', () => {
  const models = [model('opencode/a'), model('opencode/b'), model('opencode/c')];
  const validated = new Set(['opencode/a', 'opencode/b', 'opencode/c']);
  const results = { 'opencode/a': { ok: true }, 'opencode/b': { ok: false }, 'opencode/c': { ok: true } };
  assert.deepEqual(usableModelIds(models, validated, results), ['opencode/a', 'opencode/c']);
  // 目录里已经没有的模型不算
  assert.deepEqual(usableModelIds([model('opencode/a')], validated, results), ['opencode/a']);
  // 没有结果的不算
  assert.deepEqual(usableModelIds(models, validated, {}), []);
});

test('回归：采用缓存判定时，可用清单必须用合并后的结果算', () => {
  // 场景：上一轮 ling 探测失败（结果表里 ok:false），这一轮从缓存采用到"成功"的新判定。
  const models = [model('opencode/ling-3.1-flash-free'), model('opencode/big-pickle')];
  const previous = { 'opencode/ling-3.1-flash-free': { ok: false, category: 'timeout' }, 'opencode/big-pickle': { ok: true } };
  const adopted = { 'opencode/ling-3.1-flash-free': { ok: true, source: 'cache' }, 'opencode/big-pickle': { ok: true, source: 'cache' } };
  const validated = new Set(models.map(m => m.id));

  // 旧写法（拿上一份结果算）会把 ling 漏掉——这正是修掉的那个 bug
  assert.deepEqual(usableModelIds(models, validated, previous), ['opencode/big-pickle']);
  // 新写法：先把采用结果并进去再算
  assert.deepEqual(usableModelIds(models, validated, { ...previous, ...adopted }), ['opencode/ling-3.1-flash-free', 'opencode/big-pickle']);
});
