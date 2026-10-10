import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// macOS 的 scutil --proxy 输出是 `键 : 值` 的纯文本；Windows 走注册表。
// 两边都只认手动配置的 HTTP/HTTPS 代理：PAC 与 SOCKS 拿不到可用的转发口，直接报错，
// 而不是猜一个地址去连。
function entriesFromScutil(text) {
  const value = name => text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
  function address(kind) {
    if (value(`${kind}Enable`) !== '1') return undefined;
    const host = value(`${kind}Proxy`), port = Number(value(`${kind}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('系统代理地址无效');
    // IPv6 字面量进 URL 必须加方括号，否则被当成端口分隔符。
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  }
  const http = address('HTTP'), https = address('HTTPS');
  if (!https) throw new Error('请先在 macOS 中启用 HTTPS 系统代理；暂不支持仅 SOCKS 或 PAC 配置');
  return proxyEnvironment(http || https, https);
}

function proxyEnvironment(http, https) {
  return {
    HTTP_PROXY: http, HTTPS_PROXY: https, http_proxy: http, https_proxy: https,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
  };
}

export function parseSystemProxy(text) {
  return entriesFromScutil(text);
}

// Windows 的 ProxyServer 有两种写法：`host:port`，或 `http=host:port;https=host:port`。
// 缺哪一项就退到另一项，两项都缺才算没有代理。
export function parseWindowsProxy(settings) {
  if (!Number(settings.ProxyEnable) || !settings.ProxyServer)
    throw new Error('请先启用 Windows 手动系统代理；暂不支持仅 PAC 配置');
  const entries = String(settings.ProxyServer).trim().split(';').filter(Boolean);
  const split = entries.some(x => x.includes('='));
  const map = split ? Object.fromEntries(entries.map(x => x.trim().split('='))) : { http: entries[0], https: entries[0] };
  const address = value => {
    if (!value || /[\s/@?#]/.test(value)) throw new Error('Windows 系统代理地址无效');
    let url;
    try { url = new URL('http://' + value); } catch { throw new Error('Windows 系统代理地址无效'); }
    const port = Number(value.match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Windows 系统代理端口无效');
    return url.origin;
  };
  const https = address(map.https || map.http), http = address(map.http || map.https);
  return proxyEnvironment(http, https);
}

// 关掉代理时只下发绕过本机服务的 NO_PROXY：本机的 OpenCode 与转发口绝不能走代理出去。
export async function systemProxyEnvironment(enabled) {
  if (!enabled) return { NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
  if (process.platform === 'win32') {
    const script = "Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress";
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true });
    return parseWindowsProxy(JSON.parse(result.stdout));
  }
  if (process.platform !== 'darwin') throw new Error('此系统暂不支持读取系统代理');
  return parseSystemProxy((await exec('/usr/sbin/scutil', ['--proxy'], { timeout: 5000 })).stdout);
}
