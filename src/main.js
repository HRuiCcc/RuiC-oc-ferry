import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveModelsFile, validateModelsFile } from './workbuddy-config.js';
import { searchConfig, windowsSearchRoots } from './config-finder.js';
import { dataDirectory } from './platform.js';
import { findRuntime, startBackend } from './runtime.js';
import { createServer } from './server.js';
import { listenService } from './service-instance.js';
import { systemProxyEnvironment } from './system-proxy.js';
import { prepare, BridgeError } from './protocol.js';
import { PROBE_TIMEOUT, probeBody, probeModel, probeFailure, formatUnsupported } from './probe.js';
import { modelResult, withRequestMeta, usableModelIds } from './model-status.js';
import { atomicWrite, syncModels } from './sync.js';
import { createProbeCache } from './probe-cache.js';

// 服务端进程：Electron 以 fork 方式拉起它，也可以直接 `npm start` 独立运行。
// 它只监听 127.0.0.1，口令是一次一发的本地密钥，所有状态都写在数据目录里。
const dataDir = process.env.FERRY_DATA_DIR || dataDirectory();
const port = Number(process.env.FERRY_PORT || 41980);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid FERRY_PORT');
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const lockFile = path.join(dataDir, 'service.pid');
let server = await listenService(port);
await fs.writeFile(lockFile, String(process.pid), { mode: 0o600 });
const tokenFile = path.join(dataDir, 'api-key');
let key;
try { key = (await fs.readFile(tokenFile, 'utf8')).trim(); }
catch (e) { if (e.code !== 'ENOENT') throw e; key = randomBytes(32).toString('hex'); await fs.writeFile(tokenFile, key, { flag: 'wx', mode: 0o600 }); }
const settingsFile = path.join(dataDir, 'settings.json');
let settings = {};
try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch {}
const endpoint = `http://127.0.0.1:${port}/v1`;
let models = [], runtime, binary, stopping = false, refreshing;
let previous = {};
try { previous = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8')); } catch {}
// 状态里会带上一轮留下的检测结果：重启后面板不至于一片空白，但也不当成新结论。
let state = { useSystemProxy: settings.useSystemProxy === true || (process.platform === 'win32' && settings.useSystemProxy !== false), phase: 'starting', message: '正在启动', endpoint, pid: process.pid, version: '0.2.0', opencodeVersion: null, models: [], excludedModels: settings.excludedModels || [], modelResults: previous.modelResults || {}, sync: null, availableModels: [], probe: { running: false } };
// 状态写入串行化：一个慢的异步更新不能盖掉后发生的状态。
let statusWrites = Promise.resolve();
function update(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  const text = JSON.stringify(state, null, 2);
  statusWrites = statusWrites.then(() => atomicWrite(path.join(dataDir, 'status.json'), text)).catch(e => console.error('Status write failed:', e.message));
}
const logFile = path.join(dataDir, 'opencode.log');
try { if ((await fs.stat(logFile)).size > 5 * 1024 * 1024) await fs.rename(logFile, logFile + '.previous'); } catch {}
const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
// 判定缓存：新鲜的判定直接用，不重新探测（见 probe-cache.js 的过期策略）。
// 目录变化后由 prune 清理，显式点"检测全部"时整体忽略。
const probeCache = createProbeCache({
  file: path.join(dataDir, 'probe-cache.json'),
  okTtlMinutes: Number(process.env.FERRY_PROBE_TTL_MINUTES || settings.probeCacheMinutes) || undefined,
  log: message => log.write(`${new Date().toISOString()} ${message}\n`),
});
// 检测并发：串行等 11 个模型时，光两次 60 秒超时就够等两分钟。并发跑让慢模型互相重叠，
// 一轮基本只取决于最慢的那一批。上游对并发敏感，默认保守取 3。
const PROBE_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.FERRY_PROBE_CONCURRENCY || settings.probeConcurrency) || 3));
// 只有"被检测通过"且"最近一次结果 ok"的模型才对外发布。
const validated = new Set();
const usableModels = () => models
  .filter(m => validated.has(m.id) && state.modelResults[m.id]?.ok === true)
  .map(m => ({ ...m, chatOnly: state.modelResults[m.id]?.chatOnly === true }));
const publishedModels = usableModels;
// 翻译兜底要挑另一个能干活的免费模型：顺序是偏好，列表为空时退到任意可用模型。
// 检测路径永远不翻译——探测必须量到模型本身，而不是翻译的功劳。
const TRANSLATOR_ORDER = ['opencode/big-pickle', 'opencode/nemotron-3.5-lightning-free', 'opencode/space-bunny-free', 'opencode/mimo-v2.6-flash-free'];
const attachTranslator = runtime => {
  runtime.backend.translator = failed => {
    const usable = usableModels().map(model => model.id).filter(id => id !== failed);
    return TRANSLATOR_ORDER.find(id => usable.includes(id)) ?? usable[0] ?? null;
  };
  return runtime;
};
let syncWrites = Promise.resolve();
let modelsFile = process.platform === 'win32'
  ? await resolveModelsFile({ saved: settings.workBuddyModelsFile })
  : process.env.FERRY_MODELS_FILE || path.join(os.homedir(), '.workbuddy/models.json');
update({ modelsFile });

// 导入 WorkBuddy 的写操作也串行化：两次并发导入会把同一份配置写乱。
function syncPublished(published = publishedModels().filter(m => !(settings.excludedModels || []).includes(m.id))) {
  syncWrites = syncWrites.then(async () => {
    let sync;
    if (process.env.FERRY_NO_SYNC === '1') sync = { skipped: true, count: published.length };
    else {
      try {
        if (!modelsFile) throw new Error('未找到有效的 WorkBuddy 配置，请点击导入并选择 models.json；首次使用请先在 WorkBuddy 保存一个自定义模型。');
        sync = await syncModels(modelsFile, published, `${endpoint}/chat/completions`, key, { allowEmpty: true, requireExisting: process.platform === 'win32' });
      }
      catch (e) { sync = { error: e.message }; }
    }
    update({ sync: { ...sync, time: new Date().toISOString() } });
    return sync;
  });
  return syncWrites;
}
async function record(model, ok, error, status, code, durationMs, source = 'request', chatOnly = source === 'request' && state.modelResults[model]?.chatOnly === true, meta = {}) {
  if (stopping) return;
  const result = withRequestMeta({ model, ...modelResult(ok, error, status, code), durationMs, source, chatOnly }, meta);
  // 原始审批载荷留档：事后还查得出被拦下的是哪种本机动作。
  const captured = Array.isArray(meta.permissions) && meta.permissions.length ? { lastPermission: { time: result.time, entries: meta.permissions } } : {};
  // 上游自身出问题是"这一轮"的事，不是对模型的判定：
  // 记账照记，但模型继续留在可用列表里，不让一次抽风把它撤下。
  if (!ok && source === 'request' && ['invalid_model_output', 'invalid_tool_call', 'native_tool_activity', 'output_truncated'].includes(code)) {
    update({ lastRequest: result, ...captured });
    return;
  }
  if (ok) validated.add(model); else validated.delete(model);
  update({ lastRequest: result, ...(model ? { modelResults: { ...state.modelResults, [model]: result } } : {}), ...captured });
  update({ availableModels: usableModels().map(m => m.id) });
  // 判定入缓存。探测结论照收；真实调用的成功也是证据（顺手把时间戳刷新，
  // 下次启动就不会再为它跑一遍探测）。真实调用失败不动缓存——一次抽风不是对模型的判定。
  const entry = model ? models.find(m => m.id === model) : undefined;
  if (entry && source === 'probe') probeCache.record(entry, { ok, chatOnly, category: result.category, message: result.error, durationMs, at: Date.parse(result.time) });
  else if (entry && ok && source === 'request') probeCache.record(entry, { ok: true, chatOnly, category: 'available', durationMs, at: Date.parse(result.time) });
}
// 在途可见性：慢或被上游重试的一轮在请求/响应上完全没有输出，
// 所以把 OpenCode 事件流上的进展发布出去，面板才能说清"卡在哪一步"。
const activities = new Map();
let activityTimer;
function publishActivity() {
  const now = Date.now();
  update({ activity: [...activities.values()].map(a => ({
    model: a.model, sessionID: a.sessionID, status: a.status || 'waiting',
    waitedMs: now - a.startedAt, sinceEventMs: a.lastEventAt ? now - a.lastEventAt : null,
    sinceContentMs: a.lastContentAt ? now - a.lastContentAt : null, repairModel: a.repairModel,
    attempt: a.attempt, ...(a.error ? { error: a.error } : {}),
  })) });
}
function noteActivity(progress) {
  if (!progress?.sessionID) return;
  if (progress.type === 'request.done') { activities.delete(progress.sessionID); publishActivity(); return; }
  const entry = activities.get(progress.sessionID) || { sessionID: progress.sessionID, startedAt: Date.now(), status: 'waiting' };
  Object.assign(entry, progress, { model: progress.model || entry.model, lastEventAt: Date.now() });
  if (progress.content) entry.lastContentAt = Date.now();
  activities.set(progress.sessionID, entry);
  // 上游安静时，等待时间仍然要继续走。
  if (!activityTimer) {
    activityTimer = setInterval(() => { if (activities.size) publishActivity(); else { clearInterval(activityTimer); activityTimer = null; } }, 5000);
    activityTimer.unref?.();
  }
  // 关键节点（换阶段、上游重试、审批、出错）立刻写，普通进展最多每秒写一次。
  const urgent = progress.type === 'bridge.phase' || progress.status === 'retry' || progress.status === 'permission' || progress.error;
  const now = Date.now();
  if (!urgent && now - (entry.writtenAt || 0) < 1000) return;
  entry.writtenAt = now;
  publishActivity();
}
let probing = false, probeTask;
const probeAbort = new AbortController();

// 缓存里还有新鲜判定的模型直接采用：不花一次请求，也不再等它。
// 采用失败的判定同样有价值——它让"重启后又要为两个死模型各等一分钟"消失。
// 只有按能力指纹与过期时间都算新鲜的才算数（见 probe-cache.js）。
function adoptCachedModels(candidates) {
  const adopted = {};
  let count = 0;
  for (const model of candidates) {
    const verdict = probeCache.fresh(model);
    if (!verdict) continue;
    if (verdict.ok) validated.add(model.id);
    adopted[model.id] = {
      model: model.id, ok: verdict.ok === true, category: verdict.category ?? (verdict.ok ? 'available' : 'error'),
      time: new Date(verdict.at).toISOString(), source: 'cache', chatOnly: verdict.chatOnly === true,
      ...(Number.isFinite(verdict.durationMs) ? { durationMs: verdict.durationMs } : {}),
      ...(verdict.message ? { error: verdict.message } : {}),
    };
    count += 1;
  }
  if (count) {
    // 先合并出新的结果表，再拿它算可用清单。update() 是"算完 patch 才换 state"，
    // 这里如果直接调 usableModels()，读到的是上一份 modelResults：
    // "缓存判定成功、但上一轮结果失败"的模型就会被漏掉，而且再没有别的机会补上。
    const modelResults = { ...state.modelResults, ...adopted };
    update({ modelResults, availableModels: usableModelIds(models, validated, modelResults) });
  }
  return count;
}

// 探测一个模型。每个模型有自己的 60 秒预算，语义没命中（只回文本、动作不符）
// 重试一次并共用同一份预算；判定一律经 record() 落进状态与缓存。
async function probeOneModel(model) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const meta = { probe: true };
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, PROBE_TIMEOUT);
  try {
    // OpenCode 目录里明说没有工具能力的模型不必浪费一次探测。
    if (model.toolcall === false) throw new BridgeError('OpenCode catalog does not advertise tool support', 502, 'invalid_tool_call');
    await probeModel({ complete: token => runtime.backend.complete(prepare(probeBody(model, token), models), AbortSignal.any([probeAbort.signal, deadline.signal]), meta) });
    await record(model.id, true, undefined, undefined, undefined, elapsed(), 'probe', undefined, meta);
  } catch (cause) {
    const e = probeFailure(cause, timedOut);
    if (!stopping && e.code === 'no_action') {
      // 只回文本说明"能用"，不是"不能用"：按仅对话发布并关掉工具，而不是撤下它。
      await record(model.id, true, '探测时只返回文本、未产生动作；已按仅对话发布', undefined, 'chat_only', elapsed(), 'probe', true);
    } else if (!stopping && formatUnsupported(e)) {
      // 格式装不下工具调用：再用一次纯对话确认它至少能聊天，能就按仅对话发布。
      try {
        const chatModel = { ...model, chatOnly: true };
        await runtime.backend.complete(prepare({ model: model.id, messages: [{ role: 'user', content: 'Reply only OK.' }] }, [chatModel]), AbortSignal.any([probeAbort.signal, AbortSignal.timeout(30000)]));
        await record(model.id, true, '工具转换不兼容：' + e.message, undefined, 'chat_only', elapsed(), 'probe', true);
      } catch (chatError) {
        if (!stopping) await record(model.id, false, chatError.message, chatError.status, chatError.code, elapsed(), 'probe');
      }
    } else if (!stopping) await record(model.id, false, e.name === 'TimeoutError' ? 'Model probe timed out' : e.message, e.status, e.code, elapsed(), 'probe', undefined, meta);
  } finally { clearTimeout(timer); }
}

// 检测队列。force 用于"检测全部"：那是用户明确要求重新验证，缓存一律忽略。
function startProbes(modelID, reveal = false, autoImport = false, { force = false } = {}) {
  if (stopping || refreshing || configSearch) throw new Error('请等待模型读取或配置查找完成');
  if (probing) return { started: false, message: '检测正在进行' };
  const selected = modelID ? models.filter(m => m.id === modelID) : models;
  if (!selected.length) throw new Error('模型不在当前目录中');
  probing = true;
  // 先采用缓存判定，剩下的才需要真的发请求。
  const reused = force ? 0 : adoptCachedModels(selected);
  const reusable = new Set(selected.filter(model => probeCache.fresh(model)).map(model => model.id));
  const queue = selected.filter(model => force || !reusable.has(model.id));
  // 计划数要在 worker 开跑之前记下来：它们会立刻把队首领走，事后读 queue.length 会得到 0。
  const planned = queue.length;
  const pending = queue.map(model => model.id);
  const active = new Set();
  const publishProbe = () => update({ probe: { running: true, current: [...active][0] ?? null, active: [...active], pending: [...pending] } });
  probeTask = (async () => {
    try {
      if (reveal) {
        // 幂等：单模型重测时它已经在清单里，不应该再插一行。
        const known = new Set(state.models.map(model => model.id));
        const added = selected.filter(model => !known.has(model.id));
        if (added.length) update({ models: [...state.models, ...added] });
      }
      publishProbe();
      // 并发工作池：每个 worker 领一个模型跑完再领下一个。上游对并发敏感，
      // 所以并发度保守（默认 3），并且慢模型不再挡住快模型出结果。
      const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
        while (queue.length && !stopping) {
          const model = queue.shift();
          active.add(model.id);
          publishProbe();
          try { await probeOneModel(model); }
          finally {
            active.delete(model.id);
            pending.splice(pending.indexOf(model.id), 1);
            publishProbe();
          }
        }
      });
      await Promise.all(workers);
      // 目录里已经没有的模型，判定留着只会让缓存越来越大。
      probeCache.prune(models);
      // 首次启动的整轮检测跑完就自动导入一次：这是"打开就能用"的那一步。
      if (autoImport && !stopping) {
        if (process.platform === 'win32' && !modelsFile && process.env.FERRY_NO_SYNC !== '1') {
          const found = await findConfig(true);
          if (found.candidates.length) {
            await validateModelsFile(found.candidates[0]);
            settings = { ...settings, workBuddyModelsFile: found.candidates[0] };
            await atomicWrite(settingsFile, JSON.stringify(settings));
            modelsFile = found.candidates[0]; update({ modelsFile });
          }
        }
        await syncPublished();
      }
      log.write(`${new Date().toISOString()} 检测轮结束：判定缓存命中 ${reused} 个，实际探测 ${planned} 个\n`);
    } finally { probing = false; update({ probe: { running: false, current: null, active: [], pending: [] } }); }
  })().catch(e => console.error('Model detection failed:', e.message));
  return { started: true, reused, probing: planned };
}

function watchRuntime(current) {
  update({ opencodeVersion: current.version });
  current.child.on('exit', () => {
    // 隔离服务死掉之后所有转发都会失败，与其让 WorkBuddy 一个个超时，不如当场收摊。
    if (!stopping && runtime === current) {
      update({ phase: 'error', message: 'OpenCode 服务退出，请重启代理' });
      shutdown(1);
    }
  });
}

// 重新读取模型目录。restartRuntime 用于切换代理：OpenCode 的启动环境是固定的，
// 代理变了只能换一个进程，而新进程就绪之前旧进程继续服务。
async function refresh(restartRuntime = false, useSystemProxy = state.useSystemProxy) {
  if (refreshing) return refreshing;
  if (probing || stopping || configSearch) throw new Error('请等待检测或配置查找完成');
  const proxyEnv = await systemProxyEnvironment(useSystemProxy);
  validated.clear();
  models = [];
  update({ phase: 'reading', message: '正在读取免费模型…', models: [], availableModels: [] });
  refreshing = (async () => {
    if (restartRuntime) {
      const next = attachTranslator(await startBackend(binary, dataDir, log, proxyEnv));
      if (stopping) { await next.stop(); return; }
      const old = runtime;
      runtime = next;
      watchRuntime(next);
      await old?.stop();
      update({ useSystemProxy });
    }
    const discovered = await runtime.backend.models();
    if (stopping) return;
    models = discovered;
    update({ phase: 'ready', message: `运行中 · ${models.length} 个免费模型` });
    return { count: models.length };
  })();
  try { return await refreshing; }
  catch (e) { if (!stopping) update({ phase: 'error', message: `读取失败：${e.message}` }); throw e; }
  finally { refreshing = null; }
}

// "读取免费模型"= 重读目录 + 补齐缺失的判定；缓存里新鲜的沿用，不重复花请求。
// 要强制重新验证应该点"检测全部"（force）。
async function readModels() {
  const result = await refresh(true);
  if (!stopping) startProbes(undefined, true);
  return result;
}
async function setSystemProxy(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('代理开关必须是布尔值');
  if (refreshing || probing || stopping || configSearch) throw new Error('请等待读取和检测完成');
  await refresh(true, enabled);
  if (stopping) return;
  settings = { ...settings, useSystemProxy: enabled };
  await atomicWrite(settingsFile, JSON.stringify(settings));
  startProbes(undefined, true);
  return { useSystemProxy: enabled };
}
let configSearch;
async function findConfig(afterProbe = false) {
  if (process.platform !== 'win32') throw new Error('自动查找仅用于 Windows');
  if (stopping || refreshing || !runtime || (probing && !afterProbe)) throw new Error('请等待服务就绪');
  if (configSearch) return configSearch;
  configSearch = (async () => {
    update({ configSearch: { running: true }, message: 'OpenCode 正在只读查找 WorkBuddy 配置…' });
    try {
      const result = await searchConfig(runtime.backend, usableModels(), await windowsSearchRoots(os.homedir()), probeAbort.signal);
      if (!stopping) update({ configSearch: { running: false, ...result }, message: '运行中' });
      return result;
    } catch (error) {
      if (!stopping) update({ configSearch: { running: false, candidates: [], errors: [error.message] } });
      throw error;
    }
  })();
  try { return await configSearch; } finally { configSearch = null; }
}

async function selectModel(model, selected) {
  if (stopping || probing || refreshing || configSearch || state.phase !== 'ready') throw new Error('请等待检测完成后选择模型');
  if (typeof selected !== 'boolean' || !models.some(m => m.id === model)) throw new Error('无效的模型选择');
  const excluded = new Set(settings.excludedModels || []);
  if (selected) excluded.delete(model); else excluded.add(model);
  const next = { ...settings, excludedModels: [...excluded] };
  await atomicWrite(settingsFile, JSON.stringify(next));
  settings = next; update({ excludedModels: next.excludedModels });
  return { excludedModels: next.excludedModels };
}

async function importModels(selectedFile) {
  if (stopping || probing || refreshing || configSearch || state.phase !== 'ready') throw new Error('请等待读取和检测完成后导入');
  if (selectedFile !== undefined) {
    await validateModelsFile(selectedFile);
    // 换配置文件之前，先从旧文件里摘掉自己的条目——不然它们会永远留在那儿没人认领。
    if (modelsFile && modelsFile !== selectedFile && await fs.stat(modelsFile).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
      const cleanup = await syncPublished([]);
      if (cleanup.error) throw new Error(cleanup.error);
    }
    const nextSettings = { ...settings, workBuddyModelsFile: selectedFile };
    await atomicWrite(settingsFile, JSON.stringify(nextSettings));
    settings = nextSettings; modelsFile = selectedFile; update({ modelsFile });
  }
  const sync = await syncPublished();
  if (sync.error) throw new Error(sync.error);
  return sync;
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  probeAbort.abort();
  server?.abortAll?.(); server?.closeAllConnections();
  server?.removeAllListeners('request');
  // 收摊期间进来的请求直接 503，而不是挂在半死的服务上。
  server?.on('request', (_req, res) => { res.writeHead(503); res.end(); });
  // 退出前把自己的模型条目从 WorkBuddy 配置里摘掉，再结束 OpenCode。
  await syncPublished([]);
  await runtime?.stop();
  await refreshing?.catch(() => {});
  await probeTask;
  if (code === 0) update({ phase: 'stopped', message: '已停止' });
  await syncWrites;
  await probeCache.flush();
  await statusWrites;
  log.end(); await fs.unlink(lockFile).catch(() => {});
  server?.close();
  process.exit(code);
}
// 被 Electron 强杀时也要有机会收摊：IPC 断开与会话结束都当作退出信号。
process.on('message', message => { if (message === 'shutdown') shutdown(); });
process.on('disconnect', () => shutdown());
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
process.on('uncaughtException', e => { update({ phase: 'error', message: e.message }); shutdown(1); });
process.on('unhandledRejection', e => { update({ phase: 'error', message: String(e?.message || e) }); shutdown(1); });
try {
  update({ phase: 'starting' });
  const cached = await probeCache.load();
  // 冷启动（缓存里一条新鲜判定都没有）先清一次：上一次异常退出可能把自己的条目留在了配置里。
  // 热启动跳过这一步——下面用到缓存判定之后会立刻把同一份清单写回去，先清后写只会平白多两次备份。
  if (!cached) await syncPublished([]);
  let startupProxyEnv;
  try { startupProxyEnv = await systemProxyEnvironment(state.useSystemProxy); }
  catch (error) {
    // 全新安装默认跟随系统代理，但一台根本没配手动代理的机器也必须能下载。
    // 明确保存过"开"的用户例外：那是用户的选择，出错就该报出来。
    if (settings.useSystemProxy === true) throw error;
    startupProxyEnv = await systemProxyEnvironment(false);
    update({ useSystemProxy: false });
    log.write(`${new Date().toISOString()} 未检测到可用的系统代理，首次下载改为直连：${error.message}\n`);
  }
  binary = await findRuntime(dataDir, message => update({ message }), {
    proxyEnv: startupProxyEnv,
    onProxyFallback: async () => {
      // 自动探测出来的代理坏掉了：把开关也落成"关"，让 OpenCode 之后的出站别再用它。
      if (settings.useSystemProxy !== true) {
        startupProxyEnv = await systemProxyEnvironment(false);
        update({ useSystemProxy: false });
      }
    },
    log: message => log.write(`${new Date().toISOString()} ${message}\n`),
  });
  server = createServer({ server, key, selectModel, backend: { complete: (...args) => runtime.backend.complete(...args) }, getModels: publishedModels, refresh: readModels, importModels, findConfig, setSystemProxy,
    status: () => state, probe: startProbes, onResult: record, onActivity: noteActivity });
  update({ message: '正在启动隔离模型服务' });
  runtime = attachTranslator(await startBackend(binary, dataDir, log, startupProxyEnv));
  watchRuntime(runtime);
  // 确认运行的是本产品要的专用 agent，而不是用户自己的构建 agent。
  const agents = await runtime.backend.request('/agent');
  if (!agents.some(a => a.name === 'oc-ferry')) throw new Error('Dedicated approval-gated agent missing');
  await refresh();
  const round = startProbes(undefined, true, true);
  // 采用缓存判定之后立刻同步一次：热启动时模型几秒内就回到 WorkBuddy 里，
  // 不必等这一轮真正要探测的那几个跑完（轮末还会再同步一次）。
  if (!stopping && round?.reused) await syncPublished();
  console.log(`OC Ferry ready at ${endpoint}; ${models.length} free models; probe cache hit ${round?.reused ?? 0}, probing ${round?.probing ?? 0}`);
} catch (e) { update({ phase: 'error', message: e.message }); if (!runtime) await shutdown(1); }
