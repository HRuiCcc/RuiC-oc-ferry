import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, decode, completion, sendSSE, BridgeError } from '../src/protocol.js';

const model = (extra = {}) => ({ id: 'opencode/big-pickle', name: 'Big Pickle', images: false, toolcall: true, reasoning: true, variants: {}, ...extra });
const readTool = { type: 'function', function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } };
const ask = (patch = {}) => ({ model: 'OC · Big Pickle', messages: [{ role: 'user', content: 'hi' }], ...patch });

test('请求校验：消息、模型、n、角色、工具、tool_choice 各有明确错误', () => {
  assert.throws(() => prepare({}, [model()]), /messages must be a nonempty array/);
  assert.throws(() => prepare(ask({ model: 'nope' }), [model()]), /Select an available free model/);
  assert.throws(() => prepare(ask({ n: 2 }), [model()]), /Only n=1 is supported/);
  assert.throws(() => prepare(ask({ messages: [{ role: 'robot', content: 'x' }] }), [model()]), /Unknown message role/);
  assert.throws(() => prepare(ask({ tools: [{ type: 'web_search' }] }), [model()]), /Only function tools are supported/);
  assert.throws(() => prepare(ask({ tools: [readTool, readTool] }), [model()]), /Duplicate tool names/);
  assert.throws(() => prepare(ask({ tool_choice: 'sometimes' }), [model()]), /Invalid tool_choice/);
  assert.throws(() => prepare(ask({ tool_choice: { type: 'function', function: { name: 'Write' } }, tools: [readTool] }), [model()]), /Requested tool is unavailable/);
  assert.throws(() => prepare(ask({ tool_choice: 'required' }), [model()]), /Requested tool is unavailable/);
});

test('模型可以用上游 id 或客户端可见 id 指定', () => {
  assert.equal(prepare(ask(), [model()]).model.id, 'opencode/big-pickle');
  assert.equal(prepare(ask({ model: 'opencode/big-pickle' }), [model()]).model.id, 'opencode/big-pickle');
  // 两个模型映射到同一个可见 id 时按未找到处理，绝不猜。
  assert.throws(() => prepare(ask(), [model(), model({ id: 'opencode/other', name: 'Big Pickle' })]), /Select an available free model/);
});

test('推理档位：可映射就用 variant，不认识的档位报 400，无 variants 的模型宽容放行', () => {
  const withVariants = model({ variants: { fast: { reasoningEffort: 'low' } } });
  assert.equal(prepare(ask({ reasoning_effort: 'low' }), [withVariants]).variant, 'fast');
  assert.throws(() => prepare(ask({ reasoning_effort: 'high' }), [withVariants]), /Requested reasoning effort is not available/);
  // WorkBuddy 对"支持推理但没有档位"的模型也会带上默认档位：照收，走默认模式。
  assert.equal(prepare(ask({ reasoning_effort: 'high' }), [model()]).variant, undefined);
  // 模型明确不支持推理时，带档位属于请求错了，不是可以宽容的情形。
  assert.throws(() => prepare(ask({ reasoning: { effort: 'medium' } }), [model({ reasoning: false })]), /Requested reasoning effort is not available/);
});

test('图片只收内联 data URL，模型未声明图片能力时拒绝', () => {
  const png = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
  const request = prepare(ask({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: png } }] }] }), [model({ images: true })]);
  assert.equal(request.images.length, 1);
  assert.equal(request.images[0].filename, 'message-1-image-2.png');
  assert.match(JSON.parse(request.text)[0].content, /\[Attached image: message-1-image-2\.png\]/);
  assert.match(request.system, /Images are attached separately/);

  assert.throws(() => prepare(ask({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: png } }] }] }), [model({ images: false })]), /does not declare image input/);
  assert.throws(() => prepare(ask({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }), [model({ images: true })]), /base64 data URLs/);
  assert.throws(() => prepare(ask({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,!!!!' } }] }] }), [model({ images: true })]), /base64 data URLs/);
  assert.throws(() => prepare(ask({ messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }] }), [model({ images: true })]), /Unsupported message content type/);
});

test('仅对话模型：带工具直接拒绝，系统提示换成纯文本版', () => {
  assert.throws(() => prepare(ask({ tools: [readTool] }), [model({ chatOnly: true })]), /仅支持普通对话/);
  const request = prepare(ask(), [model({ chatOnly: true })]);
  assert.equal(request.chatOnly, true);
  assert.equal(request.choice, 'none');
  assert.match(request.system, /You have no tools/);
});

test('系统提示带上外部工具表与 tool_choice 的约束', () => {
  const request = prepare(ask({ tools: [readTool], tool_choice: 'none' }), [model()]);
  assert.match(request.system, /calls MUST be empty\./);
  assert.equal(request.tools.length, 1);

  const forced = prepare(ask({ tools: [readTool], tool_choice: { type: 'function', function: { name: 'Read' } } }), [model()]);
  assert.match(forced.system, /Call ONLY "Read" at least once\./);
  assert.equal(forced.forced, 'Read');

  const noParallel = prepare(ask({ tools: [readTool], parallel_tool_calls: false }), [model()]);
  assert.match(noParallel.system, /Return at most one tool call\./);
  assert.equal(noParallel.parallel, false);
});

test('解码：容忍三种等价表达，但拒绝含糊与伪造的调用', () => {
  const request = prepare(ask({ tools: [readTool] }), [model()]);
  // 1) content 为 null 的纯调用
  const a = decode('{"content":null,"calls":[{"name":"Read","arguments":{"file_path":"/a"}}]}', request);
  assert.equal(a.content, null);
  assert.equal(a.tool_calls[0].function.name, 'Read');
  assert.equal(a.tool_calls[0].function.arguments, '{"file_path":"/a"}');
  // 2) OpenAI 风格的 tool_calls 字段
  const b = decode('{"content":"","tool_calls":[{"type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"/b\\"}"}}]}', request);
  assert.equal(b.tool_calls[0].function.name, 'Read');
  // 3) calls 被二次 JSON 编码
  const c = decode('{"content":"ok","calls":"[{\\"name\\":\\"Read\\",\\"arguments\\":{\\"file_path\\":\\"/c\\"}}]"}', request);
  assert.equal(c.tool_calls[0].function.name, 'Read');
  // 4) 代码围栏
  const d = decode('```json\n{"content":"hi","calls":[]}\n```', request);
  assert.equal(d.content, 'hi');
  // 两个字段同时出现 → 含糊
  assert.throws(() => decode('{"content":"x","calls":[],"tool_calls":[]}', request), /Ambiguous tool call fields/);
  // 把调用摊平到信封上 → 不能当成纯文本收下
  assert.throws(() => decode('{"name":"Read","arguments":{}}', request), /Invalid model response envelope/);
  // 参数不是合法 JSON
  assert.throws(() => decode('{"content":"","calls":[{"name":"Read","arguments":"{oops"}]}', request), /not valid JSON/);
});

test('解码：按 tool_choice 复核调用数，并落实消息里的 id', () => {
  const required = prepare(ask({ tools: [readTool], tool_choice: 'required' }), [model()]);
  assert.throws(() => decode('{"content":"不用工具了","calls":[]}', required), /Model omitted required tool/);

  const none = prepare(ask({ tool_choice: 'none' }), [model()]);
  assert.throws(() => decode('{"content":"","calls":[{"name":"Read","arguments":{}}]}', none), /Model violated tool_choice:none/);

  const serial = prepare(ask({ tools: [readTool], parallel_tool_calls: false }), [model()]);
  assert.throws(() => decode('{"content":"","calls":[{"name":"Read","arguments":{"file_path":"/a"}},{"name":"Read","arguments":{"file_path":"/b"}}]}', serial), /multiple tools when disabled/);

  const request = prepare(ask({ tools: [readTool] }), [model()]);
  assert.throws(() => decode('{"content":"","calls":[{"name":"Bash","arguments":{"command":"ls"}}]}', request), /Invalid or unlisted tool call/);
  const message = decode('{"content":"","calls":[{"name":"Read","arguments":{"file_path":"/a"}}]}', request);
  assert.match(message.tool_calls[0].id, /^call_[0-9a-f]{32}$/);
});

test('usage 换算成 OpenAI 口径：缓存与思考都算进总量', () => {
  const result = completion('OC · Big Pickle', { role: 'assistant', content: 'hi' }, { input: 100, output: 20, reasoning: 7, cache: { read: 30, write: 5 } });
  assert.equal(result.usage.prompt_tokens, 135);
  assert.equal(result.usage.completion_tokens, 27);
  assert.equal(result.usage.total_tokens, 162);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 30);
  assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(result.choices[0].finish_reason, 'stop');
  // 上游没给用量时不编造 usage 字段
  assert.equal(completion('m', { role: 'assistant', content: 'x' }, undefined).usage, undefined);
  // 有工具调用时 finish_reason 是 tool_calls
  assert.equal(completion('m', { role: 'assistant', content: null, tool_calls: [{}] }, undefined).choices[0].finish_reason, 'tool_calls');
});

test('SSE：分片顺序稳定，usage 只在被要求时出现', () => {
  const writes = [];
  const res = { write: chunk => writes.push(chunk), end: chunk => writes.push(chunk) };
  const result = completion('OC · Big Pickle', { role: 'assistant', content: 'hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, { input: 3, output: 4 });
  sendSSE(res, result, false, false);
  const frames = writes.join('').split('\n\n').filter(Boolean);
  assert.match(frames[0], /"role":"assistant"/);
  assert.match(frames[1], /"content":"hello"/);
  assert.match(frames[2], /"tool_calls":\[\{"index":0/);
  assert.ok(!writes.join('').includes('"usage"'));
  assert.match(writes.at(-1), /data: \[DONE\]/);

  const withUsage = [];
  sendSSE({ write: c => withUsage.push(c), end: c => withUsage.push(c) }, result, true, true);
  assert.match(withUsage.join(''), /"usage":/);
  assert.ok(!withUsage.join('').includes('"role":"assistant"'));
});

test('BridgeError 带上状态码与错误码', () => {
  const error = new BridgeError('nope', 502, 'invalid_tool_call');
  assert.equal(error.status, 502);
  assert.equal(error.code, 'invalid_tool_call');
  assert.equal(new BridgeError('x').status, 400);
});
