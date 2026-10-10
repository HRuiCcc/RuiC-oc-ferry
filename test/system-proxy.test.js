import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemProxy, parseWindowsProxy } from '../src/system-proxy.js';

const SCUTIL = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}
`;

test('macOS 代理映射成大小写双份环境变量，并绕过本机', () => {
  const env = parseSystemProxy(SCUTIL);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7897');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('HTTPS 是硬要求：只开 HTTP 或只有 SOCKS 都明确报错', () => {
  assert.throws(() => parseSystemProxy('<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.lan\n}\n'),
    /请先在 macOS 中启用 HTTPS 系统代理/);
  assert.throws(() => parseSystemProxy('<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n}\n'),
    /请先在 macOS 中启用 HTTPS 系统代理/);
});

test('只开了 HTTPS 时 HTTP 也走同一个地址', () => {
  const env = parseSystemProxy('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n}\n');
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
});

test('非法主机名与端口不算代理', () => {
  assert.throws(() => parseSystemProxy('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : bad host\n}\n'), /系统代理地址无效/);
  assert.throws(() => parseSystemProxy('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 99999\n  HTTPSProxy : 127.0.0.1\n}\n'), /系统代理地址无效/);
});

test('IPv6 字面量进 URL 时补方括号', () => {
  const env = parseSystemProxy('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : ::1\n}\n');
  assert.equal(env.HTTPS_PROXY, 'http://[::1]:7897');
});

test('Windows 支持统一端口与按协议分开两种写法', () => {
  const shared = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7897' });
  assert.equal(shared.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(shared.HTTPS_PROXY, 'http://127.0.0.1:7897');

  const split = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'http=127.0.0.1:8080;https=127.0.0.1:8443' });
  assert.equal(split.HTTP_PROXY, 'http://127.0.0.1:8080');
  assert.equal(split.HTTPS_PROXY, 'http://127.0.0.1:8443');
});

test('Windows 未启用或地址不合法都明确报错', () => {
  assert.throws(() => parseWindowsProxy({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7897' }), /请先启用 Windows 手动系统代理/);
  assert.throws(() => parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'http://127.0.0.1:7897' }), /Windows 系统代理地址无效/);
  assert.throws(() => parseWindowsProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1' }), /Windows 系统代理端口无效/);
});
