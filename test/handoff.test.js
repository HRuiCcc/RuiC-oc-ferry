import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff, handoffInput, validateAction, rejectFeedback } from '../src/handoff.js';
import { freeModels, shrinkPermission } from '../src/backend.js';

const tool = (name, properties, required = []) => ({ type: 'function', function: { name, description: `${name} tool`, parameters: { type: 'object', properties, required } } });
const TOOLS = [
  tool('Bash', { command: { type: 'string' }, description: { type: 'string' } }, ['command']),
  tool('Read', { file_path: { type: 'string' }, offset: { type: 'number' } }, ['file_path']),
  tool('Write', { file_path: { type: 'string' }, content: { type: 'string' } }, ['file_path', 'content']),
  tool('Edit', { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['file_path', 'old_string', 'new_string']),
  tool('Glob', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
  tool('Skill', { skill: { type: 'string' }, args: { type: 'string' } }, ['skill']),
];

test('被拦下的本机动作映射成外部工具与字段名', () => {
  assert.deepEqual(buildHandoff({ native: 'bash', input: { command: 'ls -la', description: 'list' }, tools: TOOLS }),
    { name: 'Bash', arguments: { command: 'ls -la', description: 'list' } });
  // 本机用 filePath，外部叫 file_path：名字要跟着接收方走。
  assert.deepEqual(buildHandoff({ native: 'read', input: { filePath: '/tmp/a.md', offset: 10 }, tools: TOOLS }),
    { name: 'Read', arguments: { file_path: '/tmp/a.md', offset: 10 } });
  assert.deepEqual(buildHandoff({ native: 'write', input: { path: '/tmp/b.md', content: 'body' }, tools: TOOLS }),
    { name: 'Write', arguments: { file_path: '/tmp/b.md', content: 'body' } });
  assert.deepEqual(buildHandoff({ native: 'edit', input: { filePath: '/tmp/c', oldString: 'a', newString: 'b' }, tools: TOOLS }),
    { name: 'Edit', arguments: { file_path: '/tmp/c', old_string: 'a', new_string: 'b' } });
  // 字段名有多个可接受写法时按目标 schema 选。
  assert.deepEqual(buildHandoff({ native: 'glob', input: { pattern: '**/*.js', path: 'src' }, tools: TOOLS }),
    { name: 'Glob', arguments: { pattern: '**/*.js', path: 'src' } });
  assert.deepEqual(buildHandoff({ native: 'skill', input: { name: 'copywriting-rewrite', arguments: '{}' }, tools: TOOLS }),
    { name: 'Skill', arguments: { skill: 'copywriting-rewrite', args: '{}' } });
});

test('不转交的三种情况：没有对应类别、目标 schema 对不上、必填项凑不齐', () => {
  assert.equal(buildHandoff({ native: 'todowrite', input: { todos: [] }, tools: TOOLS }), null);
  assert.equal(buildHandoff({ native: 'bash', input: { command: 'ls' }, tools: [tool('Bash', { cwd: { type: 'string' } }, [])] }), null);
  assert.equal(buildHandoff({ native: 'write', input: { filePath: '/tmp/b' }, tools: TOOLS }), null);
  assert.equal(buildHandoff({ native: 'bash', input: {}, tools: TOOLS }), null);
});

test('参数来源：工具 part 优先，审批元数据只补空缺', () => {
  const action = { tool: 'bash', input: { command: 'echo hi' } };
  const permission = { metadata: { command: 'rm -rf /', filepath: '/tmp/x' } };
  assert.deepEqual(handoffInput(action, permission), { command: 'echo hi', filePath: '/tmp/x' });

  // part 还在等审批、参数是空的：这时全靠元数据。
  assert.deepEqual(handoffInput({ tool: 'bash', input: {} }, { metadata: { command: 'pwd' } }), { command: 'pwd' });
  assert.deepEqual(handoffInput({ tool: 'glob', input: {} }, { metadata: { patterns: ['**/*.md', '**/*.txt'] } }), { pattern: '**/*.md' });
  assert.deepEqual(handoffInput(null, { metadata: { path: '/a/b' } }), { filePath: '/a/b' });
  assert.deepEqual(handoffInput({ tool: 'bash', input: {} }, {}), {});
});

test('翻译出来的动作要过接收方自己的 schema，一个字都不许放宽', () => {
  assert.deepEqual(validateAction({ name: 'Read', arguments: { file_path: '/a' } }, TOOLS), { name: 'Read', arguments: { file_path: '/a' } });
  // 名字大小写不敏感，但落在消息里用接收方的写法
  assert.deepEqual(validateAction({ name: 'read', arguments: { file_path: '/a' } }, TOOLS).name, 'Read');
  assert.throws(() => validateAction({ name: 'TodoWrite', arguments: { todos: [] } }, TOOLS), /did not offer/);
  assert.throws(() => validateAction({ name: 'Read', arguments: { path: '/a' } }, TOOLS), /does not declare: path/);
  assert.throws(() => validateAction({ name: 'Read', arguments: {} }, TOOLS), /misses a required argument/);
  assert.throws(() => validateAction([], TOOLS), /not an object/);
  assert.throws(() => validateAction({ name: 'Read', arguments: [] }, TOOLS), /arguments are not an object/);
});

test('拒绝文案点名工具与原因', () => {
  const text = rejectFeedback('bash', 'its arguments cannot be mapped');
  assert.match(text, /Native tool "bash" was blocked/);
  assert.match(text, /the external client owns execution/);
});

test('免费模型按价格判定：付费输出、缓存计费、deprecated 都不算', () => {
  const providers = { all: [{ id: 'opencode', models: {
    free: { name: 'Free One', cost: { input: 0, output: 0 }, capabilities: { output: { text: true }, input: { image: true }, toolcall: true, reasoning: true }, limit: { context: 1000, output: 500 }, variants: { a: { reasoningEffort: 'low' } } },
    paid: { name: 'Paid', cost: { input: 0, output: 1 }, capabilities: { output: { text: true } } },
    cached: { name: 'Cached', cost: { input: 0, output: 0, cache: { read: 1 } }, capabilities: { output: { text: true } } },
    dead: { name: 'Dead', cost: { input: 0, output: 0 }, status: 'deprecated', capabilities: { output: { text: true } } },
    imageonly: { name: 'ImageOnly', cost: { input: 0, output: 0 }, capabilities: { output: { text: false } } },
  } }] };
  const free = freeModels(providers);
  assert.deepEqual(free.map(m => m.id), ['opencode/free']);
  assert.equal(free[0].images, true);
  assert.equal(free[0].output, 500);
  assert.deepEqual(free[0].variants, { a: { reasoningEffort: 'low' } });
  assert.throws(() => freeModels({ all: [] }), /OpenCode provider missing/);
  // 全是付费模型时返回空清单；"没有免费模型"这个判断在 Backend.models() 里做，
  // 因为它要保护的是既有配置而不是这一份返回值。
  assert.deepEqual(freeModels({ all: [{ id: 'opencode', models: { paid: { name: 'Paid', cost: { input: 0, output: 1 }, capabilities: { output: { text: true } } } } }] }), []);
});

test('审批载荷保留形状但截断长字符串', () => {
  const long = 'x'.repeat(700);
  const shrunk = shrinkPermission({ filepath: '/a', content: long, nested: { body: long }, list: [long] });
  assert.equal(shrunk.filepath, '/a');
  assert.match(shrunk.content, /…\[700 chars\]$/);
  assert.match(shrunk.nested.body, /…\[700 chars\]$/);
  assert.match(shrunk.list[0], /…\[700 chars\]$/);
});
