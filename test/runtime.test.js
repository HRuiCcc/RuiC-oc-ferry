import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { c as createTar } from 'tar';
import { findRuntime, runtimeCandidates, startBackend } from '../src/runtime.js';

const PKG = 'opencode-darwin-arm64';
const probe = async file => (await fs.readFile(file, 'utf8')).trim();

// 造一个真的 npm 形态的 tarball：包里只有 package/bin/opencode 一个文件，
// 它的内容就是版本号，这样假 probe 能像真二进制一样报告版本。
async function makeTarball(version) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-tar-'));
  await fs.mkdir(path.join(dir, 'package', 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package', 'bin', 'opencode'), version);
  const file = path.join(dir, 'pkg.tgz');
  await createTar({ gzip: true, cwd: dir, file }, ['package/bin/opencode']);
  const bytes = await fs.readFile(file);
  await fs.rm(dir, { recursive: true, force: true });
  return { bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, tarball: `https://registry.npmjs.org/${PKG}/-/${PKG}-${version}.tgz` };
}

function metadataFor(version, tarball, integrity) {
  return { name: PKG, version, dist: { tarball, integrity } };
}

function fetchFor({ metadata, bytes, onCall }) {
  return async (url, init) => {
    onCall?.(url, init);
    if (url.endsWith('/latest')) {
      if (metadata instanceof Error) throw metadata;
      return { ok: true, status: 200, json: async () => metadata };
    }
    if (bytes instanceof Error) throw bytes;
    return { ok: true, status: 200, body: new Response(bytes).body };
  };
}

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-rt-'));
  return { dir, root: path.join(dir, 'runtime'), dataDir: dir };
}

test('本机运行时发现路径按平台给出，Windows 额外找 npm 全局', () => {
  const darwin = runtimeCandidates({ name: PKG, binary: 'opencode' }, 'darwin', {}, '/Users/me');
  assert.deepEqual(darwin, ['/Users/me/.opencode/bin/opencode', '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']);
  const win = runtimeCandidates({ name: 'opencode-windows-x64', binary: 'opencode.exe' }, 'win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me');
  assert.deepEqual(win, [
    'C:\\Users\\me\\.opencode\\bin\\opencode.exe',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
  ]);
  assert.deepEqual(runtimeCandidates({ name: PKG, binary: 'opencode' }, 'darwin', { FERRY_OPENCODE_PATH: '/custom/opencode' }, '/Users/me')[0], '/custom/opencode');
});

test('官方查不到版本时复用本机已有的托管运行时', async () => {
  const { dir, root, dataDir } = await scratch();
  await fs.mkdir(path.join(root, '1.18.30'), { recursive: true });
  await fs.writeFile(path.join(root, '1.18.30', 'opencode'), '1.18.30');
  const logs = [];
  const file = await findRuntime(dataDir, () => {}, {
    probe,
    latest: async () => { throw new Error('离线'); },
    log: message => logs.push(message),
  });
  assert.equal(file, path.join(root, '1.18.30', 'opencode'));
  assert.ok(logs.some(line => /using local 1\.18\.30/.test(line)));
  await fs.rm(dir, { recursive: true, force: true });
});

test('官方有更新版本时下载、校验、解压，并落进按版本命名的目录', async () => {
  const { dir, root, dataDir } = await scratch();
  const { bytes, integrity, tarball } = await makeTarball('1.19.0');
  const seen = [];
  const file = await findRuntime(dataDir, () => {}, {
    probe,
    fetch: fetchFor({ metadata: metadataFor('1.19.0', tarball, integrity), bytes, onCall: url => seen.push(url) }),
    log: () => {},
  });
  assert.equal(file, path.join(root, '1.19.0', 'opencode'));
  assert.equal(await fs.readFile(file, 'utf8'), '1.19.0');
  assert.equal((await fs.stat(file)).mode & 0o111, 0o111, '二进制要可执行');
  assert.ok(seen.some(url => url.endsWith('/latest')));
  assert.ok(seen.some(url => url === tarball));
  // 下载的压缩包不留存档
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter(n => n.includes('.tgz') || n.startsWith('extract-')), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('校验值不符就拒绝安装，并且不留半成品', async () => {
  const { dir, root, dataDir } = await scratch();
  const { bytes, tarball } = await makeTarball('1.19.1');
  await assert.rejects(findRuntime(dataDir, () => {}, {
    probe,
    fetch: fetchFor({ metadata: metadataFor('1.19.1', tarball, 'sha512-' + 'A'.repeat(86)), bytes }),
    log: () => {},
  }), /checksum mismatch/);
  // 版本目录会先建出来，但里面不能留下任何二进制；压缩包也不能留。
  assert.deepEqual(await fs.readdir(path.join(root, '1.19.1')), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('官方元数据里指向别处的 tarball 不可信，直接跳过', async () => {
  const { dir, dataDir } = await scratch();
  const { bytes, integrity } = await makeTarball('1.19.2');
  await assert.rejects(findRuntime(dataDir, () => {}, {
    probe,
    fetch: fetchFor({ metadata: metadataFor('1.19.2', 'https://evil.test/pkg.tgz', integrity), bytes }),
    log: () => {},
  }), /无法获取 OpenCode 版本信息/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('官方源挂了会退到国内镜像，校验值仍用官方的那一份', async () => {
  const { dir, root, dataDir } = await scratch();
  const { bytes, integrity } = await makeTarball('1.19.3');
  const mirrorTarball = `https://registry.npmmirror.com/${PKG}/-/${PKG}-1.19.3.tgz`;
  const logs = [];
  const fetch = async url => {
    // 官方源的元数据请求失败，镜像的元数据成功
    if (url.startsWith('https://registry.npmjs.org/') && url.endsWith('/latest')) throw new Error('registry down');
    if (url.endsWith('/latest')) return { ok: true, status: 200, json: async () => metadataFor('1.19.3', mirrorTarball, integrity) };
    return { ok: true, status: 200, body: new Response(bytes).body };
  };
  const file = await findRuntime(dataDir, () => {}, { probe, fetch, log: message => logs.push(message) });
  assert.equal(file, path.join(root, '1.19.3', 'opencode'));
  assert.equal(await fs.readFile(file, 'utf8'), '1.19.3');
  assert.ok(logs.some(line => /已切换到 registry\.npmmirror\.com/.test(line)));
  await fs.rm(dir, { recursive: true, force: true });
});

test('字节和官方校验值不符时拒绝安装（镜像被换过字节的情形）', async () => {
  const { dir, dataDir } = await scratch();
  const { bytes, tarball } = await makeTarball('1.19.5');
  const wrong = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
  await assert.rejects(findRuntime(dataDir, () => {}, {
    probe,
    fetch: fetchFor({ metadata: metadataFor('1.19.5', tarball, wrong), bytes }),
    log: () => {},
  }), /checksum mismatch/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('代理连不上时回退直连，并把这次降级报给上层', async () => {
  const { dir, dataDir } = await scratch();
  const { bytes, integrity, tarball } = await makeTarball('1.19.4');
  let attempts = 0, fellBack = 0;
  const inner = fetchFor({ metadata: metadataFor('1.19.4', tarball, integrity), bytes });
  const file = await findRuntime(dataDir, () => {}, {
    probe,
    proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:1' },
    fetch: async (url, init) => {
      attempts += 1;
      // 第一次（带代理 dispatcher）失败，之后直连成功
      if (attempts === 1) throw new Error('proxy refused');
      return inner(url, init);
    },
    onProxyFallback: async () => { fellBack += 1; },
    log: () => {},
  });
  assert.equal(fellBack, 1);
  assert.equal(await fs.readFile(file, 'utf8'), '1.19.4');
  await fs.rm(dir, { recursive: true, force: true });
});

test('启动脚本不能当运行时：.cmd/.bat 候选会被拒绝并记录原因', async () => {
  const { dir, dataDir } = await scratch();
  const cmd = path.join(dir, 'opencode.cmd');
  await fs.writeFile(cmd, '@echo off');
  const rejected = [];
  await assert.rejects(findRuntime(dataDir, () => {}, {
    probe,
    candidates: [cmd],
    latest: async () => { throw new Error('离线') },
    log: message => rejected.push(message),
  }), /离线/);
  assert.ok(rejected.some(line => /launcher script cannot be used/.test(line)));
  await fs.rm(dir, { recursive: true, force: true });
});

test('startBackend 用白名单环境变量启动，失败时清理干净', async () => {
  const { dir, dataDir } = await scratch();
  const binary = path.join(dir, 'bin', 'opencode');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  // 一个假二进制：--version 报版本，serve 立刻退出（模拟启动失败）。
  await fs.writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.18.35'); process.exit(0); }
if (args[0] === 'models') { process.exit(0); }
process.exit(3);
`);
  await fs.chmod(binary, 0o755);
  process.env.SECRET_API_KEY = 'should-not-leak';
  const logFile = path.join(dir, 'opencode.log');
  const { createWriteStream } = await import('node:fs');
  const log = createWriteStream(logFile);
  await assert.rejects(startBackend(binary, dataDir, log), /OpenCode exited/);
  log.end();
  delete process.env.SECRET_API_KEY;
  await fs.rm(dir, { recursive: true, force: true });
});
