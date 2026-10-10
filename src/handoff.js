import { BridgeError } from './protocol.js';

// 执行权在外部客户端手里。模型若在本机动手，被拦下的那个动作应该直接转交成外部调用，
// 而不是让它复述一遍——"复述"恰好是模型最容易做错的一步，还多花一整轮上游调用。
//
// 每次请求里 WorkBuddy 附带的工具表就是权威：只填目标 schema 里存在的字段，
// 必填项凑不齐就不转交，退回给模型一条带原因的纠正反馈。
const CATEGORIES = [
  { native: ['bash', 'shell'], targets: ['Bash', 'PowerShell'],
    fields: { command: 'command', description: 'description', timeout: 'timeout' } },
  { native: ['read'], targets: ['Read'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', offset: 'offset', limit: 'limit' } },
  { native: ['write'], targets: ['Write'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', content: 'content' } },
  { native: ['edit', 'multiedit', 'multi_edit', 'patch', 'apply_patch'], targets: ['Edit', 'MultiEdit'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path',
      oldString: 'old_string', old_string: 'old_string', newString: 'new_string', new_string: 'new_string',
      replaceAll: 'replace_all', replace_all: 'replace_all', edits: 'edits' } },
  // 同一个字段名可能有多个可接受的目标写法：外部工具之间拼写并不统一。
  { native: ['glob'], targets: ['Glob', 'LS'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include' } },
  { native: ['grep'], targets: ['Grep', 'Search'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include', output_mode: 'output_mode' } },
  { native: ['skill'], targets: ['Skill'],
    fields: { name: ['name', 'skill'], skill: ['skill', 'name'], args: ['args', 'arguments'], arguments: ['arguments', 'args'] } },
];

export function buildHandoff({ native, input = {}, tools = [] }) {
  const name = String(native ?? '').toLowerCase();
  const category = CATEGORIES.find(entry => entry.native.includes(name));
  if (!category) return null;
  for (const target of category.targets) {
    const spec = tools.map(tool => tool?.function).find(fn => fn?.name?.toLowerCase() === target.toLowerCase());
    const properties = spec?.parameters?.properties;
    if (!properties) continue;
    const args = {};
    for (const [key, value] of Object.entries(input)) {
      const candidates = category.fields[key];
      if (!candidates || value === undefined) continue;
      for (const mapped of Array.isArray(candidates) ? candidates : [candidates]) {
        if (args[mapped] !== undefined || !Object.hasOwn(properties, mapped)) continue;
        args[mapped] = value;
        break;
      }
    }
    const required = Array.isArray(spec.parameters.required) ? spec.parameters.required : [];
    if (!Object.keys(args).length) continue;
    if (!required.every(key => args[key] !== undefined && args[key] !== null && args[key] !== '')) continue;
    return { name: spec.name, arguments: args };
  }
  return null;
}

// 调用还在等审批时，OpenCode 把参数放在审批元数据里，工具 part 的 input 要等执行才有值。
// 有 part 的时候以 part 为准，元数据只补它缺的那些字段。
export function handoffInput(action, permission) {
  const input = { ...(action?.input ?? {}) };
  const metadata = permission?.metadata ?? {};
  const fallback = {
    command: metadata.command,
    filePath: metadata.filepath ?? metadata.filePath ?? metadata.path,
    pattern: metadata.pattern ?? (Array.isArray(metadata.patterns) ? metadata.patterns[0] : undefined),
  };
  for (const [key, value] of Object.entries(fallback)) {
    if (input[key] === undefined && typeof value === 'string' && value.trim()) input[key] = value;
  }
  return input;
}

// 拒绝必须点名工具和原因：含糊的拒绝会让模型继续瞎猜，
// 而"反复尝试本地执行"正是含糊拒绝逼出来的行为。
export function rejectFeedback(native, reason) {
  return `Native tool "${native}" was blocked: ${reason}. Native execution is forbidden; the external client owns execution. `
    + 'Return the requested external action inside the calls array using StructuredOutput. The external client will execute it and supply results. Do not call any other native tools.';
}

// 翻译出来的动作不享受任何信任：由接收方自己的 schema 裁决，
// 和静态映射表走同一套规则，这样"翻译"这条路径永远不可能放宽可执行范围。
export function validateAction(candidate, tools = []) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new BridgeError('Translated action is not an object', 502, 'invalid_tool_call');
  const spec = tools.map(tool => tool?.function).find(fn => fn?.name && fn.name.toLowerCase() === String(candidate.name ?? '').toLowerCase());
  if (!spec) throw new BridgeError('Translated action names a tool the receiver did not offer', 502, 'invalid_tool_call');
  const args = candidate.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args))
    throw new BridgeError('Translated action arguments are not an object', 502, 'invalid_tool_call');
  const properties = spec.parameters?.properties ?? {};
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key))
    throw new BridgeError(`Translated action sets an argument the receiver does not declare: ${key}`, 502, 'invalid_tool_call');
  const required = Array.isArray(spec.parameters?.required) ? spec.parameters.required : [];
  if (!required.every(key => args[key] !== undefined && args[key] !== null && args[key] !== ''))
    throw new BridgeError('Translated action misses a required argument', 502, 'invalid_tool_call');
  return { name: spec.name, arguments: args };
}
