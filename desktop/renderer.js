'use strict';

const $ = id => document.getElementById(id);
let state = { phase: 'starting' };
let selected = null;
let pendingAction = null;
let lastSignature = '';

// ── 主题 ─────────────────────────────────────────────────────────────────────
// "系统"档在这里用 matchMedia 解析成实际值，最终只给 <html> 一个明确的
// data-theme，所以 CSS 那边只需要维护两套 token。选择存在 localStorage；
// 存不进去（被策略禁掉之类）也不影响本次会话里的切换。
const THEME_KEY = 'oc-ferry-theme';
const THEME_CHOICES = ['system', 'light', 'dark'];
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
let themeChoice = (() => {
  try { const saved = localStorage.getItem(THEME_KEY); if (THEME_CHOICES.includes(saved)) return saved; } catch {}
  return 'system';
})();

function applyTheme() {
  const resolved = themeChoice === 'system' ? (prefersDark.matches ? 'dark' : 'light') : themeChoice;
  document.documentElement.dataset.theme = resolved;
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === themeChoice));
  }
}

applyTheme();
const actionIcons = new Map(['refresh', 'probe', 'import'].map(id => [id, $(id).querySelector('svg').cloneNode(true)]));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(id, text) {
  if ($(id).textContent !== String(text)) $(id).textContent = text;
}

function icon(kind, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', kind === 'disclosure' ? '0 0 16 16' : '0 0 32 32');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'disclosure' ? 'm6 4 4 4-4 4' : 'M5 7h22v18H5zM5 13h22M11 7v18M15 18h8M15 21h5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function operationBusy() {
  return !!(pendingAction || state.actionBusy || state.probe?.running || state.configSearch?.running);
}

function controlsBusy() {
  return operationBusy() || state.phase !== 'ready';
}

function probing(id) {
  return !!(state.probe?.running && (activeProbe(id) || state.probe.pending?.includes(id)));
}

// 并发检测时同时有多个模型在跑；旧状态里只有 current，兜底兼容一下。
function activeProbe(id) {
  if (!state.probe?.running) return false;
  return state.probe.active ? state.probe.active.includes(id) : state.probe.current === id;
}

function relativeTime(iso) {
  const ms = Date.now() - (Date.parse(iso) || 0);
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

function requesting(id) {
  return (state.activity || []).some(activity => activity.model === id);
}

function chatOnly(model) {
  return !!(state.modelResults?.[model.id]?.chatOnly || model.chatOnly);
}

function label(model) {
  if (probing(model.id)) return activeProbe(model.id) ? '检测中' : '等待检测';
  if (requesting(model.id)) return '请求中';
  if (state.availableModels?.includes(model.id)) return chatOnly(model) ? '可用 · 仅对话' : '可用';
  const result = state.modelResults?.[model.id];
  return ({ timeout: '检测超时', quota: '额度不足', rate_limit: '请求受限', access: '访问受限' })[result?.category]
    || (result?.ok === false ? '不可用' : '待检测');
}

// 可用优先，正在检测与尚未判定居中，失败沉底；每档按名称排列。
function rank(model) {
  if (probing(model.id)) return 1;
  if (state.availableModels?.includes(model.id)) return 0;
  if (requesting(model.id)) return 1;
  return state.modelResults?.[model.id]?.ok === false ? 2 : 1;
}

function statusClass(model) {
  if (probing(model.id)) return 'checking';
  if (requesting(model.id)) return 'requesting';
  if (state.availableModels?.includes(model.id)) return chatOnly(model) ? 'chat-only' : 'available';
  return rank(model) === 2 ? 'unavailable' : 'waiting';
}

function timing(id) {
  const result = state.modelResults?.[id];
  const duration = Number.isFinite(result?.durationMs)
    ? (result.durationMs < 1000 ? `${result.durationMs} ms` : `${(result.durationMs / 1000).toFixed(1)} 秒`)
    : null;
  // 缓存判定要说清楚：这条结论不是刚跑出来的，别让人以为刚才验过。
  if (result?.source === 'cache') {
    // 成功/失败本身已经由"状态"列表达，这里只需要说清"这条不是刚跑的"。
    return `缓存判定 · ${relativeTime(result.time)}${duration ? ` · 耗时 ${duration}` : ''}`;
  }
  if (!duration) return '响应耗时 —';
  return `最近${result.source === 'probe' ? '检测' : '调用'} · ${result.ok ? '响应' : '失败'}耗时 ${duration}`;
}

function detailRow(model, detailId) {
  const result = state.modelResults?.[model.id] || {};
  const row = element('tr', 'model-detail-row');
  const cell = element('td');
  cell.colSpan = 5;
  const detail = element('div', 'model-detail');
  detail.id = detailId;
  detail.setAttribute('role', 'region');
  detail.setAttribute('aria-label', `OC · ${model.name} 详情`);
  const header = element('div', 'detail-header');
  header.append(element('span', 'detail-label', '模型 ID'), element('code', 'model-id', model.id));
  detail.append(header);

  const specs = element('div', 'detail-specs');
  specs.append(element('p', '', `图片输入：${model.images ? '支持' : '不支持'}`));
  specs.append(element('p', '', `上下文：${model.context ?? '未声明'} · 输入上限：${model.input ?? '未单独声明'} · 输出上限：${model.output ?? '未声明'}`));
  const variants = Object.keys(model.variants || {});
  specs.append(element('p', '', model.reasoning
    ? `推理：支持 · ${variants.length ? '可选档位：' + variants.join(' / ') : '使用默认模式'}`
    : '推理：OpenCode 未声明支持'));
  detail.append(specs);

  const events = element('div', 'detail-events');
  const add = (text, className = '') => events.append(element('p', className, text));
  if (chatOnly(model)) add('已自动关闭工具调用；导入后仅支持普通对话。');
  if (Number.isInteger(result.nativeAttempts) && result.nativeAttempts > 0) {
    add(`最近一次调用拦截了 ${result.nativeAttempts} 次本地执行尝试，动作必须由 WorkBuddy 执行。`, 'warning-text');
  }
  if (Number.isInteger(result.calls) && result.calls > 0) add(`最近一次调用返回了 ${result.calls} 个动作。`);
  if (result.handoff) add(`最近一次调用把被拦下的本地动作转交成外部 ${result.handoff} 调用。`);
  const repairs = Object.entries(result.repaired ?? {}).filter(([, value]) => value?.ok);
  if (repairs.length) {
    add(`这一轮由格式兜底救回：${repairs.map(([shape, value]) => `${shape === 'action' ? '动作转写' : '信封重排'}（${String(value.model).replace(/^opencode\//, '')}）`).join('、')}。`);
  }
  if (result.source === 'cache') add(`这一条是缓存判定（${relativeTime(result.time)}），没有重新发请求；需要重新验证就点下面的「只重测这一个」。`);
  if (result.error) add(result.error, 'error-text');
  if (events.childElementCount) detail.append(events);
  detail.append(element('p', 'detail-updated', '最近更新：' + (result.time ? new Date(result.time).toLocaleString() : '尚未检测')));

  // 只重测这一个模型：不想为它一个人重跑整轮（或者想立刻验证缓存里的结论）时用。
  const actions = element('div', 'detail-actions');
  const reprobe = element('button', '', activeProbe(model.id) ? '正在检测…' : '只重测这一个');
  reprobe.type = 'button';
  reprobe.disabled = operationBusy() || activeProbe(model.id);
  reprobe.addEventListener('click', event => { event.stopPropagation(); run('probe', model.id); });
  actions.append(reprobe);
  detail.append(actions);
  cell.append(detail);
  row.append(cell);
  return row;
}

function toggleDetails(modelId) {
  selected = selected === modelId ? null : modelId;
  renderModels();
}

function renderModels() {
  if (selected && !(state.models || []).some(model => model.id === selected)) selected = null;
  // 活动计时仅更新状态条。行内容未变时保留 DOM，避免轮询打断滚动和键盘操作。
  const signature = JSON.stringify([
    state.models, state.modelResults, state.probe, state.availableModels, state.excludedModels,
    (state.activity || []).map(activity => activity.model), controlsBusy(), state.phase, selected
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  const scroller = $('models');
  const scrollTop = scroller.scrollTop;
  const active = document.activeElement;
  const focus = active?.dataset?.model ? { model: active.dataset.model, control: active.dataset.control } : null;
  const rows = document.createDocumentFragment();
  const models = [...(state.models || [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  for (const [index, model] of models.entries()) {
    const expanded = selected === model.id;
    const detailId = `model-detail-${index}`;
    const row = element('tr', 'model' + (expanded ? ' selected' : ''));
    row.dataset.model = model.id;
    const checkCell = element('td', 'check-cell');
    const choose = element('input', 'model-check');
    choose.type = 'checkbox';
    choose.dataset.model = model.id;
    choose.dataset.control = 'selection';
    choose.checked = !!state.availableModels?.includes(model.id) && !(state.excludedModels || []).includes(model.id);
    choose.disabled = controlsBusy() || !state.availableModels?.includes(model.id);
    choose.setAttribute('aria-label', `导入 OC · ${model.name}`);
    choose.addEventListener('click', event => event.stopPropagation());
    choose.addEventListener('change', () => run('selection', { model: model.id, selected: choose.checked }));
    checkCell.append(choose);

    const nameCell = element('td', 'name-cell');
    const details = element('button', 'model-details');
    details.type = 'button';
    details.dataset.model = model.id;
    details.dataset.control = 'details';
    details.setAttribute('aria-label', `查看 OC · ${model.name} 详情`);
    details.setAttribute('aria-expanded', String(expanded));
    if (expanded) details.setAttribute('aria-controls', detailId);
    details.append(icon('disclosure', 'disclosure-icon'), element('span', 'model-name', `OC · ${model.name}`));
    details.addEventListener('click', event => { event.stopPropagation(); toggleDetails(model.id); });
    nameCell.append(details);

    const capabilities = element('td', 'capability-cell');
    if (model.reasoning) capabilities.append(element('span', 'capability', '推理'));
    if (model.images) capabilities.append(element('span', 'capability', '图片'));
    if (!capabilities.childElementCount) {
      const empty = element('span', 'capability-empty', '—');
      empty.setAttribute('aria-label', '未声明推理或图片能力');
      capabilities.append(empty);
    }

    const statusCell = element('td', 'status-cell');
    const status = element('span', 'model-status ' + statusClass(model));
    const statusIcon = element('span', activeProbe(model.id) || requesting(model.id) ? 'spinner' : 'status-dot');
    statusIcon.setAttribute('aria-hidden', 'true');
    status.append(statusIcon, element('span', 'status-label', label(model)));
    statusCell.append(status);
    const durationCell = element('td', 'timing-cell', timing(model.id));
    row.append(checkCell, nameCell, capabilities, statusCell, durationCell);
    row.addEventListener('click', event => {
      if (!event.target.closest('button, input')) toggleDetails(model.id);
    });
    rows.append(row);
    if (expanded) rows.append(detailRow(model, detailId));
  }

  if (!models.length) {
    const row = element('tr');
    const cell = element('td');
    cell.colSpan = 5;
    const empty = element('div', 'empty-state');
    const error = state.phase === 'error';
    const stopped = state.phase === 'stopped';
    empty.append(icon('empty', 'empty-icon'), element('h4', '', error ? '模型服务暂不可用' : stopped ? '模型服务已停止' : state.phase === 'ready' ? '未发现免费模型' : '正在读取免费模型'));
    empty.append(element('p', '', error ? '请查看底部状态，点击重试重新启动。' : stopped ? '服务恢复后，模型将在这里显示。' : state.phase === 'ready' ? '点击读取免费模型，重新读取免费模型目录。' : '正在安装或扫描模型，完成后将在这里显示。'));
    cell.append(empty);
    row.append(cell);
    rows.append(row);
  }
  $('model-rows').replaceChildren(rows);
  if (focus) {
    const controls = [...$('model-rows').querySelectorAll('button[data-model], input[data-model]')];
    const same = controls.find(control => control.dataset.model === focus.model && control.dataset.control === focus.control && !control.disabled);
    const fallback = controls.find(control => control.dataset.model === focus.model && control.dataset.control === 'details');
    (same || fallback)?.focus({ preventScroll: true });
  }
  scroller.scrollTop = scrollTop;
}

function renderAction(id, title, busyTitle, active) {
  const button = $(id);
  const text = active ? busyTitle : title;
  if (button.dataset.label !== text) {
    button.replaceChildren(active ? element('span', 'spinner') : actionIcons.get(id).cloneNode(true), element('span', '', text));
    const graphic = button.firstElementChild;
    graphic.setAttribute('aria-hidden', 'true');
    button.dataset.label = text;
  }
  button.setAttribute('aria-busy', String(!!active));
}

function syncText() {
  if (state.configSearch?.running) return 'OpenCode 正在只读查找 WorkBuddy 配置…';
  if (state.configSearch?.candidates?.length > 1 && !state.modelsFile) return '已找到配置文件，点击导入 WorkBuddy 使用最近访问的一份。';
  if (state.sync?.error) return state.sync.error;
  if (state.sync?.time) return `已导入 ${state.sync.count ?? 0} 个模型 · 再次检测后需点击导入 WorkBuddy 更新`;
  return '首次读取和检测完成后自动导入 WorkBuddy';
}

function render() {
  const busy = controlsBusy();
  for (const id of ['refresh', 'probe', 'import']) $(id).disabled = busy;
  $('restart').hidden = state.phase !== 'error';
  $('restart').disabled = operationBusy();
  $('proxy').disabled = operationBusy() || !['ready', 'error'].includes(state.phase);
  $('proxy').checked = state.useSystemProxy === true;
  renderAction('refresh', '读取免费模型', '正在读取…', pendingAction === 'refresh' || state.actionBusy === 'refresh');
  renderAction('probe', '检测全部', '正在检测…', pendingAction === 'probe' || state.actionBusy === 'probe' || state.probe?.running);
  renderAction('import', '导入 WorkBuddy', '正在导入…', pendingAction === 'import' || state.actionBusy === 'import');

  setText('discovered', state.models?.length || 0);
  setText('available', state.availableModels?.length || 0);
  setText('pending', state.models?.filter(model => rank(model) === 1).length || 0);
  const chosen = (state.availableModels || []).filter(id => !(state.excludedModels || []).includes(id)).length;
  setText('selected-count', `已选 ${chosen} 个可用模型`);
  setText('target-file', state.modelsFile || '尚未定位配置文件，导入时查找或选择');
  $('target-file').title = state.modelsFile || '';
  setText('sync', syncText());
  $('sync').classList.toggle('error-text', !!state.sync?.error && syncText() === state.sync.error);

  const activity = state.activity?.[0];
  const warning = state.phase === 'error' || !!activity?.error;
  const serviceBusy = operationBusy() || ['starting', 'reading'].includes(state.phase);
  setText('service-text', window.OCFerryActivity.activityText(activity) || state.message || '正在启动隔离模型服务');
  $('service-status').className = 'service-status' + (warning ? ' error' : state.phase === 'stopped' ? ' stopped' : serviceBusy ? ' busy' : '');
  $('service-dot').className = 'dot' + (warning ? ' error' : state.phase === 'stopped' ? ' stopped' : serviceBusy ? ' busy' : '');
  $('probe-progress').hidden = !state.probe?.running;
  if (state.probe?.running) {
    const pending = new Set(state.probe.pending || []);
    if (state.probe.current) pending.add(state.probe.current);
    setText('probe-progress', `还剩 ${pending.size} 个模型`);
  }
  setText('endpoint', state.endpoint || '尚未启动');
  setText('opencode-version', state.opencodeVersion || '—');
  renderModels();
}

function canRun(name, value) {
  if (operationBusy()) return false;
  if (name === 'restart') return state.phase === 'error';
  if (name === 'system-proxy') return ['ready', 'error'].includes(state.phase);
  if (state.phase !== 'ready') return false;
  return name !== 'selection' || !!state.availableModels?.includes(value?.model);
}

async function run(name, value) {
  if (!canRun(name, value)) return;
  pendingAction = name;
  $('feedback').hidden = true;
  render();
  try {
    const response = await window.ferry.action(name, value);
    if (!response.ok) throw new Error(response.error);
    if (name === 'selection') {
      state.excludedModels = response.result.excludedModels;
      feedback('选择已保存，点击导入 WorkBuddy 后生效。');
    }
    if (name === 'import') {
      const result = response.result;
      feedback(result.canceled ? '已取消导入，配置未更改。'
        : result.changed === false ? `配置已是最新，共 ${result.count} 个模型，无需重复写入。`
        : `导入完成，已将 ${result.count} 个可用模型导入 WorkBuddy。`);
    }
  } catch (error) {
    feedback(error.message, true);
  } finally {
    pendingAction = null;
    render();
  }
}

function feedback(text, error = false) {
  setText('feedback', text);
  $('feedback').className = 'feedback' + (error ? ' error' : '');
  $('feedback').setAttribute('role', error ? 'alert' : 'status');
  $('feedback').hidden = false;
}

for (const action of ['refresh', 'probe', 'import', 'restart']) $(action).addEventListener('click', () => run(action));
$('proxy').addEventListener('change', () => run('system-proxy', $('proxy').checked));

// 主题：三档一键到位，不做循环切换——循环没法"直接回到系统"。
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => {
    themeChoice = button.dataset.themeChoice;
    try { localStorage.setItem(THEME_KEY, themeChoice); } catch {}
    applyTheme();
  });
}

// 系统档跟着系统变；明确选了浅色或深色之后，系统设置不再覆盖它。
prefersDark.addEventListener('change', () => { if (themeChoice === 'system') applyTheme(); });

function dismiss() {
  if (selected === null) return;
  selected = null;
  renderModels();
}

// 详情留在表格中。空白点击、Esc 和托盘窗口失焦共享收起逻辑。
document.addEventListener('click', event => {
  if (!event.target.closest('.model, .model-detail-row')) dismiss();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') dismiss();
});
window.ferry.onDismiss(dismiss);
window.ferry.onState(next => { state = next; render(); });
render();
