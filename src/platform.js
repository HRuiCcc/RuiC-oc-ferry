import os from 'node:os';
import path from 'node:path';

// 数据目录按系统惯例落位：macOS 走 Application Support，Windows 走 APPDATA，
// 其余走 XDG。目录名与本产品的应用标识一致，避免和别的工具挤在同一个文件夹里。
export function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'OC Ferry');
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'OC Ferry');
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'OC Ferry');
}

// OpenCode 的官方 npm 包按平台/架构分开发布，二进制名在 Windows 上带 .exe。
export function runtimePackage(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch))
    throw new Error(`不支持的系统或架构：${platform}/${arch}`);
  return { name: `opencode-${platform === 'win32' ? 'windows' : platform}-${arch}`, binary: platform === 'win32' ? 'opencode.exe' : 'opencode' };
}
