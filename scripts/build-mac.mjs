// macOS 打包：electron-builder 只负责组装 .app，签名与压缩由这里确定性地做完。
//
// 为什么不用 electron-builder 自己的签名：它会自动发现钥匙串里的本地证书
// （本机就有一个别的项目留下的 "… Local Signing"），然后带着 --timestamp 去签，
// 而自签证书拿不到 Apple 时间戳服务 → 必然失败。ad-hoc 签名（-）不需要时间戳，
// 也不依赖任何证书，是"能跑但不是 Apple 公证"这条路线唯一可控的做法。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const root = path.join(import.meta.dirname, '..');
const release = path.join(root, 'release');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const app = path.join(release, 'mac-arm64', 'OC Ferry.app');
const zip = path.join(release, `OC-Ferry-${version}-mac-arm64.zip`);

console.log('① 组装 .app（不签名）…');
await fs.rm(release, { recursive: true, force: true });
await run('npx', ['electron-builder', '--mac', 'dir', '--arm64', '--publish', 'never', '-c.mac.identity=null'], {
  cwd: root,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  maxBuffer: 32 * 1024 * 1024,
});

console.log('② ad-hoc 签名（含嵌套组件）…');
await run('codesign', ['--force', '--deep', '--sign', '-', app]);

console.log('③ 深度严格校验…');
await run('codesign', ['--verify', '--deep', '--strict', app]);
const signature = await run('codesign', ['-dv', app]).catch(error => ({ stderr: error.stderr }));

console.log('④ 压缩…');
await run('ditto', ['-c', '-k', '--keepParent', app, zip]);
const { stdout: digest } = await run('shasum', ['-a', '256', zip]);

const { stdout: size } = await run('du', ['-h', zip]);
console.log(`✓ ${path.relative(root, zip)} · ${size.trim().split(/\s+/)[0]}`);
console.log(`  sha256 ${digest.trim().split(/\s+/)[0]}`);
console.log(`  签名 ${/Authority=(.*)/.exec(signature.stderr ?? '')?.[1]?.trim() ?? '(ad-hoc)'}（未公证，首次打开需右键→打开）`);
