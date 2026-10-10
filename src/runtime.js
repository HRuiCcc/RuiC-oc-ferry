import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { x as extract } from 'tar';
import { ProxyAgent } from 'undici';
import { runtimePackage } from './platform.js';
import { replaceWithRetry } from './atomic.js';
import { Backend, nativePermissions } from './backend.js';
import { finderAgent } from './config-finder.js';

const exec = promisify(execFile);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

function compareVersions(a, b) {
  const left = a.split(/[+-]/, 1)[0].split('.').map(Number);
  const right = b.split(/[+-]/, 1)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

// 本机可能已经有一份 OpenCode：macOS 装在 ~/.opencode/bin，Windows 除了同一位置，
// 还可能是 npm 全局安装的（那是个 .cmd 包装脚本，指向真实的 exe）。
export function runtimeCandidates(pkg = runtimePackage(), platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const installed = platform === 'win32'
    ? [p.join(home, '.opencode', 'bin', pkg.binary),
       p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', 'opencode-ai', 'bin', pkg.binary)]
    : [p.join(home, '.opencode', 'bin', pkg.binary), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'];
  return [env.FERRY_OPENCODE_PATH, ...installed].filter(Boolean);
}

// 运行时的获取顺序：先找本机现成的（并复制进托管目录），再问官方 npm 的最新版本；
// 本机版本不比官方旧就直接用，旧了才下载。下载必须过 SHA-512，解压只取那一个二进制文件。
export async function findRuntime(dataDir, updateStatus, options = {}) {
  const pkg = runtimePackage();
  const root = path.join(dataDir, 'runtime');
  const log = options.log ?? (() => {});
  const version = options.probe ?? (async file => (await exec(file, ['--version'], { timeout: 15000, windowsHide: true })).stdout.trim());
  const request = options.fetch ?? globalThis.fetch;
  const registries = options.registries ?? REGISTRIES;
  const proxy = options.proxyEnv?.HTTPS_PROXY || options.proxyEnv?.https_proxy;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  let useProxy = Boolean(dispatcher);
  const downloadRequest = async (url, timeout) => {
    const init = () => ({ signal: AbortSignal.timeout(timeout), ...(useProxy ? { dispatcher } : {}) });
    try { return await request(url, init()); }
    catch (error) {
      if (!useProxy) throw error;
      // 代理由系统设置而来，它坏掉不该导致装不上：退直连并把这个决定告诉上层，
      // 让 OpenCode 自己后面也别用这个代理。
      useProxy = false;
      const message = '系统代理连接失败，正在直连下载 OpenCode';
      updateStatus(message); log(message);
      await dispatcher.destroy();
      await options.onProxyFallback?.();
      return request(url, init());
    }
  };
  const validMetadata = metadata => {
    const dist = metadata?.dist;
    let tarball;
    try { tarball = new URL(dist?.tarball); } catch { return false; }
    return metadata.name === pkg.name && VERSION.test(metadata.version ?? '') &&
      dist?.integrity?.startsWith('sha512-') &&
      registries.some(registry => tarball.origin === registry && tarball.pathname.startsWith(`/${pkg.name}/-/`));
  };
  const readLatest = options.latest ?? (async () => {
    const failures = [];
    for (const registry of registries) {
      updateStatus(`正在从 ${new URL(registry).hostname} 获取 OpenCode 版本信息`);
      try {
        const response = await downloadRequest(`${registry}/${pkg.name}/latest`, 30000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const metadata = await response.json();
        if (!validMetadata(metadata)) throw new Error('返回的安装信息不可信');
        if (registry !== registries[0]) log(`OpenCode 官方源不可用，已切换到 ${new URL(registry).hostname}`);
        return metadata;
      } catch (error) { failures.push(`${new URL(registry).hostname}: ${error.message}`); }
    }
    throw new Error(`无法获取 OpenCode 版本信息，官方源和国内镜像均失败（${failures.join('；')}）`);
  });
  const installLatest = async metadata => {
    const target = path.join(root, metadata.version, pkg.binary);
    if (await version(target).then(found => found === metadata.version, () => false)) return target;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const archive = path.join(path.dirname(target), 'download.tgz');
    const tarballs = [...new Set([metadata.dist.tarball,
      ...registries.map(registry => `${registry}/${pkg.name}/-/${pkg.name}-${metadata.version}.tgz`)])];
    const failures = [];
    let downloaded = false, checksumFailed = false;
    for (const tarball of tarballs) {
      updateStatus(`正在从 ${new URL(tarball).hostname} 下载 OpenCode ${metadata.version}，首次启动可能需要几分钟`);
      try {
        const response = await downloadRequest(tarball, 180000);
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
        const hash = createHash('sha512');
        for await (const chunk of createReadStream(archive)) hash.update(chunk);
        // 校验值来自官方元数据：镜像的字节和它不符就不能装，这正是镜像被篡改时唯一能拦住的地方。
        if (`sha512-${hash.digest('base64')}` !== metadata.dist.integrity) {
          checksumFailed = true;
          throw new Error('完整性校验失败');
        }
        if (tarball !== metadata.dist.tarball) log(`OpenCode 下载已切换到 ${new URL(tarball).origin}`);
        downloaded = true;
        break;
      } catch (error) { failures.push(`${new URL(tarball).hostname}: ${error.message}`); }
    }
    if (!downloaded) {
      await fs.unlink(archive).catch(() => {});
      if (checksumFailed) throw new Error('OpenCode download checksum mismatch');
      throw new Error(`OpenCode 下载失败，官方源和国内镜像均不可用（${failures.join('；')}）`);
    }
    const member = `package/bin/${pkg.binary}`;
    const staging = await fs.mkdtemp(path.join(path.dirname(target), 'extract-'));
    try {
      await extract({ file: archive, cwd: staging, strip: 2, filter: (name, entry) => name === member && entry.type === 'File' });
      await replaceWithRetry(path.join(staging, pkg.binary), target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    await fs.chmod(target, 0o755);
    if (await version(target) !== metadata.version) throw new Error('Downloaded OpenCode version mismatch');
    await fs.unlink(archive).catch(() => {});
    return target;
  };
  const local = [];
  // 复用已托管的运行时（含早期安装器留下的目录）：版本号是目录名，二进制自己报的版本要和它对上。
  const installed = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && VERSION.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
  for (const entry of installed) {
    const file = path.join(root, entry.name, pkg.binary);
    try { if (await version(file) === entry.name) local.push({ file, version: entry.name, source: 'managed runtime' }); } catch {}
  }
  const candidates = options.candidates ?? runtimeCandidates(pkg);
  const rejected = [];
  for (const file of candidates) {
    // 启动脚本不能当运行时：Windows 不能直接执行 .cmd，
    // 把它复制成 opencode.exe 只会装出一个不是可执行文件的东西。
    if (/\.(?:cmd|bat|ps1)$/i.test(file)) { rejected.push(`${file}: launcher script cannot be used as the runtime binary`); continue; }
    try {
      const found = await version(file);
      if (!VERSION.test(found)) { rejected.push(`${file}: unrecognized version output (${found || 'empty'})`); continue; }
      const target = path.join(root, found, pkg.binary);
      // 已经是这个版本的托管文件不要重写：Windows 无法替换正在运行的映像，
      // 而这个运行时恰好正在被使用时重写只会白白失败一次。
      if (await version(target).then(found2 => found2 === found, () => false)) { local.push({ file: target, version: found, source: 'managed runtime' }); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      updateStatus('Preparing isolated OpenCode runtime');
      const temp = target + '.tmp';
      try { await fs.copyFile(file, temp); await fs.chmod(temp, 0o755); await replaceWithRetry(temp, target); }
      finally { await fs.unlink(temp).catch(() => {}); }
      local.push({ file: target, version: found, source: file });
    } catch (e) { rejected.push(`${file}: ${e.code || e.message}`); }
  }
  local.sort((a, b) => compareVersions(b.version, a.version));
  const best = local[0];
  let metadata;
  try { metadata = await readLatest(); }
  catch (e) {
    // 查不到官方版本不是致命问题：本机已有可用运行时就直接用。
    if (best) { log(`Could not check official OpenCode latest (${e.message}); using local ${best.version}: ${best.file}`); return best.file; }
    if (rejected.length) log(`Local OpenCode candidates were rejected (${rejected.join('; ')})`);
    throw e;
  }
  if (best && compareVersions(best.version, metadata.version) >= 0) {
    log(`Using ${best.source} OpenCode ${best.version}: ${best.file}`);
    return best.file;
  }
  if (best) log(`Local OpenCode ${best.version} is older than official ${metadata.version}; downloading official runtime`);
  else log(rejected.length ? `Local OpenCode candidates were rejected (${rejected.join('; ')}); downloading official runtime` : 'No local OpenCode runtime found; downloading official runtime');
  return await installLatest(metadata);
}

// 隔离配置：所有本机动作都要审批，自动更新、分享、外部技能全关，
// 三个专用 agent 覆盖"外部推理 / 仅对话 / 只读找配置"三种用途。
export const isolatedConfig = {
  permission: nativePermissions, autoupdate: false, share: 'disabled',
  agent: { 'oc-ferry-finder': finderAgent, 'oc-ferry-chat': { mode: 'primary', description: 'Text-only external conversation', prompt: 'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.', permission: nativePermissions }, 'oc-ferry': { mode: 'primary', description: 'External client inference only',
    prompt: 'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.',
    permission: nativePermissions } },
};

// 起一个隔离的 OpenCode 服务：独立的 XDG 目录、随机口令、随机端口。
// 环境变量按白名单复制，别的 provider 的 key 和 OpenCode 自己的授权覆盖都不带进来。
export async function startBackend(binary, dataDir, logStream, proxyEnv = {}) {
  const actualVersion = (await exec(binary, ['--version'], { timeout: 15000, windowsHide: true })).stdout.trim();
  const root = path.join(dataDir, 'opencode');
  for (const d of ['config', 'data', 'cache', 'state', 'project']) await fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 });
  const env = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC'])
    if (process.env[k]) env[k] = process.env[k];
  for (const name of ['config', 'data', 'cache', 'state']) env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);
  Object.assign(env, proxyEnv);
  const password = randomBytes(24).toString('hex');
  Object.assign(env, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(isolatedConfig) });
  // 先刷新一次模型目录再起常驻服务，否则第一次读到的会是内置的过期快照。
  await exec(binary, ['models', 'opencode', '--refresh', '--pure'], { cwd: path.join(root, 'project'), env, windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); });
  });
  const child = spawn(binary, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: path.join(root, 'project'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(logStream, { end: false }); child.stderr.pipe(logStream, { end: false });
  let failure; child.on('error', e => { failure = e; });
  const backend = new Backend(`http://127.0.0.1:${port}`, password, undefined, message => logStream.write(`${new Date().toISOString()} ${message}\n`));
  const stop = async () => {
    backend.stopEvents();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 4000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  try {
    // 就绪判据是健康检查，不是"进程还活着"：启动期间的一次退出必须当场报出来。
    for (let i = 0; i < 120; i++) {
      if (failure || child.exitCode !== null) throw failure || new Error(`OpenCode exited: ${child.exitCode}`);
      try {
        const health = await backend.request('/global/health', 'GET', undefined, undefined, 1000);
        if (health.healthy) {
          if (health.version !== actualVersion) throw new Error('Unexpected OpenCode server version');
          return { backend, stop, child, version: health.version };
        }
      } catch (e) { if (e.message === 'Unexpected OpenCode server version') throw e; }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('OpenCode startup timed out');
  } catch (e) { await stop(); throw e; }
}
