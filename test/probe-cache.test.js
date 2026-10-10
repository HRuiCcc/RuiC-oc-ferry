import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProbeCache, fingerprint, DEFAULT_OK_TTL_MINUTES, DEFAULT_TRANSIENT_TTL_MINUTES } from '../src/probe-cache.js';

const model = (extra = {}) => ({ id: 'opencode/big-pickle', name: 'Big Pickle', toolcall: true, reasoning: true, images: false, context: 200000, output: 32000, ...extra });
const scratch = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-cache-'));
  return { dir, file: path.join(dir, 'probe-cache.json') };
};

test('成功的判定在 TTL 内跨重启可用', async () => {
  const { dir, file } = await scratch();
  let now = 1_700_000_000_000;
  const first = createProbeCache({ file, now: () => now });
  await first.load();
  first.record(model(), { ok: true, chatOnly: false, category: 'available', durationMs: 4200 });
  await first.flush();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 1);

  // 模拟重启：新实例读同一份文件
  const second = createProbeCache({ file, now: () => now });
  assert.equal(await second.load(), 1);
  assert.equal(second.fresh(model())?.ok, true);

  // TTL 之后失效
  now += (DEFAULT_OK_TTL_MINUTES + 1) * 60_000;
  assert.equal(second.fresh(model()), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('超时只缓存很短时间，明确的下线判定缓存更久', async () => {
  const { dir, file } = await scratch();
  let now = 1_700_000_000_000;
  const cache = createProbeCache({ file, now: () => now });
  await cache.load();
  cache.record(model(), { ok: false, category: 'timeout', message: 'Model probe timed out' });
  cache.record(model({ id: 'opencode/dead' }), { ok: false, category: 'error', message: 'has been deprecated' });
  await cache.flush();

  now += (DEFAULT_TRANSIENT_TTL_MINUTES + 1) * 60_000;
  assert.equal(cache.fresh(model()), null, '超时判定过期，下次重新探测');
  assert.equal(cache.fresh(model({ id: 'opencode/dead' }))?.category, 'error', '明确的下线判定还留着');
  await fs.rm(dir, { recursive: true, force: true });
});

test('能力声明变了，旧判定作废', async () => {
  const { dir, file } = await scratch();
  const cache = createProbeCache({ file });
  await cache.load();
  cache.record(model(), { ok: true, chatOnly: false, category: 'available' });
  await cache.flush();
  assert.ok(cache.fresh(model()));
  // 同一个 id，但目录里说它现在支持图片了：判定要重来
  assert.equal(cache.fresh(model({ images: true })), null);
  assert.notEqual(fingerprint(model()), fingerprint(model({ images: true })));
  await fs.rm(dir, { recursive: true, force: true });
});

test('目录里消失的模型会被 prune 掉', async () => {
  const { dir, file } = await scratch();
  const cache = createProbeCache({ file });
  await cache.load();
  cache.record(model(), { ok: true, chatOnly: false, category: 'available' });
  cache.record(model({ id: 'opencode/gone' }), { ok: true, chatOnly: false, category: 'available' });
  await cache.flush();
  assert.equal(cache.prune([model()]), 1);
  await cache.flush();
  assert.equal(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).entries).length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('缓存文件损坏或不存在都按"没有缓存"处理，不抛错', async () => {
  const { dir, file } = await scratch();
  const cache = createProbeCache({ file });
  assert.equal(await cache.load(), 0);
  await fs.writeFile(file, '{ 这不是 JSON');
  assert.equal(await createProbeCache({ file }).load(), 0);
  await fs.writeFile(file, JSON.stringify({ version: 99, entries: { a: { at: 1 } } }));
  assert.equal(await createProbeCache({ file }).load(), 0);
  await fs.rm(dir, { recursive: true, force: true });
});
