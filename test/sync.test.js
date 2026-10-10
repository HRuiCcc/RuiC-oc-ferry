import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeModels, syncModels, atomicWrite, OWNER, OWNER_FIELD, isOwnedEntry } from '../src/sync.js';
import { validateModelsFile, resolveModelsFile } from '../src/workbuddy-config.js';

const clientModel = (name, extra = {}) => ({ id: `opencode/${name}`, name, images: false, toolcall: true, reasoning: true, variants: {}, ...extra });
const ENDPOINT = 'http://127.0.0.1:41980/v1/chat/completions';

test('合并保留用户条目、改写自有条目、并跳过 id 冲突', () => {
  const document = [
    { id: 'user-model', vendor: 'Custom', apiKey: 'sk-user' },
    { id: 'OC · Old Free', [OWNER_FIELD]: OWNER, apiKey: 'stale' },
    { id: 'OC · Big Pickle', vendor: 'Custom', apiKey: 'sk-manual' },
  ];
  const merged = mergeModels(document, [clientModel('Big Pickle'), clientModel('Space Bunny')], ENDPOINT, 'key-1');
  const ids = merged.map(m => m.id);
  assert.deepEqual(ids, ['user-model', 'OC · Big Pickle', 'OC · Space Bunny']);
  // 用户手写的同名条目保持原样，不被改写也不被删。
  assert.equal(merged.find(m => m.id === 'OC · Big Pickle').apiKey, 'sk-manual');
  const owned = merged.find(m => m.id === 'OC · Space Bunny');
  assert.equal(owned[OWNER_FIELD], OWNER);
  assert.equal(isOwnedEntry(owned), true);
  assert.equal(owned.url, ENDPOINT);
  assert.equal(owned.apiKey, 'key-1');
  assert.equal(owned.vendor, 'Custom');
});

test('对象形态的配置连带维护 availableModels，自有旧 id 被摘掉', () => {
  const document = { version: 2, models: [{ id: 'OC · Gone Free', [OWNER_FIELD]: OWNER }], availableModels: ['OC · Gone Free', 'user-model'] };
  const merged = mergeModels(document, [clientModel('New Free')], ENDPOINT, 'key-1');
  assert.equal(merged.version, 2);
  assert.deepEqual(merged.availableModels, ['user-model', 'OC · New Free']);
});

test('能力与上限按检测结果落进条目', () => {
  const merged = mergeModels([], [clientModel('LongCat', { chatOnly: true, images: true, input: 1000, output: 500, variantFree: true })], ENDPOINT, 'k');
  const entry = merged[0];
  assert.equal(entry.supportsToolCall, false);
  assert.equal(entry.supportsImages, true);
  assert.equal(entry.maxInputTokens, 1000);
  assert.equal(entry.maxOutputTokens, 500);
});

test('空清单只有在允许时才写入，否则拒绝并保留原配置', () => {
  assert.throws(() => mergeModels([], [], ENDPOINT, 'k'), /Empty model discovery/);
  assert.deepEqual(mergeModels([{ id: 'user' }], [], ENDPOINT, 'k', { allowEmpty: true }), [{ id: 'user' }]);
  assert.throws(() => mergeModels({ nope: 1 }, [clientModel('X')], ENDPOINT, 'k'), /Unrecognized WorkBuddy models.json/);
});

test('同步：内容相同不写文件、不备份；写完留备份并能重复执行', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-sync-'));
  const file = path.join(dir, 'models.json');
  await fs.writeFile(file, JSON.stringify([{ id: 'user-model' }], null, 2));
  const before = await fs.stat(file);

  const first = await syncModels(file, [clientModel('A Free')], ENDPOINT, 'k');
  assert.equal(first.changed, true);
  assert.equal(first.count, 1);
  assert.ok(first.backup && await fs.stat(first.backup).then(() => true, () => false));
  assert.equal((await fs.stat(file)).mtimeMs >= before.mtimeMs, true);

  const second = await syncModels(file, [clientModel('A Free')], ENDPOINT, 'k');
  assert.equal(second.changed, false);
  assert.equal(second.count, 1);
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(written.map(m => m.id), ['user-model', 'OC · A Free']);

  // 退出清理：自有条目被摘掉，用户条目留下。
  await syncModels(file, [], ENDPOINT, 'k', { allowEmpty: true });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).map(m => m.id), ['user-model']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('同步锁：已有锁时拒绝写入，过期锁可被接管', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-lock-'));
  const file = path.join(dir, 'models.json');
  await fs.writeFile(file, '[]');
  const lock = `${file}.oc-ferry.lock`;
  await fs.writeFile(lock, 'held');
  await assert.rejects(syncModels(file, [clientModel('A Free')], ENDPOINT, 'k'), /Model sync already running/);
  await fs.rm(lock, { force: true });
  assert.equal((await syncModels(file, [clientModel('A Free')], ENDPOINT, 'k')).changed, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('requireExisting 下缺少文件会报错，而不是凭空造一份配置', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-missing-'));
  await assert.rejects(syncModels(path.join(dir, 'models.json'), [clientModel('A Free')], ENDPOINT, 'k', { requireExisting: true }), /ENOENT/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('配置文件校验：必须是绝对的 models.json，且形状受支持', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-valid-'));
  await assert.rejects(validateModelsFile('models.json'), /请选择 WorkBuddy 的 models.json/);
  await assert.rejects(validateModelsFile(path.join(dir, 'other.json')), /请选择 WorkBuddy 的 models.json/);
  const file = path.join(dir, 'models.json');
  await fs.writeFile(file, '{"nope":1}');
  await assert.rejects(validateModelsFile(file), /不是支持的 WorkBuddy 模型配置格式/);
  await fs.writeFile(file, '\uFEFF[]');
  assert.equal(await validateModelsFile(file), file);
  await fs.rm(dir, { recursive: true, force: true });
});

test('配置文件定位：显式路径优先，找不到返回 null 而不是换一个 profile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-resolve-'));
  const file = path.join(dir, 'models.json');
  await fs.writeFile(file, '[]');
  assert.equal(await resolveModelsFile({ saved: file }), file);
  assert.equal(await resolveModelsFile({ saved: path.join(dir, 'gone.json') }), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('原子写会把内容落进目标文件，临时文件不残留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-atomic-'));
  const file = path.join(dir, 'status.json');
  await atomicWrite(file, '{"a":1}');
  assert.equal(await fs.readFile(file, 'utf8'), '{"a":1}');
  assert.deepEqual((await fs.readdir(dir)).filter(n => n.includes('.tmp')), []);
  await fs.rm(dir, { recursive: true, force: true });
});
