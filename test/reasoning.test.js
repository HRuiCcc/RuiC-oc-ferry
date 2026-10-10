import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningEfforts, workBuddyReasoning } from '../src/reasoning.js';

const model = (variants, reasoning = true) => ({ reasoning, variants });

test('只有能落到 OpenCode variant 上的档位才被映射', () => {
  const efforts = reasoningEfforts(model({
    fast: { reasoningEffort: 'low' },
    deep: { reasoningEffort: 'high' },
    broken: {},
    off: { reasoningEffort: 'none' },
    legacy: { reasoningEffort: 'turbo' },
    disabled: { reasoningEffort: 'medium', disabled: true },
  }));
  assert.deepEqual(efforts, { low: 'fast', high: 'deep', none: 'off' });
  assert.deepEqual(reasoningEfforts({ reasoning: false, variants: { a: { reasoningEffort: 'low' } } }), {});
});

test('不支持推理时直接说不支持', () => {
  assert.deepEqual(workBuddyReasoning({ reasoning: false }), { supportsReasoning: false });
});

test('支持推理但无档位：勾选推理、不广告档位、思考关不掉', () => {
  assert.deepEqual(workBuddyReasoning(model({})), {
    supportsReasoning: true, onlyReasoning: true,
    reasoning: { supportedEfforts: [], canDisableThinking: false },
  });
});

test('有档位时默认优先 medium，并保留能否关闭思考的信息', () => {
  const withNone = workBuddyReasoning(model({ a: { reasoningEffort: 'none' }, b: { reasoningEffort: 'low' }, c: { reasoningEffort: 'high' } }));
  assert.deepEqual(withNone.reasoning.supportedEfforts, ['none', 'low', 'high']);
  assert.equal(withNone.reasoning.defaultEffort, 'low');
  assert.equal(withNone.reasoning.canDisableThinking, true);
  assert.equal(withNone.onlyReasoning, false);

  const withMedium = workBuddyReasoning(model({ b: { reasoningEffort: 'low' }, c: { reasoningEffort: 'medium' } }));
  assert.equal(withMedium.reasoning.defaultEffort, 'medium');
  assert.equal(withMedium.reasoning.canDisableThinking, false);
  assert.equal(withMedium.onlyReasoning, true);
});
