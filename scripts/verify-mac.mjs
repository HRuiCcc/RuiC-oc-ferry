// 打包后校验：
//   ① zip —— 解压最终 zip，对 .app 做深度严格签名校验；
//   ② dmg —— 挂载最终镜像（只读），校验卷里的 .app 签名、拖拽用的符号链接与说明文件。
//
// ad-hoc 签名意味着没有 Apple 公证，但「包内签名完整」「卷里装的是同一个包」
// 这两件事必须自己证明，否则用户拿到的是「签名损坏」的包（这个坑真发生过）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const release = path.join(import.meta.dirname, '..', 'release');
const entries = await fs.readdir(release).catch(() => []);
const zips = entries.filter(name => name.endsWith('.zip'));
const dmgs = entries.filter(name => name.endsWith('.dmg'));
if (!zips.length && !dmgs.length) throw new Error('release/ 里没有 zip 或 dmg 产物');

async function digest(file) {
  const { stdout } = await run('shasum', ['-a', '256', file]);
  return stdout.trim().split(/\s+/)[0];
}

async function verifyApp(appPath) {
  await run('codesign', ['--verify', '--deep', '--strict', appPath]);
  const info = await run('codesign', ['-dv', appPath]).catch(error => ({ stderr: error.stderr }));
  return (/Authority=(.*)/.exec(info.stderr ?? '')?.[1] ?? '(ad-hoc)').trim();
}

// ── ① zip ────────────────────────────────────────────────────────
if (zips.length) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ferry-verify-'));
  try {
    for (const zip of zips) {
      const archive = path.join(release, zip);
      await run('ditto', ['-x', '-k', archive, staging]);
      const apps = (await fs.readdir(staging)).filter(name => name.endsWith('.app'));
      if (!apps.length) throw new Error(`${zip} 里没有 .app`);
      for (const app of apps) {
        const authority = await verifyApp(path.join(staging, app));
        console.log(`✓ ${zip} · ${app} · 深度严格校验通过 · ${authority}`);
        console.log(`  sha256 ${await digest(archive)}`);
      }
      // 每个 zip 单独解压，避免多个包互相污染
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging, { recursive: true });
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// ── ② dmg ───────────────────────────────────────────────────────
for (const dmg of dmgs) {
  const archive = path.join(release, dmg);
  let mountDir = null;
  try {
    const { stdout } = await run('hdiutil', ['attach', archive, '-readonly', '-nobrowse', '-noautoopen']);
    mountDir = stdout
      .split('\n')
      .map(line => line.match(/(\/Volumes\/.+)$/)?.[1])
      .filter(Boolean)
      .pop() ?? null;
    if (!mountDir) throw new Error(`${dmg} 挂载后拿不到挂载点`);

    const contents = await fs.readdir(mountDir);
    const apps = contents.filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`${dmg} 卷里应恰有一个 .app，实际 ${apps.length} 个`);
    const authority = await verifyApp(path.join(mountDir, apps[0]));
    console.log(`✓ ${dmg} · ${apps[0]} · 深度严格校验通过 · ${authority}`);

    const linkTarget = await fs.readlink(path.join(mountDir, '应用程序')).catch(() => null);
    if (linkTarget !== '/Applications') throw new Error(`${dmg} 卷里缺少指向 /Applications 的「应用程序」链接`);
    if (!contents.includes('安装说明.txt')) throw new Error(`${dmg} 卷里缺少 安装说明.txt`);
    console.log('  卷内：应用程序 → /Applications ✓ · 安装说明.txt ✓');
    console.log(`  sha256 ${await digest(archive)}`);
  } finally {
    if (mountDir) {
      for (const args of [['detach', mountDir, '-quiet'], ['detach', mountDir, '-force', '-quiet']]) {
        await run('hdiutil', args).catch(() => {});
        if (!(await fs.access(mountDir).then(() => true, () => false))) break;
      }
    }
  }
}
