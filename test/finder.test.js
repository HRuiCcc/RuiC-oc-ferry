import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listenService } from '../src/service-instance.js';
import { finderAgent, validateFoundConfig, windowsSearchRoots, searchConfig } from '../src/config-finder.js';

test('端口被占用时给出可读的提示，占用期间返回 503', async () => {
  const first = await listenService(0);
  const port = first.address().port;
  const body = await new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
  });
  assert.equal(body.status, 503);
  assert.match(body.text, /OC Ferry 正在启动/);

  await assert.rejects(listenService(port), /端口 \d+ 已被占用，OC Ferry 可能已在运行/);
  await new Promise(resolve => first.close(resolve));
});

test('配置查找的 agent 只允许只读搜索', () => {
  assert.equal(finderAgent.permission.glob, 'allow');
  assert.equal(finderAgent.permission.list, 'allow');
  assert.equal(finderAgent.permission['*'], 'ask');
  assert.equal(finderAgent.permission.websearch, 'deny');
  assert.equal(finderAgent.permission.task, 'deny');
  assert.match(finderAgent.prompt, /Never read file contents/);
});

test('发现的配置文件必须是有效 models.json，且能认出属于 WorkBuddy', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-find-'));
  // 目录名不是 .workbuddy，但里面有自定义模型条目 → 认可
  const owned = path.join(dir, 'moved', 'models.json');
  await fs.mkdir(path.dirname(owned), { recursive: true });
  await fs.writeFile(owned, JSON.stringify([{ id: 'x', vendor: 'Custom', url: 'http://x', apiKey: 'k' }]));
  assert.equal(await validateFoundConfig(owned), owned);

  // 空数组且目录名也不像 WorkBuddy → 拒绝
  const stranger = path.join(dir, 'other', 'models.json');
  await fs.mkdir(path.dirname(stranger), { recursive: true });
  await fs.writeFile(stranger, '[]');
  await assert.rejects(validateFoundConfig(stranger), /无法确认此文件属于 WorkBuddy/);

  // 目录名是 .workbuddy → 认可
  const named = path.join(dir, '.workbuddy', 'models.json');
  await fs.mkdir(path.dirname(named), { recursive: true });
  await fs.writeFile(named, '[]');
  assert.equal(await validateFoundConfig(named), named);
  await fs.rm(dir, { recursive: true, force: true });
});

test('查找：只接纳真的执行过 glob 的路径，并按校验前的访问时间排序', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-search-'));
  const older = path.join(dir, 'a', '.workbuddy', 'models.json');
  const newer = path.join(dir, 'b', '.workbuddy', 'models.json');
  for (const file of [older, newer]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '[]');
  }
  // 让 newer 的访问时间更新（睡眠保证时间戳可分辨）
  await new Promise(resolve => setTimeout(resolve, 20));
  await fs.readFile(newer);
  await fs.utimes(newer, new Date(), new Date(Date.now() - 100000));

  const routes = [];
  const backend = {
    async request(route, method, body, signal, timeout) {
      routes.push(`${method} ${route}`);
      if (route === '/session' && method === 'POST') return { id: 'ses_1' };
      if (route === '/permission') return [];
      if (route.endsWith('/message') && method === 'POST') return { info: {} };
      if (route.endsWith('/message')) return [
        { parts: [{ type: 'tool', tool: 'glob', state: { status: 'completed', input: { path: dir }, output: `${older}\n${newer}` } }] },
      ];
      return {};
    },
  };
  const result = await searchConfig(backend, [{ id: 'opencode/big-pickle', name: 'Big Pickle', toolcall: true }], [dir], undefined);
  assert.equal(result.candidates.length, 2);
  // 会话用完就删，不留在 OpenCode 里
  assert.ok(routes.includes('DELETE /session/ses_1'));

  // 模型正文里编出来的路径不算证据
  const invented = {
    async request(route, method) {
      if (route === '/session' && method === 'POST') return { id: 'ses_2' };
      if (route === '/permission') return [];
      if (route.endsWith('/message') && method === 'POST') return { info: {} };
      if (route.endsWith('/message')) return [{ parts: [{ type: 'text', text: `/somewhere/.workbuddy/models.json` }] }];
      return {};
    },
  };
  const empty = await searchConfig(invented, [{ id: 'opencode/big-pickle', name: 'Big Pickle', toolcall: true }], [path.join(dir, 'empty')], undefined);
  assert.deepEqual(empty.candidates, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Windows 搜索根包含用户目录与存在的盘符', async () => {
  const roots = await windowsSearchRoots('/Users/me', { APPDATA: '/Users/me/AppData', LOCALAPPDATA: '/Users/me/Local' });
  assert.ok(roots.includes('/Users/me'));
  assert.ok(roots.includes('/Users/me/AppData'));
  assert.ok(roots.includes('/Users/me/Local'));
});
