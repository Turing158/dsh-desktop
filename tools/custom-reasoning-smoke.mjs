/** Real DSH boot and the existing model/effort picker in an isolated profile.
 * No provider calls. Run: node tools/custom-reasoning-smoke.mjs
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/custom-reasoning-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/reasoning-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), `
export const inject = ['webServer', 'sessions', 'connection']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/reasoning-smoke/checkpoint', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const { sessionId } = JSON.parse(Buffer.concat(chunks).toString())
      const session = ctx.sessions.get(sessionId)
      if (!session) throw Error('Fixture session is not loaded')
      await ctx.sessions.flush(session)
      res.end('OK')
    } catch (error) { res.statusCode = 500; res.end(String(error)) }
  } }, 'reasoning fixture checkpoint'))
}
`)
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/reasoning-smoke',
  factory: () => ({ inject: ['sessions', 'workspaces', 'uiWorkspace', 'modelDirectories'],
    apply(ctx) { window.__REASONING_SMOKE__ = ctx } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + `\n- id: llm-pi-ai
  config:
    providers:
      smoke-custom:
        displayName: Custom reasoning smoke
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        apiKeyEnv: DSH_REASONING_SMOKE_KEY
        models:
          - id: custom-model
            name: Smoke Model
- insert:
    - id: desktop-reasoning-smoke
      name: ${pathToFileURL(join(probe, 'index.js')).href}
`
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
let child, browser, page, output = ''
const errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function start() {
  output = ''
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_REASONING_SMOKE_KEY: 'mock-key' },
  })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 300; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) break
    await sleep(100)
  }
  throw Error('DSH did not start: ' + output.slice(-5000))
}
function stop() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch (error) {
    try { process.kill(pid, 0) } catch (probe) {
      if (probe.code === 'ESRCH') { child = undefined; return }
    }
    throw error
  }
  child = undefined
}
async function ready(url, onboarding = false) {
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__REASONING_SMOKE__), undefined, { timeout: 40000 })
  await page.waitForFunction(() => window.__REASONING_SMOKE__.sessions.list.getSnapshot().phase === 'ready')
  if (onboarding) await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('button')) {
        if (['继续', '我知道了', '稍后配置'].includes(button.textContent.trim())) button.click()
      }
    })
    await sleep(150)
  }
}
try {
  const url = await start()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', error => errors.push(error.message))
  await ready(url, true)
  const sessionId = await page.evaluate(async root => {
    const ctx = window.__REASONING_SMOKE__
    const work = await ctx.workspaces.create({ path: root })
    const id = await ctx.sessions.create({ workspaceId: work.workspaceId })
    await ctx.uiWorkspace.openSession(id)
    const directory = ctx.modelDirectories.directoryFor(id)
    await directory.load()
    const result = await directory.select({ provider: 'smoke-custom', model: 'custom-model' })
    if (!result.ok) throw Error(JSON.stringify(result.error))
    return id
  }, root)
  const trigger = () => page.getByRole('button', { name: /Smoke Model/ })
  assert.match(await trigger().textContent(), /High/)
  await trigger().click()
  await page.getByRole('menuitem', { name: /推理等级/ }).click()
  const options = await page.getByRole('menuitemradio').allTextContents()
  const expectedOptions = ['Off', 'Low', 'Medium', 'High', 'Xhigh', 'Max']
  assert.deepEqual(options.map(text => text.trim()), expectedOptions)
  await page.screenshot({ path: join(root, 'effort-menu.png') })
  await page.getByRole('menuitemradio', { name: 'Medium', exact: true }).click()
  await page.waitForFunction(id => {
    const state = window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.getSnapshot()
    return state.status === 'ready' && state.pending === null && state.current?.reasoningEffort === 'medium'
  }, sessionId)
  assert.match(await trigger().textContent(), /Medium/)
  await trigger().click()
  await page.getByRole('menuitem', { name: /推理等级/ }).click()
  await page.getByRole('menuitemradio', { name: 'Xhigh', exact: true }).click()
  // Await the completed selection before checkpointing the isolated host.
  await page.waitForFunction(id => {
    const state = window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.getSnapshot()
    return state.status === 'ready' && state.pending === null && state.current?.reasoningEffort === 'xhigh'
  }, sessionId)
  assert.match(await trigger().textContent(), /Xhigh/)
  // taskkill bypasses the app's normal shutdown flush; explicitly checkpoint
  // the real Session log before testing restoration in a fresh host process.
  await page.evaluate(async sessionId => {
    const response = await fetch('/reasoning-smoke/checkpoint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })
    if (!response.ok) throw Error(await response.text())
  }, sessionId)
  await writeFile(join(root, 'first-host.log'), output)
  stop()
  await ready(await start())
  await page.waitForFunction(id => Boolean(window.__REASONING_SMOKE__.sessions.list.getSnapshot().byId[id]), sessionId)
  await page.evaluate(id => window.__REASONING_SMOKE__.uiWorkspace.openSession(id), sessionId)
  await page.waitForFunction(id => window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.getSnapshot().current?.reasoningEffort === 'xhigh', sessionId)
  assert.match(await trigger().textContent(), /Xhigh/)
  await trigger().click()
  await page.getByRole('menuitem', { name: /推理等级/ }).click()
  assert.deepEqual((await page.getByRole('menuitemradio').allTextContents()).map(text => text.trim()), expectedOptions)
  await page.screenshot({ path: join(root, 'effort-menu-restored.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: custom model offers six effort levels; Medium and Xhigh select correctly, Xhigh survives host restart')
  console.log('Evidence: ' + root)
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
    await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally {
  await writeFile(join(root, 'host.log'), output)
  if (browser) await browser.close()
  stop()
}
