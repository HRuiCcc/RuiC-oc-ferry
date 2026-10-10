import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { clientModelID } from './model-status.js';
import { prepare, sendSSE, BridgeError } from './protocol.js';

// 本地转发口只服务于本机的原生客户端：Bearer 口令用定时安全比较，
// 浏览器来源一律拒绝（同源脚本没有理由访问推理接口）。
function authorized(req, key) {
  const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new BridgeError('Request exceeds 8 MB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new BridgeError('Invalid JSON'); }
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

export function createServer({ server = http.createServer(), key, selectModel, backend, getModels, refresh, importModels, findConfig, setSystemProxy, probe, status, onResult = () => {}, onActivity }) {
  const active = new Set();
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    if (!authorized(req, key)) return json(res, 401, { error: { message: 'Local proxy API key required', type: 'authentication_error' } });
    // 任何浏览器来源都不放行：WorkBuddy 通过它的原生运行时访问本服务。
    if (req.headers.origin) return json(res, 403, { error: { message: 'Browser-origin requests are disabled' } });
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    const controller = new AbortController(); active.add(controller);
    // 客户端断开要当成取消：继续跑下去只会浪费上游额度，还会把半途的结果当成完成。
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let heartbeat, model, started, streamStart, attempted = false, meta = {};
    try {
      if (req.method === 'GET' && route === '/health') return json(res, 200, status());
      if (req.method === 'GET' && route === '/v1/models') return json(res, 200, { object: 'list', data: getModels().map(m => ({ id: clientModelID(m), object: 'model', owned_by: 'opencode', name: clientModelID(m) })) });
      if (req.method === 'POST' && route === '/admin/probe') {
        // 面板上的探测是用户明确要求重新验证的动作，所以忽略判定缓存（force）。
        const body = await readBody(req);
        return json(res, 202, probe(body.model, true, false, { force: true }));
      }
      if (req.method === 'POST' && route === '/admin/system-proxy') return json(res, 200, await setSystemProxy((await readBody(req)).enabled));
      if (req.method === 'POST' && route === '/admin/find-config') return json(res, 200, await findConfig());
      if (req.method === 'POST' && route === '/admin/selection') {
        const body = await readBody(req);
        return json(res, 200, await selectModel(body.model, body.selected));
      }
      if (req.method === 'POST' && route === '/admin/import') return json(res, 200, await importModels((await readBody(req)).modelsFile));
      if (req.method === 'POST' && route === '/admin/refresh') return json(res, 200, await refresh());
      if (req.method !== 'POST' || route !== '/v1/chat/completions') return json(res, 404, { error: { message: 'Not found' } });
      if (active.size > 4) throw new BridgeError('At most four requests may run at once', 429, 'busy');
      const body = await readBody(req);
      model = body.model;
      const request = prepare(body, getModels());
      // 请求校验通过后，模型用的是上游 id（而不是客户端可见 id），下游全部按它记账。
      model = request.model.id;
      meta = { tools: request.tools.length, model: request.model.id, ...(onActivity ? { activity: onActivity } : {}) };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        // 先写一条注释行：客户端由此知道连接已经建立，而信封还在校验。
        res.write(': validating model response before emission\n\n');
        heartbeat = setInterval(() => res.write(': waiting\n\n'), 10000);
        // 上游真的开始出内容时就把 role 分片发出去，客户端不用等到整段回答完成才看到"开始了"。
        meta.activity = progress => {
          if (progress.content === true && !streamStart && !controller.signal.aborted && !res.destroyed && !res.writableEnded) {
            streamStart = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000) };
            res.write(`data: ${JSON.stringify({ ...streamStart, object: 'chat.completion.chunk', model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
          }
          onActivity?.(progress);
        };
      }
      attempted = true;
      started = performance.now();
      const result = await backend.complete(request, controller.signal, meta);
      // 被客户端取消的请求绝不能记成一次成功的调用。
      if (controller.signal.aborted) return;
      await onResult(model, true, undefined, undefined, undefined, Math.round(performance.now() - started), 'request', undefined, meta);
      result.model = body.model;
      if (body.stream) {
        if (streamStart) Object.assign(result, streamStart);
        sendSSE(res, result, body.stream_options?.include_usage, !!streamStart);
      }
      else json(res, 200, result);
    } catch (e) {
      if (controller.signal.aborted) return;
      const message = e.name === 'TimeoutError' ? 'Model request timed out' : e.message;
      if (attempted) await onResult(model || null, false, message, e.status, e.code, Math.round(performance.now() - started), 'request', undefined, meta);
      const error = { message, type: e.code || 'upstream_error', code: e.code || 'upstream_error' };
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error })}\n\n`);
      else json(res, e.status || 502, { error });
    } finally { clearInterval(heartbeat); active.delete(controller); }
  });
  // 请求头 15 秒、整请求 20 秒：管理接口都是本地快操作，慢的只有推理，
  // 而推理那条路自己持有取消信号，不靠这个超时。
  server.requestTimeout = 20000; server.headersTimeout = 15000;
  server.abortAll = () => { for (const c of active) c.abort(); };
  return server;
}
