// 打包后校验：解压最终 zip，对 .app 做深度严格签名校验。
// ad-hoc 签名意味着没有 Apple 公证，但"包内签名完整"这件事必须自己证明，
// 否则用户拿到的是"签名损坏"的包（这个坑真发生过）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const release = path.join(import.meta.dirname, '..', 'release');
const zips = (await fs.readdir(release).catch(() => [])).filter(name => name.endsWith('.zip'));
if (!zips.length) throw new Error('release/ 里没有 zip 产物');

const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ferry-verify-'));
try {
  for (const zip of zips) {
    const archive = path.join(release, zip);
    await run('ditto', ['-x', '-k', archive, staging]);
    const apps = (await fs.readdir(staging)).filter(name => name.endsWith('.app'));
    if (!apps.length) throw new Error(`${zip} 里没有 .app`);
    for (const app of apps) {
      const target = path.join(staging, app);
      await run('codesign', ['--verify', '--deep', '--strict', target]);
      const info = await run('codesign', ['-dv', target]).catch(error => ({ stderr: error.stderr }));
      const authority = /Authority=(.*)/.exec(info.stderr ?? '')?.[1] ?? '(ad-hoc)';
      const { stdout } = await run('shasum', ['-a', '256', archive]);
      console.log(`✓ ${zip} · ${app} · 深度严格校验通过 · ${authority.trim()}`);
      console.log(`  sha256 ${stdout.trim().split(/\s+/)[0]}`);
    }
    // 每个 zip 单独解压，避免多个包互相污染
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
  }
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
