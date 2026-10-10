import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';

const KEY = 'test-key-123';
const MODELS = [{ id: 'opencode/big-pickle', name: 'Big Pickle', images: true, reasoning: true, variants: {}, toolcall: true }];
const readTool = { type: 'function', function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } };

async function withServer(run, overrides = {}) {
  const state = { phase: 'ready', message: '运行中', useSystemProxy: false };
  const calls = [];
  const options = {
    key: KEY,
    selectModel: async (model, selected) => ({ excludedModels: selected ? [] : [model] }),
    backend: { complete: async (request, signal, meta) => { calls.push({ request, meta }); return { id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: request.model.id, choices: [{ index: 0, message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }; } },
    getModels: () => MODELS,
    refresh: async () => ({ count: MODELS.length }),
    importModels: async file => ({ changed: true, count: 2, ...(file ? { file } : {}) }),
    findConfig: async () => { throw new Error('自动查找仅用于 Windows'); },
    setSystemProxy: async enabled => ({ useSystemProxy: enabled }),
    probe: () => ({ started: true }),
    status: () => state,
    onResult: async (...args) => { calls.push({ result: args }); },
    onActivity: () => {},
    ...overrides,
  };
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (route, { method = 'GET', body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  try { return await run({ call, calls, state, server }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('鉴权与来源围栏：无密钥 401、带 Origin 403、健康检查需要密钥', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/health')).status, 401);
    assert.equal((await call('/v1/models', { headers: { Authorization: 'Bearer wrong-key' } })).status, 401);
    const origin = await call('/v1/models', { headers: { Authorization: `Bearer ${KEY}`, Origin: 'http://evil.test' } });
    assert.equal(origin.status, 403);
    assert.match(origin.text, /Browser-origin requests are disabled/);
    assert.equal((await call('/v1/models', { headers: { Authorization: `Bearer ${KEY}` } })).status, 200);
  });
});

test('/v1/models 只列可发布模型，用客户端可见 id 命名', async () => {
  await withServer(async ({ call }) => {
    const response = await call('/v1/models', { headers: { Authorization: `Bearer ${KEY}` } });
    const data = JSON.parse(response.text);
    assert.equal(data.object, 'list');
    assert.deepEqual(data.data.map(m => m.id), ['OC · Big Pickle']);
    assert.equal(data.data[0].owned_by, 'opencode');
  });
});

test('管理接口：选择、导入、刷新、探测、代理开关各自转给核心', async () => {
  await withServer(async ({ call, calls }) => {
    const auth = { Authorization: `Bearer ${KEY}` };
    assert.deepEqual(JSON.parse((await call('/admin/selection', { method: 'POST', body: { model: 'opencode/big-pickle', selected: false }, headers: auth })).text), { excludedModels: ['opencode/big-pickle'] });
    assert.deepEqual(JSON.parse((await call('/admin/import', { method: 'POST', body: { modelsFile: '/tmp/models.json' }, headers: auth })).text), { changed: true, count: 2, file: '/tmp/models.json' });
    assert.deepEqual(JSON.parse((await call('/admin/refresh', { method: 'POST', body: {}, headers: auth })).text), { count: 1 });
    assert.equal((await call('/admin/probe', { method: 'POST', body: { model: 'opencode/big-pickle' }, headers: auth })).status, 202);
    assert.deepEqual(JSON.parse((await call('/admin/system-proxy', { method: 'POST', body: { enabled: true }, headers: auth })).text), { useSystemProxy: true });
    assert.equal((await call('/admin/find-config', { method: 'POST', body: {}, headers: auth })).status, 502);
    assert.equal((await call('/nope', { headers: auth })).status, 404);
    assert.equal((await call('/v1/chat/completions', { method: 'GET', headers: auth })).status, 404);
  });
});

test('转发：非流式返回 OpenAI 形状，并把这次调用记进结果', async () => {
  await withServer(async ({ call, calls }) => {
    const response = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` },
      body: { model: 'OC · Big Pickle', messages: [{ role: 'user', content: '你好' }], tools: [readTool] } });
    assert.equal(response.status, 200);
    const data = JSON.parse(response.text);
    assert.equal(data.choices[0].message.content, '答案');
    assert.equal(data.model, 'OC · Big Pickle');
    // 记账用的是上游 id 和客户端 id 各一：request.meta.model 是上游 id。
    const recorded = calls.find(c => c.result);
    assert.equal(recorded.result[0], 'opencode/big-pickle');
    assert.equal(recorded.result[1], true);
    assert.equal(recorded.result[6], 'request');
  });
});

test('转发：请求不合法时不进模型，按错误码回 4xx', async () => {
  await withServer(async ({ call, calls }) => {
    const auth = { Authorization: `Bearer ${KEY}` };
    const bad = await call('/v1/chat/completions', { method: 'POST', headers: auth, body: { model: 'OC · Big Pickle' } });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.text).error.code, 'invalid_request');
    const missing = await call('/v1/chat/completions', { method: 'POST', headers: auth, body: { model: 'nope', messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(JSON.parse(missing.text).error.code, 'model_not_found');
    assert.ok(!calls.some(c => c.result), '校验失败不该记账');
  });
});

test('转发：流式先用心跳占住连接，再发分片与 [DONE]', async () => {
  await withServer(async ({ call }) => {
    const response = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` },
      body: { model: 'OC · Big Pickle', stream: true, messages: [{ role: 'user', content: '你好' }] } });
    assert.equal(response.headers['content-type'], 'text/event-stream');
    assert.match(response.text, /^: validating model response before emission/);
    assert.match(response.text, /"delta":\{"role":"assistant"\}/);
    assert.match(response.text, /"delta":\{"content":"答案"\}/);
    assert.match(response.text, /"finish_reason":"stop"/);
    assert.match(response.text, /data: \[DONE\]/);
  });
});

test('转发：上游报错按错误码回给客户端，并记成失败', async () => {
  const failing = { backend: { complete: async () => { const error = new Error('模型交的调用参数不是合法 JSON'); error.code = 'invalid_model_output'; error.status = 502; throw error; } } };
  await withServer(async ({ call, calls }) => {
    const response = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` },
      body: { model: 'OC · Big Pickle', messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(response.status, 502);
    const error = JSON.parse(response.text).error;
    assert.equal(error.code, 'invalid_model_output');
    const recorded = calls.find(c => c.result);
    assert.equal(recorded.result[1], false);
    assert.equal(recorded.result[4], 'invalid_model_output');
  }, failing);
});

test('请求体超过 8 MB 直接拒绝', async () => {
  await withServer(async ({ call }) => {
    const response = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` },
      raw: JSON.stringify({ model: 'OC · Big Pickle', messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }] }) });
    assert.equal(response.status, 413);
  });
});
