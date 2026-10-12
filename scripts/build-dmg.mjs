// 把已构建、已签名的 .app 打成 macOS 安装包（DMG）。
//
// 为什么不用 electron-builder 自己的 dmg target：签名与压缩在本仓库里是
// build-mac.mjs 自己确定性地做完的（ad-hoc 签名，见那个文件顶部的说明）。
// electron-builder 的 dmg target 会另起一份组装好的、未签名的 .app 打进镜像，
// 于是「发出去的安装包里是哪个包」就不由我们控制了。这里直接拿 release/ 里
// 那份已签名、已深度校验过的 .app 来打，装的包和 zip 里的是同一个。
//
// 两段式：先做一个可写盘（UDRW），摆好窗口背景、图标位置与卷图标，再压成
// UDZO 分发。全程只用系统自带工具：hdiutil / SetFile / osascript。
//
// 用法：
//   npm run build:dmg        # 复用 release/mac-arm64/OC Ferry.app，几秒钟出一个 dmg
//
// 两个已经踩过的坑（改这个文件时别踩回去）：
//   1. 挂载点必须从 `hdiutil attach` 的输出里取真实路径 —— 同名卷还占着时系统
//      会把新镜像挂成「<卷名> 1」，照卷名拼路径写就会全写进旧卷，日志每一步
//      「成功」但最终镜像永远是上一版。
//   2. 卷图标（.VolumeIcon.icns + SetFile -a C）必须放在 Finder 摆布局之后写 ——
//      Finder 改窗口布局时会顺手删掉卷根目录下的这个文件。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const root = path.join(import.meta.dirname, '..');
const release = path.join(root, 'release');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const app = path.join(release, 'mac-arm64', 'OC Ferry.app');
const dmg = path.join(release, `OC-Ferry-${version}-mac-arm64.dmg`);
const background = path.join(root, 'scripts', 'dmg-background.png');
const volname = `OC Ferry ${version}`;

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

if (process.platform !== 'darwin') {
  console.error('✗ DMG 只能在 macOS 上打');
  process.exit(1);
}
if (!(await exists(app))) {
  console.error(`✗ 找不到 ${path.relative(root, app)}：先跑 npm run build:mac（或 npm run build:mac 的 mac 步骤）`);
  process.exit(1);
}

console.log('① 校验待打包的 .app…');
await run('codesign', ['--verify', '--deep', '--strict', app]);
console.log('   ad-hoc 签名深度严格校验通过');

// ── 装配卷里的内容 ──────────────────────────────────────────────
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ferry-dmg-'));
await run('ditto', [app, path.join(stage, 'OC Ferry.app')]);
await fs.symlink('/Applications', path.join(stage, '应用程序'));

if (await exists(background)) {
  await fs.mkdir(path.join(stage, '.background'), { recursive: true });
  await fs.copyFile(background, path.join(stage, '.background', 'dmg-bg.png'));
}

// 卷里留一份简短说明：用户不用为了「装完怎么用」去翻 README
await fs.writeFile(
  path.join(stage, '安装说明.txt'),
  `OC Ferry ${version} —— 安装

1. 把左边的「OC Ferry」拖到右边的「应用程序」里。
2. 到「启动台 / 应用程序」双击 OC Ferry。首次启动会自己准备运行环境
   （下载一次 OpenCode，再逐个检测免费模型），窗口里能看到进度。

首次打开如果被 macOS 拦下（提示“无法验证开发者”）：
    在「访达」里右键点 OC Ferry →「打开」→ 再点「打开」；
    或者执行一次：
    xattr -dr com.apple.quarantine "/Applications/OC Ferry.app"

它做什么：在数据目录里放一份隔离的 OpenCode，按价格筛出免费模型、逐个检测
它们能不能按 WorkBuddy 的工具协议干活，把通过的写进你的 models.json，再起一个
只监听本机的转发口供 WorkBuddy 调用。执行权始终在 WorkBuddy 手里。

注意：
- 使用前请先安装 WorkBuddy。
- 关窗口 ≠ 退出：它继续在托盘跑；从托盘退出时会摘掉自己导入的条目（保留你手写的）。
- 数据目录：~/Library/Application Support/OC Ferry
`,
  'utf8',
);

// ── 两段式打盘 ─────────────────────────────────────────────────
const mountPoint = path.join('/Volumes', volname);
const tmpDmg = path.join(release, 'oc-ferry-rw.dmg');

async function detachIfPresent(target) {
  if (!(await exists(target))) return true;
  console.log(`   发现 ${target} 还挂着，先卸掉`);
  for (const args of [['detach', target, '-quiet'], ['detach', target, '-force', '-quiet']]) {
    await run('hdiutil', args).catch(() => {});
    if (!(await exists(target))) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return !(await exists(target));
}

if (!(await detachIfPresent(mountPoint))) {
  console.error(`✗ 卸载不掉 ${mountPoint}：请手动处理后再打包`);
  process.exit(1);
}
await fs.rm(dmg, { force: true });
await fs.rm(tmpDmg, { force: true });

console.log('② 制作可写盘…');
await run('hdiutil', ['create', '-volname', volname, '-srcfolder', stage, '-ov', '-format', 'UDRW', '-fs', 'HFS+', tmpDmg], {
  maxBuffer: 32 * 1024 * 1024,
});

let mountDir = null;
try {
  const { stdout } = await run('hdiutil', ['attach', tmpDmg, '-nobrowse', '-noautoopen']);
  mountDir = stdout
    .split('\n')
    .map(line => line.match(/(\/Volumes\/.+)$/)?.[1])
    .filter(Boolean)
    .pop() ?? null;
  if (mountDir && mountDir !== mountPoint) {
    console.log(`   注意：实际挂载点是 ${mountDir}（不是按卷名拼的路径），按真实挂载点操作`);
  }
  if (mountDir && !(await exists(mountDir))) mountDir = null;
} catch (error) {
  console.warn(`   可写盘没能挂载：${error.message ?? error}`);
}

// Finder 窗口摆位：背景、图标位置、窗口大小。
// 没有自动化权限时整体跳过 —— 图标退回默认排布，包照样能装。
let layoutApplied = false;
if (mountDir) {
  console.log('③ Finder 摆位（背景图 / 图标位置）…');
  try {
    // 给 Finder 遥控加个上限：万一弹了自动化授权框而没人点，不能让打包挂在这里
    await run('osascript', ['-e', `
tell application "Finder"
  tell disk "${volname}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {220, 160, 860, 560}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 104
    try
      set background picture of opts to file ".background:dmg-bg.png"
    end try
    try
      set position of item "OC Ferry.app" of container window to {150, 180}
    end try
    try
      set position of item "应用程序" of container window to {470, 180}
    end try
    try
      set position of item "安装说明.txt" of container window to {310, 300}
    end try
    update without registering applications
    delay 1
    close
  end tell
end tell
`], { timeout: 120_000 });
    layoutApplied = true;
  } catch {
    console.log('   （没有 Finder 自动化权限，跳过：图标用默认排布，安装包依然可用）');
  }
}

// 卷图标：icns 放卷根目录 + 打上「自定义图标」标记。
// 顺序很关键：必须放在 Finder 摆布局之后（见文件顶部坑 2）。
if (mountDir && await exists(path.join(app, 'Contents', 'Resources', 'icon.icns'))) {
  try {
    await fs.copyFile(path.join(app, 'Contents', 'Resources', 'icon.icns'), path.join(mountDir, '.VolumeIcon.icns'));
    await run('SetFile', ['-a', 'V', path.join(mountDir, '.VolumeIcon.icns')]).catch(() => {});
    await run('SetFile', ['-a', 'C', mountDir]).catch(() => {});
    console.log('④ 卷图标已设置');
  } catch {
    console.log('   （卷图标没写上，不影响安装）');
  }
}

// 卸卷：Finder 可能还攥着句柄，多留一拍让元数据落盘再 detach
if (mountDir) {
  await run('sync').catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 2000));
  let detached = false;
  for (let i = 0; i < 5 && !detached; i += 1) {
    for (const args of [['detach', mountDir, '-quiet'], ['detach', mountDir, '-force', '-quiet']]) {
      await run('hdiutil', args).catch(() => {});
      if (!(await exists(mountDir))) { detached = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  if (!detached) {
    console.error(`✗ 临时镜像没能卸载，先手动 hdiutil detach "${mountDir}" 再重跑`);
    process.exit(1);
  }
}

console.log('⑤ 压缩成 UDZO…');
await run('hdiutil', ['convert', tmpDmg, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', dmg], {
  maxBuffer: 32 * 1024 * 1024,
});
await fs.rm(tmpDmg, { force: true });
await fs.rm(stage, { recursive: true, force: true });

const { stdout: digest } = await run('shasum', ['-a', '256', dmg]);
const { stdout: size } = await run('du', ['-h', dmg]);
console.log(`✓ ${path.relative(root, dmg)} · ${size.trim().split(/\s+/)[0]}${layoutApplied ? '' : '（图标默认排布）'}`);
console.log(`  sha256 ${digest.trim().split(/\s+/)[0]}`);
console.log('  未公证：装完首次打开需右键 →「打开」（卷里 安装说明.txt 也写了）');
