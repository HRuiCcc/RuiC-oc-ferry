import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeBody, judgeProbe, probeModel, probeFailure, formatUnsupported, PROBE_TIMEOUT, PROBE_TOOLS, RETRYABLE_PROBE } from '../src/probe.js';
import { extractJson, clientConventions, repairBody, resendPrompt, repair } from '../src/repair.js';

const MODEL = { id: 'opencode/big-pickle', name: 'Big Pickle' };
const response = calls => ({ choices: [{ message: { role: 'assistant', content: null, ...(calls ? { tool_calls: calls } : {}) } }] });
const call = (name, args) => ({ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('探测请求用多个工具 + 自由选择，并写进目标文件名', () => {
  const body = probeBody(MODEL, 'tok123');
  assert.equal(body.model, 'opencode/big-pickle');
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.tools.map(t => t.function.name), ['Read', 'Write', 'Bash', 'Glob', 'WebSearch']);
  assert.match(body.messages[0].content, /probe-tok123\.txt/);
  assert.equal(PROBE_TIMEOUT, 60000);
  // 每个探测都要带自己的工具副本：探测之间不能互相看见彼此的改动。
  assert.notEqual(probeBody(MODEL, 'a').tools, PROBE_TOOLS);
});

test('判定：只回文本算失败，动作不符算语义没命中并带上证据', () => {
  assert.throws(() => judgeProbe(response(null), 'tok'), error => error.code === 'no_action');
  assert.throws(() => judgeProbe(response([]), 'tok'), error => error.code === 'no_action');
  assert.throws(() => judgeProbe(response([call('Write', { file_path: '/x', content: 'y' })]), 'tok'),
    error => error.code === 'probe_mismatch' && /Write/.test(error.message));
  assert.throws(() => judgeProbe(response([call('Read', { file_path: '/other.txt' })]), 'tok'),
    error => error.code === 'probe_mismatch');
  assert.throws(() => judgeProbe(response([call('Read', { file_path: '/external/probe-tok.txt' }), call('Read', { file_path: '/external/probe-tok.txt' })]), 'tok'),
    error => error.code === 'probe_mismatch');
  const ok = judgeProbe(response([call('Read', { file_path: '/external/probe-tok.txt' })]), 'tok');
  assert.equal(ok.function.name, 'Read');
});

test('只有语义没命中才重试一次，格式失败与超时不重试', async () => {
  let attempts = 0;
  const flaky = await probeModel({ complete: token => { attempts += 1; return attempts === 1 ? response([call('Write', { file_path: 'x' })]) : response([call('Read', { file_path: `/external/probe-${token}.txt` })]); } });
  assert.equal(attempts, 2);
  assert.equal(flaky.choices[0].message.tool_calls[0].function.name, 'Read');

  attempts = 0;
  await assert.rejects(probeModel({ complete: () => { attempts += 1; return response(null); } }), error => error.code === 'no_action');
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(probeModel({ complete: () => { attempts += 1; const error = new Error('boom'); error.code = 'invalid_model_output'; throw error; } }), /boom/);
  assert.equal(attempts, 1);
});

test('只有格式不兼容才降级成仅对话', () => {
  assert.equal(formatUnsupported({ code: 'invalid_model_output' }), true);
  assert.equal(formatUnsupported({ code: 'invalid_tool_call' }), true);
  assert.equal(formatUnsupported({ message: 'Only auto mode is supported for tool_choice' }), true);
  assert.equal(formatUnsupported({ code: 'no_action' }), false);
  assert.equal(formatUnsupported({ code: 'timeout' }), false);
  assert.equal(formatUnsupported({ code: 'probe_mismatch' }), false);
  assert.deepEqual([...RETRYABLE_PROBE].sort(), ['no_action', 'probe_mismatch']);
});

test('超时被翻译成明确的原因，其他错误原样透传', () => {
  const timeout = probeFailure(new Error('The operation was aborted'), true);
  assert.equal(timeout.code, 'timeout');
  assert.equal(timeout.name, 'TimeoutError');
  assert.match(timeout.message, /Model probe timed out/);
  const original = new Error('upstream 500');
  assert.equal(probeFailure(original, false), original);
});

test('从散文或围栏里取出第一个配平的 JSON 对象', () => {
  assert.deepEqual(extractJson('这是结果：{"a":1} 完'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"calls":[{"name":"Read","arguments":{"x":"}"}}]}\n```'), { calls: [{ name: 'Read', arguments: { x: '}' } }] });
  assert.equal(extractJson('没有对象'), null);
  assert.equal(extractJson('{"broken":'), null);
  assert.deepEqual(extractJson('{}'), {});
});

test('兜底材料：对话、工具表、约定一起给出，长正文不截断', () => {
  const long = 'x'.repeat(50000);
  const tool = { type: 'function', function: { name: 'Write', description: '写文件', parameters: { type: 'object', properties: { file_path: {}, content: {} }, required: ['file_path', 'content'] } } };
  assert.match(clientConventions([tool]), /^write: Preserve the complete supplied file content/);
  const body = JSON.parse(repairBody({ shape: 'envelope', tools: [tool], material: { content: long }, blocked: { native: 'write' } }));
  assert.equal(body.shape, 'envelope');
  assert.equal(body.tools[0].name, 'Write');
  assert.equal(body.material.content.length, 50000);
  assert.equal(body.blocked.native, 'write');
});

test('兜底流程：成功记录模型，unrepairable 与接收方拒绝都只留痕不抛错', async () => {
  const request = { model: { id: 'opencode/step-5-preview-free' }, tools: [], choice: 'none', text: '[]' };
  const meta = {};
  const validate = value => {
    if (value.bad) { const error = new Error('rejected'); error.code = 'invalid_tool_call'; throw error; }
    return value;
  };
  const ok = await repair({ complete: () => ({ choices: [{ message: { content: '```json\n{"content":"hi","calls":[]}\n```' } }] }), translator: () => 'opencode/big-pickle', request, shape: 'envelope', material: {}, validate, meta });
  assert.deepEqual(ok, { content: 'hi', calls: [] });
  assert.equal(meta.repaired.envelope.ok, true);
  assert.equal(meta.repaired.envelope.model, 'opencode/big-pickle');

  const declined = await repair({ complete: () => ({ choices: [{ message: { content: '{"unrepairable":true,"reason":"缺少文件正文"}' } }] }), translator: () => 'm', request, shape: 'action', material: {}, validate, meta: {} });
  assert.equal(declined, null);

  const rejected = await repair({ complete: () => ({ choices: [{ message: { content: '{"bad":1}' } }] }), translator: () => 'm', request, shape: 'envelope', material: {}, validate, meta: {} });
  assert.equal(rejected, null);

  const unavailable = await repair({ complete: () => { throw new Error('boom'); }, translator: () => 'm', request, shape: 'envelope', material: {}, validate, meta: {} });
  assert.equal(unavailable, null);

  const noTranslator = await repair({ complete: () => ({}), translator: () => null, request, shape: 'envelope', material: {}, validate, meta: {} });
  assert.equal(noTranslator, null);
});

test('重发提示把失败原因交给模型，并禁止它假装执行', () => {
  const text = resendPrompt({ error: { code: 'output_truncated', message: 'Model output was truncated' }, blocked: { native: 'write' } });
  assert.match(text, /被截断/);
  assert.match(text, /不要调用 OpenCode 本地工具/);
  assert.match(text, /output_truncated|Model output was truncated/);
});
