import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workBuddyReasoning } from './reasoning.js';
import { clientModelID } from './model-status.js';
import { replaceWithRetry } from './atomic.js';
import { parseJson } from './json.js';

// 导入进 WorkBuddy 的条目都带这个标记。写入时只增删自己标记过的条目，
// 用户手动配的模型一条都不动——退出清理也靠它来区分"哪些是我放的"。
export const OWNER = 'oc-ferry-v1';
export const OWNER_FIELD = 'ocFerryOwner';
// 早期版本把标记写在另一个字段名下。读取时一并认（值必须是本产品自己的标记），
// 这样旧条目会在下一次写入时自动换成新字段，用户不需要做任何事。
const LEGACY_OWNER_FIELDS = ['buddyBridgeOwner'];

export function isOwnedEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry[OWNER_FIELD] === OWNER) return true;
  return LEGACY_OWNER_FIELDS.some(field => entry[field] === OWNER);
}
const LOCK_STALE_MS = 5 * 60 * 1000;

export async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  // status.json、settings.json 和 WorkBuddy 的 models.json 都走这里：
  // Windows 上的瞬时共享冲突不能把一次例行刷新变成导入失败。
  try { await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await replaceWithRetry(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

// 合并规则：先摘掉自己上次放进去的，再把这次的清单放进去。
// id 冲突时让位给用户自己的条目——同名模型宁可少导一个，也不能覆盖别人的配置；
// 客户端可见 id（`OC · xxx`）也参与查重，否则会在 WorkBuddy 里出现两个同名模型。
export function mergeModels(document, models, endpoint, key, { allowEmpty = false } = {}) {
  if (!models.length && !allowEmpty) throw new Error('Empty model discovery; existing configuration preserved');
  const list = Array.isArray(document) ? document : document?.models;
  if (!Array.isArray(list)) throw new Error('Unrecognized WorkBuddy models.json; left unchanged');
  const kept = list.filter(m => !isOwnedEntry(m));
  const conflicts = new Set(kept.map(m => m.id));
  const entries = models.filter(m => !conflicts.has(m.id) && !conflicts.has(clientModelID(m))).map(m => ({
    id: clientModelID(m), name: clientModelID(m), vendor: 'Custom', url: endpoint, apiKey: key,
    supportsToolCall: !m.chatOnly, supportsImages: m.images === true, ...workBuddyReasoning(m),
    [OWNER_FIELD]: OWNER,
    ...((m.input ?? m.context) ? { maxInputTokens: m.input ?? m.context } : {}),
    ...(m.output ? { maxOutputTokens: m.output } : {}),
  }));
  const combined = [...kept, ...entries];
  if (Array.isArray(document)) return combined;
  const updated = { ...document, models: combined };
  // 对象形态里可能还有一份可用的 id 列表：旧的自有条目要摘掉，新的补进去，
  // 用户自己加进这份列表的 id 保持原样。
  if (Array.isArray(document.availableModels)) {
    const old = new Set(list.filter(m => isOwnedEntry(m) && !kept.includes(m)).map(m => m.id));
    updated.availableModels = [...new Set([...document.availableModels.filter(id => !old.has(id)), ...entries.map(m => m.id)])];
  }
  return updated;
}

// 写 WorkBuddy 配置：加锁 → 读旧 → 合并 → 比对 → 备份 → 原子替换 → 解锁。
// 比对相同就直接返回，不产生备份也不动 mtime；读写之间文件被别人改过就整体放弃重来，
// 免得把别人刚写的内容覆盖掉。
// 每写一次配置就留一份备份，重启频繁时会堆一片；只保留最近 5 份。
// 文件名里的时间戳是定宽的，所以按名字排序就等于按时间排序。
export async function pruneBackups(file, keep = 5) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.oc-ferry-`;
  try {
    const names = (await fs.readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith('.bak')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await fs.unlink(path.join(directory, name)).catch(() => {});
  } catch {}
}

export async function syncModels(file, models, endpoint, key, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.oc-ferry.lock`;
  await fs.stat(lockFile).then(async stat => {
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.unlink(lockFile).catch(() => {});
  }, () => {});
  const lock = await fs.open(lockFile, 'wx', 0o600).catch(() => { throw new Error('Model sync already running; no changes made'); });
  try {
    const old = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT' && !options.requireExisting) return null; throw e; });
    const document = old === null ? [] : parseJson(old);
    const merged = mergeModels(document, models, endpoint, key, options);
    const count = (Array.isArray(merged) ? merged : merged.models).filter(m => isOwnedEntry(m)).length;
    if (JSON.stringify(merged) === JSON.stringify(document)) return { changed: false, count };
    const current = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT' && !options.requireExisting) return null; throw e; });
    if (current !== old) throw new Error('WorkBuddy configuration changed during sync; retry refresh');
    let backup;
    if (old !== null) {
      backup = `${file}.oc-ferry-${Date.now()}.bak`;
      await fs.writeFile(backup, old, { mode: 0o600, flag: 'wx' });
      await pruneBackups(file);
    }
    await atomicWrite(file, JSON.stringify(merged, null, 2) + '\n');
    return { changed: true, count, backup };
  } finally { await lock.close(); await fs.unlink(lockFile).catch(() => {}); }
}
