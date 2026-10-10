import fs from 'node:fs/promises';
import { atomicWrite } from './sync.js';

// 判定缓存：把"这个模型能不能按 WorkBuddy 的方式干活"这条结论跨重启留下来。
//
// 两个刻意的区分：
//   1. 这里存的是**探测判定**，不是某次真实调用的观察。混在一起的话，一次上游抽风
//      就会把模型从可用列表里撤掉：这两件事必须分开记。
//   2. 失败也分性质：超时和限流是**当时的负载**，几分钟后自己会好；已下线、无权限、
//      额度用尽才是**关于这个模型的结论**。前者缓存 10 分钟避免刚重启就白等一分钟，
//      后者缓存 1 小时；两者的过期时间都远短于成功判定的 6 小时。
export const DEFAULT_OK_TTL_MINUTES = 360;
export const DEFAULT_TRANSIENT_TTL_MINUTES = 10;
export const DEFAULT_REJECT_TTL_MINUTES = 60;

const TRANSIENT = new Set(['timeout', 'rate_limit']);
const VERSION = 1;

// 目录里同一个模型的能力声明变了（工具/推理/图片/上下文/输出上限），
// 旧判定就不一定还成立，缓存必须作废。
export function fingerprint(model) {
  return [model.toolcall === true, model.reasoning === true, model.images === true, model.context ?? 0, model.output ?? 0].join('|');
}

export function createProbeCache({ file, okTtlMinutes = DEFAULT_OK_TTL_MINUTES, transientTtlMinutes = DEFAULT_TRANSIENT_TTL_MINUTES, rejectTtlMinutes = DEFAULT_REJECT_TTL_MINUTES, now = () => Date.now(), log = () => {} }) {
  const ttlFor = verdict => {
    if (verdict.ok) return okTtlMinutes * 60_000;
    return (TRANSIENT.has(verdict.category) ? transientTtlMinutes : rejectTtlMinutes) * 60_000;
  };
  const entries = new Map();
  let writes = Promise.resolve();

  const cache = {
    // 读缓存失败不是错误路径：最坏情况就是这一轮全量重测。
    async load() {
      try {
        const document = JSON.parse(await fs.readFile(file, 'utf8'));
        if (document?.version !== VERSION || typeof document.entries !== 'object') return 0;
        for (const [id, verdict] of Object.entries(document.entries ?? {})) {
          if (verdict && typeof verdict === 'object' && Number.isFinite(verdict.at)) entries.set(id, verdict);
        }
        return entries.size;
      } catch (error) {
        if (error.code !== 'ENOENT') log(`判定缓存读取失败（按全量重测处理）：${error.message}`);
        return 0;
      }
    },
    // 新鲜且能力指纹一致的判定才算数；其余当作没有，交给探测。
    fresh(model) {
      const verdict = entries.get(model.id);
      if (!verdict || verdict.fingerprint !== fingerprint(model)) return null;
      if (now() - verdict.at >= ttlFor(verdict)) return null;
      return verdict;
    },
    record(model, verdict) {
      entries.set(model.id, { ...verdict, fingerprint: fingerprint(model), at: verdict.at ?? now() });
      // 探测是并发跑的，写入串行化：后一次保存不能盖掉前一次。
      writes = writes.then(() => atomicWrite(file, JSON.stringify({ version: VERSION, entries: Object.fromEntries(entries) }, null, 2)))
        .catch(error => log(`判定缓存写入失败：${error.message}`));
      return writes;
    },
    // 目录里已经没有的模型，判定留着只会让缓存越来越大。
    prune(models) {
      const alive = new Set(models.map(model => model.id));
      let dropped = 0;
      for (const id of [...entries.keys()]) if (!alive.has(id)) { entries.delete(id); dropped += 1; }
      if (dropped) {
        writes = writes.then(() => atomicWrite(file, JSON.stringify({ version: VERSION, entries: Object.fromEntries(entries) }, null, 2)))
          .catch(error => log(`判定缓存写入失败：${error.message}`));
      }
      return dropped;
    },
    size: () => entries.size,
    get: id => entries.get(id),
    async flush() { await writes; },
  };
  return cache;
}
