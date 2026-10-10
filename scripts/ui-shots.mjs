// 界面验证台架：把一份真实 status.json 喂给控制面板，出浅色/深色截图。
// 不启动 Electron：开一个 127.0.0.1 静态服务 + 注入 window.ferry 桩。
// 用法：node scripts/ui-shots.mjs [面板目录] [输出目录] [状态文件]
// 需要先装 playwright：`npm i -D playwright`（脚本从这里 import）。
import { chromium } from "playwright";
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.argv[2] ?? new URL('../desktop/', import.meta.url).pathname
const OUT = process.argv[3] ?? '/tmp/oc-ferry-shots'
const STATE_FILE = process.argv[4] ?? new URL('../docs/示例状态.json', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })

// 真实状态做底：把 e2e 跑出来的结果当素材，截图才不是空壳。
const real = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
const state = { ...real, phase: 'ready', actionBusy: false }
state.message = state.message || `运行中 · ${state.models.length} 个免费模型`
// 详情区要用到"拦截过的调用"这类观察值，补一条进去让截图能体现。
const first = Object.keys(state.modelResults || {})[0]
if (first) state.modelResults[first] = { ...state.modelResults[first], calls: 1, nativeAttempts: 1, handoff: 'Read' }

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.cjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = http.createServer((req, res) => {
  const file = path.join(DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404); return res.end('nope') }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
async function shot(name, { theme = 'light', width = 1040, height = 740, patch = {}, selected = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.addInitScript(({ state, patch }) => {
    const merged = { ...state, ...patch }
    window.__state = merged
    window.ferry = {
      action: async (name, value) => { window.__actions = [...(window.__actions ?? []), { name, value }]; return { ok: true, result: {} } },
      onState: callback => { window.__pushState = callback; callback(merged) },
      onDismiss: callback => { window.__dismiss = callback },
    }
  }, { state, patch })
  await page.goto(`${base}/index.html`, { waitUntil: 'load' })
  await page.waitForTimeout(500)
  if (selected) await page.evaluate(id => document.querySelector(`[data-model="${id}"]`)?.click(), selected)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  const text = await page.evaluate(() => document.body.innerText)
  fs.writeFileSync(`${OUT}/${name}.txt`, text)
  console.log(`${errors.length ? '✖' : '✓'} ${name} ${theme} ${width}x${height} ${errors.length ? errors.slice(0, 3).join(' | ') : ''}`)
  await ctx.close()
}

await shot('01-light-ready', { theme: 'light' })
await shot('02-dark-ready', { theme: 'dark' })
const active = ['opencode/mimo-v2.6-flash-free', 'opencode/step-5-preview-free', 'opencode/nemotron-3.5-lightning-free']
await shot('03-light-probing', { theme: 'light', patch: { probe: { running: true, current: active[0], active, pending: [...active, 'opencode/space-bunny-free'] }, activity: [{ model: 'opencode/big-pickle', status: 'receiving', waitedMs: 12400, sinceContentMs: 800 }], actionBusy: 'probe' }, selected: active[1] })
await shot('04-light-error', { theme: 'light', patch: { phase: 'error', message: '读取失败：OpenCode 服务退出，请重启代理' } })
await shot('05-dark-wide', { theme: 'dark', width: 1280, height: 800 })
await browser.close()
server.close()
