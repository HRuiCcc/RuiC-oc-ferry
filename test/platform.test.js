import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataDirectory, runtimePackage } from '../src/platform.js';

test('三种系统的数据目录各自落位', () => {
  assert.equal(dataDirectory('darwin', {}, '/Users/me'), '/Users/me/Library/Application Support/OC Ferry');
  assert.equal(dataDirectory('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me'), 'C:\\Users\\me\\AppData\\Roaming\\OC Ferry');
  assert.equal(dataDirectory('win32', {}, 'C:\\Users\\me'), 'C:\\Users\\me\\AppData\\Roaming\\OC Ferry');
  assert.equal(dataDirectory('linux', {}, '/home/me'), '/home/me/.config/OC Ferry');
  assert.equal(dataDirectory('linux', { XDG_CONFIG_HOME: '/home/me/cfg' }, '/home/me'), '/home/me/cfg/OC Ferry');
});

test('运行时包名与二进制名按平台区分，未知平台直接报错', () => {
  assert.deepEqual(runtimePackage('darwin', 'arm64'), { name: 'opencode-darwin-arm64', binary: 'opencode' });
  assert.deepEqual(runtimePackage('win32', 'x64'), { name: 'opencode-windows-x64', binary: 'opencode.exe' });
  assert.deepEqual(runtimePackage('linux', 'x64'), { name: 'opencode-linux-x64', binary: 'opencode' });
  assert.throws(() => runtimePackage('freebsd', 'x64'), /不支持的系统或架构/);
  assert.throws(() => runtimePackage('darwin', 'ia32'), /不支持的系统或架构/);
});
