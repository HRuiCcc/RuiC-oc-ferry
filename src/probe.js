import { randomBytes } from 'node:crypto';
import { BridgeError } from './protocol.js';

// 检测要尽量贴近 WorkBuddy 的真实流量。早先的版本用 tool_choice: "required" 加单个工具，
// 那只验证了传输和格式：一个"只回文本、不产生动作"的模型照样通过，然后在真实回合里
// 白等（实测 98 秒与 58 秒）而 WorkBuddy 什么也没看到。
export const PROBE_TIMEOUT = 60000;

export const PROBE_TOOLS = [
  { type: 'function', function: { name: 'Read', description: 'Read a file from the external working directory.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path of the file to read' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'Write', description: 'Write a file in the external working directory.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } },
  { type: 'function', function: { name: 'Bash', description: 'Run a shell command on the external machine.', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'Glob', description: 'List files matching a pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'WebSearch', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

// 多个工具 + 自由选择，让探测走的是和真实流量同一条路。
export function probeBody(model, token) {
  return {
    model: model.id,
    messages: [{ role: 'user', content: `Read /external/probe-${token}.txt and report its contents.` }],
    tools: structuredClone(PROBE_TOOLS),
    parallel_tool_calls: false,
  };
}

// "只回文本"正是这个探测要抓的失败，不是可接受的答案。
export function judgeProbe(response, token) {
  const calls = response?.choices?.[0]?.message?.tool_calls;
  if (!calls?.length) throw new BridgeError('模型只返回了文本，没有产生任何动作', 502, 'no_action');
  let args = {};
  try { args = JSON.parse(calls[0].function?.arguments || '{}'); } catch {}
  // 动作与请求不符不算"格式不兼容"：信封是合法的，错的是动作。
  // 它必须如实报告为语义没命中，并把真正回来的名字留作证据。
  if (calls.length !== 1 || calls[0].function?.name !== 'Read' || !String(args.file_path || '').includes(token))
    throw new BridgeError(`模型返回的动作与探测请求不符（收到 ${calls.map(call => call?.function?.name || '未命名').join('、') || '无调用'}）`, 502, 'probe_mismatch');
  return calls[0];
}

// 仅对话的降级是留给"回答格式装不下工具调用"的模型的。
// 一个反复想在本机执行的模型是另一种失败：按仅对话发布等于交给 WorkBuddy 一个永远不动手的模型，
// 面板上还会显示"可用 · 仅对话"，把拒绝适配器契约的模型说成好用的模型。
export function formatUnsupported(error) {
  return ['invalid_model_output', 'invalid_tool_call'].includes(error?.code)
    || /only.{0,10}auto.{0,40}supported.{0,20}tool_choice/i.test(error?.message || '');
}

// 语义没命中是一次随机事件，重试一次可以避免"上次能用的模型这次被一次坏运气撤掉"。
// 格式失败属于仅对话那条路，超时反映的是负载而不是运气，都不在这里重试。
export const RETRYABLE_PROBE = new Set(['probe_mismatch', 'no_action']);

export async function probeModel({ complete, retries = 1 }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = randomBytes(8).toString('hex');
    try {
      const response = await complete(token);
      judgeProbe(response, token);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !RETRYABLE_PROBE.has(error.code)) throw error;
    }
  }
  throw lastError;
}

// 超时的判定由探测自己持有：AbortSignal.any 抛出来是一句不透明的
// "The operation was aborted"，直接透传会被记成一个不明原因的错误。
export function probeFailure(cause, timedOut) {
  if (!timedOut) return cause;
  const error = new BridgeError('Model probe timed out', 504, 'timeout');
  error.name = 'TimeoutError';
  return error;
}
