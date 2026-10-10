// 上游没有可查的剩余额度接口，所以失败只能按错误内容归类。
// 归类只影响界面上的标签，不参与"能不能用"的判断。
export function modelResult(ok, message = '', status, code) {
  let category = 'available';
  if (!ok) {
    if (/insufficient[_ ]quota|quota.{0,30}(exceed|exhaust|deplet)|out of credits|insufficient.{0,20}(credit|balance)|额度.{0,10}(不足|用尽)/i.test(message)) category = 'quota';
    else if (status === 429 || /rate.?limit|too many requests/i.test(message)) category = 'rate_limit';
    else if (status === 401 || status === 403) category = 'access';
    else if (/timeout|timed out/i.test(message)) category = 'timeout';
    else category = 'error';
  }
  return { ok, category, time: new Date().toISOString(), ...(message ? { error: message } : {}), ...(status ? { status } : {}), ...(code ? { code } : {}) };
}

// 一次请求的结果是"这一次调用的观察"，不是对模型能力的判定：
// 工具数、被拦下的本地动作、步骤数、转交出去的动作都只是记录，能力标签只来自检测。
export function withRequestMeta(result, meta = {}) {
  if (!meta || typeof meta !== 'object') return result;
  if (Number.isInteger(meta.calls)) result.calls = meta.calls;
  if (Number.isInteger(meta.nativeAttempts)) result.nativeAttempts = meta.nativeAttempts;
  if (Number.isInteger(meta.steps)) result.steps = meta.steps;
  if (typeof meta.handoff === 'string') result.handoff = meta.handoff;
  if (meta.handoffCheck) result.handoffCheck = meta.handoffCheck;
  if (meta.repaired) result.repaired = meta.repaired;
  return result;
}

// 可用清单的唯一定义：目录里有它、判定通过、且最近一次结果是 ok。
// 抽成纯函数是因为它有三处调用者（探测记账、采用缓存判定、面板读取），
// 各写一遍就会出现"同一份状态算出两份不同清单"——曾经就因此把刚采用成功的模型漏在外面。
export function usableModelIds(models, validated, modelResults) {
  return models.filter(model => validated.has(model.id) && modelResults[model.id]?.ok === true).map(model => model.id);
}

// WorkBuddy 里显示的名字。`OC · ` 是给用户看的路由标记，上游 id 仍然用 opencode/ 前缀，
// 两者之间的映射全部走这个函数，避免任何一处写死前缀。
export function clientModelID(model) { return `OC · ${model.name}`; }
