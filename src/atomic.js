import fs from 'node:fs/promises';

// rename 覆盖在 Windows 上不是无条件成功：目标被别的进程打开（杀毒实时扫描、同步盘、
// 编辑器，或正在被改写的那份配置的读取者）时会以 EPERM/EACCES/EBUSY 拒绝，而这些占用
// 通常只持续很短一段时间，所以短暂重试而不是让整次写入直接失败。POSIX 下 rename 是
// 原子的，几乎不会走到重试分支。
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const DELAYS = [50, 100, 200, 400, 800];

export async function replaceWithRetry(temp, target, { rename = fs.rename, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), delays = DELAYS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(temp, target); }
    catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}
