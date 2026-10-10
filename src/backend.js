import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, decode, completion } from './protocol.js';
import { buildHandoff, handoffInput, rejectFeedback, validateAction } from './handoff.js';
import { rawMaterial, repair, resendPrompt } from './repair.js';

// 保留官方审批闸门，但一次本机动作都不批准：能转交的转交，转不了的带原因拒绝。
export const nativePermissions = { '*': 'ask', question: 'deny', websearch: 'deny', codesearch: 'deny', webfetch: 'deny', task: 'deny', plan_enter: 'deny', plan_exit: 'deny', todowrite: 'deny' };

// "免费"由价格判定，不由名字判定：输入/输出/缓存读写全为 0 才算，
// 并且排除已被标记 deprecated 的模型（它们仍会出现在目录里，但已经路由不到）。
export function freeModels(providers) {
  const provider = providers.all?.find(p => p.id === 'opencode');
  if (!provider) throw new Error('OpenCode provider missing');
  return Object.entries(provider.models).filter(([, m]) => {
    const c = m.cost;
    return c && c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0
      && m.capabilities?.output?.text !== false && m.status !== 'deprecated';
  }).map(([id, m]) => ({ id: `opencode/${id}`, name: m.name || id, context: m.limit?.context, input: m.limit?.input, images: m.capabilities?.input?.image === true, output: m.limit?.output, toolcall: m.capabilities?.toolcall === true, reasoning: m.capabilities?.reasoning === true, variants: m.variants ?? {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 审批载荷里可能带着整个文件内容：形状保留，长字符串截断。
export function shrinkPermission(value, limit = 400) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(item => shrinkPermission(item, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkPermission(item, limit)]));
  return value;
}

function allowedTools(request) {
  return request.choice === 'none' ? [] : request.tools.filter(t => !request.forced || t.function.name === request.forced);
}

export class Backend {
  constructor(base, password, timeout, log = () => {}) {
    Object.assign(this, { base, password, timeout, log, active: new Map(), events: null, toolParts: new Map(), pendingApprovals: new Map(), usageBySession: new Map(), translator: null });
  }
  headers() {
    return { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` };
  }
  async request(route, method = 'GET', body, signal, timeout = this.timeout) {
    const requestSignal = timeout == null ? signal : AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      // 推理请求没有代理层给的截止时间，也不能让 HTTP 客户端自己加个隐式响应超时。
      const req = httpRequest(this.base + route, {
        method, signal: requestSignal, headers: this.headers(),
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new BridgeError(`OpenCode HTTP ${response.statusCode}: ${text.slice(0, 600)}`, response.statusCode >= 500 ? 502 : response.statusCode, 'upstream_error'));
          try { resolve(JSON.parse(text)); }
          catch { reject(new BridgeError('OpenCode returned non-JSON response', 502, 'upstream_error')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(0);
      req.end(body !== undefined ? JSON.stringify(body) : undefined);
    });
  }

  // 一条事件流服务所有在途请求：OpenCode 的上游重试只在这里露面，
  // 请求/响应那条路上看不到任何迹象。
  watchEvents() {
    if (this.events) return;
    const controller = new AbortController();
    this.events = controller;
    (async () => {
      while (!controller.signal.aborted) {
        try { await this.streamEvents(controller.signal); }
        catch (e) { if (controller.signal.aborted) return; this.log(`Event stream error: ${e.message}`); }
        await delay(1000, undefined, { signal: controller.signal, ref: false }).catch(() => {});
      }
    })().catch(() => {});
  }
  stopEvents() {
    this.events?.abort();
    this.events = null;
  }
  streamEvents(signal) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.base + '/event', { method: 'GET', signal, headers: { ...this.headers(), Accept: 'text/event-stream' } }, response => {
        if (response.statusCode !== 200) { response.resume(); return reject(new BridgeError(`Event stream HTTP ${response.statusCode}`, 502, 'event_stream_error')); }
        let buffer = '';
        response.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try { this.handleEvent(JSON.parse(line.slice(5).trim())); } catch {}
          }
        });
        response.on('error', reject);
        response.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
  }
  handleEvent(wrapper) {
    const event = wrapper?.payload ?? wrapper;
    if (['permission.asked', 'permission.updated'].includes(event?.type) && event.properties?.id)
      this.pendingApprovals.set(event.properties.id, event.properties);
    if (event?.type === 'permission.replied') this.pendingApprovals.delete(event.properties?.requestID);
    // 工具 part 带着"被审批闸门拦下"的那个调用的名字与参数。
    // 它比审批先到，而 HTTP 方式列消息是查不到的。
    const part = event?.type === 'message.part.updated' ? event.properties?.part : undefined;
    if (part?.type === 'tool' && part.callID) {
      this.toolParts.set(part.callID, { tool: part.tool, input: part.state?.input ?? {} });
      if (this.toolParts.size > 50) this.toolParts.delete(this.toolParts.keys().next().value);
    }
    const info = event?.type === 'message.updated' ? event.properties?.info : undefined;
    if (info?.role === 'assistant' && info.tokens && this.usageBySession.has(info.sessionID)) this.usageBySession.set(info.sessionID, info.tokens);
    const sessionID = event?.properties?.sessionID;
    const meta = sessionID ? this.active.get(sessionID) : undefined;
    if (!meta || typeof meta.activity !== 'function') return;
    const status = event.properties?.status;
    const progress = { sessionID, model: meta.model, type: event.type, at: Date.now() };
    if (event.type === 'session.status' && status) {
      if (status.type === 'retry' || (status.type === 'busy' && (!meta.stage || meta.stage === 'retry'))) progress.status = status.type === 'busy' ? 'waiting' : 'retry';
      if (status.type === 'retry') Object.assign(progress, { attempt: status.attempt, message: status.message, next: status.next });
    }
    if (event.type === 'session.error') progress.error = event.properties?.error?.data?.message || event.properties?.error?.name || '上游错误';
    if (part && ['text', 'reasoning'].includes(part.type) && part.text) {
      progress.content = true; progress.status = part.type === 'reasoning' ? 'reasoning' : 'receiving';
    }
    if (event.type === 'message.part.delta' && event.properties?.delta) {
      progress.content = true; progress.status = 'receiving';
    }
    if (['permission.asked', 'permission.updated'].includes(event.type)) progress.status = 'permission';
    if (progress.status) meta.stage = progress.status;
    meta.activity(progress);
  }

  progress(meta, status, extra = {}) {
    meta.stage = status;
    meta.activity?.({ sessionID: meta.sessionID, model: meta.model, type: 'bridge.phase', status, ...extra });
  }

  async reject(permission, message, signal) {
    const result = await this.request(`/permission/${encodeURIComponent(permission.id)}/reply`, 'POST', { reply: 'reject', message }, signal, 5000);
    this.pendingApprovals.delete(permission.id);
    return result;
  }
  // 被拦下的调用名来自事件流；part 还在等审批时参数可能是空的，
  // 这种情况交给 handoffInput() 从审批载荷里补。
  async blockedAction(callID, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const part = this.toolParts.get(callID);
      if (part?.tool) return part;
      await delay(120, undefined, { signal, ref: false }).catch(() => {});
    }
    return { failure: 'no event carried this call ID' };
  }
  async pendingPermissions(sessionID, signal) {
    const cached = () => [...this.pendingApprovals.values()].filter(p => p.sessionID === sessionID);
    let pending;
    try { pending = await this.request('/permission', 'GET', undefined, signal, 5000); }
    catch (error) {
      if (!signal?.aborted) this.log(`Permission monitor query failed: ${error.code || error.name}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`);
      return cached();
    }
    if (!Array.isArray(pending)) { this.log('Permission monitor query failed: non-array response'); return cached(); }
    return pending.filter(p => p.sessionID === sessionID);
  }
  async handoffUsage(sessionID, signal) {
    // 先 abort 让被打断的助手消息收尾，否则会话清理会把它一起删掉、用量就查不到了。
    try {
      const messages = await this.request(`/session/${encodeURIComponent(sessionID)}/message?limit=1`, 'GET', undefined, signal, 5000);
      const info = Array.isArray(messages) ? messages.findLast(m => m.info?.role === 'assistant')?.info : undefined;
      if (info?.tokens) return info.tokens;
    } catch (error) {
      if (!signal?.aborted) this.log(`Usage lookup failed: ${error.code || error.name}`);
    }
    return this.usageBySession.get(sessionID);
  }
  // 一条本机审批的两种归宿：拒绝，或转交给外部客户端。
  // 转交成功时返回 { handoff }，调用方据此结束本轮生成、直接拿它当答案。
  async handlePermission(p, request, signal, rejected, meta) {
    const callID = p.tool?.callID;
    if (callID && rejected.has(callID)) return null;
    if (callID) rejected.add(callID);
    meta.nativeAttempts += 1;
    // 审批载荷逐字保留：OpenCode 的字段名和 SDK 类型并不一致，
    // 挑字段复制会静悄悄丢掉真正有用的那几个。
    if (meta.permissions.length < 5) meta.permissions.push(shrinkPermission(p));
    const action = callID ? await this.blockedAction(callID, signal) : null;
    const native = action?.tool ?? (p.metadata?.command ? 'bash' : null);
    const handoff = native ? buildHandoff({ native, input: handoffInput(action, p), tools: allowedTools(request) }) : null;
    if (!handoff) {
      meta.handoffCheck = { native: native ?? null, offeredTools: request.tools.length, detail: action?.failure ?? 'arguments incomplete for the external schema' };
      // 动作确实存在，只是表达不出来：留给翻译兜底用。
      if (native) meta.handoffMiss = { native, input: handoffInput(action, p), offeredTools: request.tools.length };
    }
    if (handoff) {
      this.progress(meta, 'handoff');
      await this.reject(p, 'This native action is executed by the external client instead.', signal).catch(() => {});
      return { handoff };
    }
    const reason = !callID ? 'the approval request carries no call ID, so it cannot be matched to the external tool list'
      : action ? 'its arguments cannot be mapped onto an external tool schema supplied in this request'
        : 'the call could not be read back from the session';
    // 没有工具 part 时，说清已知的部分，而不是把责任推给"审批种类"。
    const label = native || (p.metadata?.filepath ? `a file operation on ${p.metadata.filepath}` : p.permission || 'native tool');
    // 审批可能已经不在了（会话被中止、重复回复）：绝不能让这次失败的回复把整轮请求带崩。
    await this.reject(p, rejectFeedback(label, reason), signal).catch(() => {});
    return null;
  }

  async models() {
    const result = freeModels(await this.request('/provider'));
    if (!result.length) throw new Error('No free text models found; existing list preserved');
    return result;
  }
  // 给第二个模型的一份有界工作：把材料转成接收方期望的形状。
  // 结果仍由接收方自己的规则裁决，所以"翻译"永远不可能放宽可执行范围；
  // 任何不达标的情况都退回原始错误。
  translate(request, shape, material, meta, blocked, signal) {
    const deadline = AbortSignal.timeout(20000);
    return repair({
      complete: inner => this.complete(inner, signal ? AbortSignal.any([deadline, signal]) : deadline, {
        model: inner.model.id,
        ...(meta.activity ? { activity: progress => {
          if (progress.type !== 'request.done') meta.activity({ sessionID: meta.sessionID, model: meta.model,
            type: 'bridge.repair', status: 'repair', repairModel: inner.model.id, ...(progress.content ? { content: true } : {}) });
        } } : {}),
      }),
      translator: (...args) => {
        const model = this.translator?.(...args);
        this.progress(meta, 'repair', { repairModel: model || null });
        return model;
      }, request: { ...request, tools: allowedTools(request) }, shape, material, blocked, meta, log: this.log,
      validate: shape === 'action'
        ? candidate => {
          const action = validateAction(candidate, allowedTools(request));
          decode(JSON.stringify({ content: '', calls: [action] }), request);
          return action;
        }
        : candidate => decode(JSON.stringify(candidate), request),
    });
  }

  async complete(request, signal, meta = {}) {
    meta.steps = 0; meta.nativeAttempts = 0; meta.permissions = [];
    // 本机工具一律要审批：会话级别的 permission 表就是围栏本身，适配器只会拒绝或转交。
    const session = await this.request('/session', 'POST', { title: 'OC Ferry', permission: Object.entries(nativePermissions).map(([permission, action]) => ({ permission, pattern: '*', action })) }, signal);
    const route = `/session/${encodeURIComponent(session.id)}`;
    meta.sessionID = session.id;
    this.usageBySession.set(session.id, undefined);
    if (typeof meta.activity === 'function') this.active.set(session.id, meta);
    this.watchEvents();
    this.progress(meta, 'waiting');
    const guard = new AbortController();
    const rejected = new Set();
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])]);
    // 审批监视器与推理并行跑：它只负责"拒绝或转交"，
    // 查询失败绝不等于批准，本机动作会一直停在等待状态。
    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.pendingPermissions(session.id, guardSignal);
        for (const p of pending ?? []) {
          if (request.chatOnly) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
          const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
          if (result?.handoff) return result;
        }
        await delay(250, undefined, { signal: guardSignal });
      }
    })();
    let successful = false;
    try {
      const tools = allowedTools(request);
      // 调用数组的 schema 直接由本次请求的工具表生成：模型能选的工具就是客户端给的那些，
      // 一个都不多。choice 为 none 时数组上限归零，模型没有表达动作的余地。
      const callsSchema = { type: 'array', ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === 'required' || request.forced ? { minItems: 1 } : {}),
        ...(tools.length ? { items: { anyOf: tools.map(({ function: tool }) => ({
          type: 'object', properties: { name: { type: 'string', const: tool.name }, arguments: tool.parameters || { type: 'object' } },
          required: ['name', 'arguments'], additionalProperties: false,
        })) } } : { maxItems: 0, items: { type: 'object' } }),
      };
      const payload = {
        model: { providerID: 'opencode', modelID: request.model.id.slice('opencode/'.length) },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? 'oc-ferry-chat' : 'oc-ferry', system: request.chatOnly ? request.system : request.system + '\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.',
        ...(request.chatOnly ? {} : { format: { type: 'json_schema', retryCount: 0, schema: {
          type: 'object', properties: { content: { type: 'string' }, calls: callsSchema },
          required: ['content', 'calls'], additionalProperties: false,
        } } }),
        parts: [{ type: 'text', text: request.text }, ...(request.images ?? [])],
      };
      let actionRetried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        meta.steps += 1;
        this.progress(meta, attempt ? 'correcting' : 'waiting');
        this.usageBySession.set(session.id, undefined);
        const response = await Promise.race([watch, this.request(`${route}/message`, 'POST', payload, signal, null)]);
        this.progress(meta, 'checking');
        let handoff = response?.handoff ?? null;
        if (!handoff) {
          // 收尾这一场竞态：响应落地前一刻冒出来的审批，仍然必须被拒绝或转交，
          // 否则那个工具 part 看起来就像"意外的本机活动"。
          const late = await this.pendingPermissions(session.id, guardSignal);
          for (const p of late ?? []) {
            if (request.chatOnly && p.tool) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
            const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
            if (result?.handoff) { handoff = result.handoff; break; }
          }
        }
        // 转交出去的动作直接成为模型的回答，不再多花一轮上游调用。
        if (handoff) {
          await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
          meta.calls = 1;
          meta.handoff = handoff.name;
          successful = true;
          return completion(request.model.id, { role: 'assistant', content: null,
            tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
              function: { name: handoff.name, arguments: JSON.stringify(handoff.arguments) } }] }, await this.handoffUsage(session.id, signal));
        }
        if (response.info?.error && (request.chatOnly || response.info.error.name !== 'StructuredOutputError')) {
          const error = response.info.error;
          throw new BridgeError(error.data?.message || error.message || error.name || 'Model request failed', error.data?.statusCode || 502, 'model_error');
        }
        // 'invalid' 是 OpenCode 给"参数没解析成功"的调用打的标：它什么都没执行，
        // 所以属于格式那条路（先纠正、再翻译），不算本机活动。
        if (response.parts?.some(p => p.type === 'tool' && (request.chatOnly || !['StructuredOutput', 'invalid'].includes(p.tool)) && !(rejected.has(p.callID) && p.state?.status === 'error'))) throw new BridgeError('Unexpected native tool activity; response rejected', 502, 'native_tool_activity');
        // 信封有三种抵达方式：OpenCode 的结构化字段、本适配器要求的那个已完成的
        // StructuredOutput 调用、以及纯文本。只读第一和第三种曾经把一次正确答案判成格式错误。
        const structuredPart = (response.parts || []).find(p => p.type === 'tool' && p.tool === 'StructuredOutput' && p.state?.status === 'completed' && p.state?.input);
        const envelope = response.info?.structured ?? structuredPart?.state?.input;
        const text = envelope !== undefined ? JSON.stringify(envelope) : (response.parts || []).filter(p => p.type === 'text').map(p => p.text).join('');
        let message;
        try {
          // 被输出上限截断是可以修的：告诉模型一次，它往往能交一份更紧凑的。
          if (response.info?.finish === 'length') throw new BridgeError('Model output was truncated', 502, 'output_truncated');
          if (!text.trim()) {
            // 把真正的原因说出来，然后走和其他读不懂的回复一样的路：
            // 空信封同样值得一次纠正和一次翻译。
            const unparsed = (response.parts || []).find(p => p.type === 'tool' && p.tool === 'invalid');
            if (request.chatOnly) throw new BridgeError('Model returned no text', 502, 'empty_response');
            throw new BridgeError(unparsed
              ? `模型交的调用参数不是合法 JSON：${unparsed.state?.input?.error ?? 'no detail from the runtime'}`
              : '模型没有返回信封：structured、已完成的 StructuredOutput 调用、文本 part 三者都为空', 502, 'invalid_model_output');
          }
          message = request.chatOnly ? { role: 'assistant', content: text } : decode(text, request);
        }
        catch (error) {
          // 一次纠正、一次翻译、一次带诊断的重发：有界，而且只在已经失败的路径上发生。
          // 信封格式错和被输出上限截断都落到这里；"意外的本机活动"永远不落这里。
          if (request.chatOnly || signal?.aborted || !['invalid_model_output', 'invalid_tool_call', 'output_truncated'].includes(error.code)) throw error;
          const cut = error.code === 'output_truncated';
          if (!attempt) {
            payload.parts = [{ type: 'text', text: cut
              ? 'Your previous response was cut off by the output limit before the envelope was complete. Send it again in a much more compact form: content holds the conclusion, calls hold only the essential arguments, and keep reasoning to a minimum.'
              : 'Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal using StructuredOutput with exactly {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.' }];
            continue;
          }
          if (attempt === 1) {
            // 还是读不懂：把材料交给翻译模型。检测路径永远不翻译——
            // 探测必须量的是模型本身，不能量到翻译的功劳。
            if (!meta.probe) {
              const translated = await this.translate(request, 'envelope', rawMaterial(response, request, error), meta, null, signal);
              if (translated) { meta.calls = translated.tool_calls?.length ?? 0; successful = true; return completion(request.model.id, translated, response.info?.tokens); }
              // 什么都推不出来时，让原模型带着"失败原因"再试一轮，而不是让这一轮就这么死掉。
              payload.parts = [{ type: 'text', text: resendPrompt({ error, repair: meta.repaired?.envelope }) }];
              continue;
            }
          }
          throw error;
        }
        // 模型想在本机动手 → 映射表表达不出来 → 它改用文本作答。
        // 这时应该把那个被拦下的动作翻译出来返回，效果和转交一样。
        if (!message.tool_calls?.length && meta.handoffMiss && !meta.probe && !actionRetried) {
          const rescued = await this.translate(request, 'action', rawMaterial(response, request), meta, meta.handoffMiss, signal);
          if (rescued) {
            await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
            meta.calls = 1;
            meta.handoff = rescued.name;
            successful = true;
            return completion(request.model.id, { role: 'assistant', content: null,
              tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
                function: { name: rescued.name, arguments: JSON.stringify(rescued.arguments) } }] }, response.info?.tokens ?? await this.handoffUsage(session.id, signal));
          }
          if (attempt < 2 && !signal?.aborted) {
            actionRetried = true;
            payload.parts = [{ type: 'text', text: resendPrompt({ repair: meta.repaired?.action, blocked: meta.handoffMiss }) }];
            continue;
          }
        }
        meta.calls = message.tool_calls?.length ?? 0;
        successful = true;
        return completion(request.model.id, message, response.info?.tokens);
      }
    } finally {
      guard.abort();
      await watch.catch(() => {});
      this.usageBySession.delete(session.id);
      if (!this.usageBySession.size) this.stopEvents();
      for (const [id, permission] of this.pendingApprovals)
        if (permission.sessionID === session.id) this.pendingApprovals.delete(id);
      if (typeof meta.activity === 'function') {
        meta.activity({ sessionID: session.id, model: meta.model, type: 'request.done' });
        this.active.delete(session.id);
      }
      // 取消要真的停掉后端的工作，不能只是把 HTTP 连接断开。
      if (!successful) await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
      await this.request(route, 'DELETE', undefined, undefined, 5000).catch(e => console.error('Session cleanup failed:', e.code || e.name));
    }
  }
}
