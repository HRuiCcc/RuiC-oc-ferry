// 托盘与面板共用的一份文案：状态名只描述"观察到的事件"，
// 不做任何"上游正在思考"之类的猜测性描述。
function activityText(a) {
  if (!a) return null;
  const seconds = ms => Math.max(0, Math.floor((ms || 0) / 1000));
  const name = String(a.model || '').replace(/^opencode\//, '');
  const stages = { waiting: '等待上游返回', busy: '等待上游返回', receiving: '已收到模型内容',
    reasoning: '已收到推理内容', permission: '处理工具审批', checking: '校验模型响应',
    correcting: '请求模型修正后重发', repair: '辅助模型转换格式', handoff: '转交 WorkBuddy 工具' };
  const stage = a.status === 'retry' ? `上游重试第 ${a.attempt ?? '?'} 次` : stages[a.status] || '等待上游返回';
  const quiet = a.sinceContentMs == null ? '尚未收到内容' : `距最近内容 ${seconds(a.sinceContentMs)} 秒`;
  const helper = a.status === 'repair' && a.repairModel ? `（${a.repairModel.replace(/^opencode\//, '')}）` : '';
  return `${name} · ${stage}${helper} · 已等待 ${seconds(a.waitedMs)} 秒 · ${quiet}${a.error ? ` · 上游错误：${a.error}` : ''}`;
}
if (typeof module !== 'undefined') module.exports = { activityText };
else window.OCFerryActivity = { activityText };
