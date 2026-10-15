/** Real DSH boot, reasoning selector/slider, themes and persistence in an isolated profile.
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
  factory: () => ({ inject: ['sessions', 'workspaces', 'uiWorkspace', 'modelDirectories', 'configForms', 'theme', 'remote', 'remote.session'],
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
          - id: other-model
            name: Other Model
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
  page.on('pageerror', error => errors.push(error.stack?.replace(/http:\/\/[^\s)]+(?=:\d+:\d+)/g, '<bundle>') ?? error.message))
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
  const trigger = () => page.locator('[data-slot="conversation.input.model"] button[aria-haspopup="menu"]')
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
  const slider = () => page.getByRole('slider', { name: '推理等级', exact: true })
  async function openPanel() {
    await trigger().click()
    await slider().waitFor()
  }
  async function expectEffort(effort) {
    await page.waitForFunction(({ sessionId, effort }) => {
      const state = window.__REASONING_SMOKE__.modelDirectories.directoryFor(sessionId).store.getSnapshot()
      return state.current?.reasoningEffort === effort && !state.pending
    }, { sessionId, effort })
  }
  // The composer keeps its original model trigger with no extra control.
  assert.equal(await page.locator('[data-composer-card] .dshReasoning').count(), 0)
  await page.evaluate(() => document.querySelector('button[aria-haspopup="dialog"]').click())
  await page.getByRole('button', { name: '外观', exact: true }).click()
  const styleGroup = page.getByRole('group', { name: '推理等级控件', exact: true })
  await styleGroup.getByRole('button', { name: '滑块', exact: true }).click()
  await page.waitForFunction(() => window.__REASONING_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.reasoningControl === 'slider')
  assert.equal(await styleGroup.getByRole('button', { name: '滑块', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.screenshot({ path: join(root, 'reasoning-appearance.png') })
  await page.keyboard.press('Escape')
  await openPanel()
  await slider().waitFor()
  assert.equal(await page.getByRole('menuitem', { name: /推理等级/ }).count(), 0, 'slider is already in the root model menu')
  const panelWidth = (await page.locator('[data-dsh-reasoning-slider]').boundingBox()).width
  assert.ok(panelWidth >= 245 && panelWidth <= 255, 'the inline panel stays compact at 250px')
  assert.equal(await slider().inputValue(), '2')
  assert.equal(await slider().getAttribute('max'), '5')
  assert.deepEqual(await page.locator('.dshReasoning__labels > span').allTextContents(), expectedOptions)
  assert.equal(await page.getByRole('menuitemradio').count(), 0, 'there is no separate effort list in slider mode')
  await slider().focus()
  await page.keyboard.press('ArrowRight')
  await expectEffort('high')
  assert.equal(await slider().isVisible(), true, 'keyboard commits keep the panel open')
  await slider().focus()
  await page.keyboard.press('End')
  await expectEffort('max')
  assert.equal(await slider().isVisible(), true)
  await slider().waitFor()
  const bounds = await slider().boundingBox()
  await page.mouse.move(bounds.x + bounds.width - 10, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2, { steps: 8 })
  assert.equal(await slider().getAttribute('aria-valuetext'), 'Off')
  assert.equal(await page.evaluate(id => window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.getSnapshot().current.reasoningEffort, sessionId), 'max', 'drag previews must not save before release')
  // Settings acknowledgements can refresh the catalog during an active drag.
  // Known model levels must remain usable while that refresh is loading.
  await page.evaluate(id => {
    window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.update(state => { state.status = 'loading' })
  }, sessionId)
  await page.mouse.up()
  await expectEffort('off')
  assert.equal(await slider().isVisible(), true, 'dragging commits without closing the menu')
  await slider().waitFor()
  // A refused write leaves the current value intact and allows a retry.
  await page.evaluate(id => {
    const directory = window.__REASONING_SMOKE__.modelDirectories.directoryFor(id)
    const select = directory.select
    directory.select = async function () {
      directory.select = select
      return { ok: false, error: { code: 'session/writer-held', message: 'Fixture refusal' } }
    }
  }, sessionId)
  await slider().focus()
  await page.keyboard.press('ArrowRight')
  await page.getByRole('alert').filter({ hasText: '推理等级保存失败，请重试。' }).waitFor()
  await expectEffort('off')
  await page.waitForFunction(() => document.querySelector('.dshReasoning input').value === '0')
  await page.keyboard.press('ArrowRight')
  await expectEffort('low')
  await page.waitForFunction(() => document.querySelector('.dshReasoning__error').hidden)
  await page.keyboard.press('ArrowRight')
  await expectEffort('medium')
  await page.keyboard.press('ArrowRight')
  await expectEffort('high')
  const colors = []
  for (const scheme of ['light', 'dark']) {
    await page.evaluate(scheme => window.__REASONING_SMOKE__.theme.setTheme(scheme), scheme)
    await page.waitForFunction(scheme => document.body.hasAttribute('data-ds-dark-theme') === (scheme === 'dark'), scheme)
    colors.push(await page.locator('.dshReasoning').evaluate(el => ({ text: getComputedStyle(el).color,
      accent: getComputedStyle(el).getPropertyValue('--dsw-alias-brand-primary').trim() })))
    await page.screenshot({ path: join(root, 'reasoning-' + scheme + '.png') })
    await page.locator('[data-dsh-reasoning-slider]').screenshot({ path: join(root, 'reasoning-panel-' + scheme + '.png') })
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForFunction(() => {
        const rect = document.querySelector('.dshReasoning input').getBoundingClientRect()
        return rect.x >= 0 && rect.right <= window.innerWidth
      })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no horizontal overflow at ' + width)
      if (width === 375) await page.screenshot({ path: join(root, 'reasoning-' + scheme + '-mobile.png') })
    }
  }
  assert.notDeepEqual(colors[0], colors[1], 'slider colors follow the current theme')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await slider().evaluate(el => getComputedStyle(el, '::-webkit-slider-thumb').transitionDuration), '0s')
  // The model row still opens its native list and Escape returns to the panel.
  await page.locator('[data-dsh-reasoning-model]').click()
  await page.getByRole('menuitemradio', { name: /Smoke Model/ }).waitFor()
  assert.equal(await slider().count(), 0)
  await page.keyboard.press('Escape')
  await slider().waitFor()
  // Changing models rebuilds the panel from that model's current directory.
  await page.locator('[data-dsh-reasoning-model]').click()
  await page.getByRole('menuitemradio', { name: /Other Model/ }).click()
  await page.waitForFunction(id => window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.getSnapshot().current?.model === 'other-model', sessionId)
  await openPanel()
  assert.equal(await slider().getAttribute('aria-valuetext'), 'High')
  await page.locator('[data-dsh-reasoning-model]').click()
  await page.getByRole('menuitemradio', { name: /Smoke Model/ }).click()
  await page.waitForFunction(id => window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.getSnapshot().current?.model === 'custom-model', sessionId)
  await openPanel()
  // A different main-view session owns its own reasoning selection.
  const otherSession = await page.evaluate(async root => {
    const ctx = window.__REASONING_SMOKE__
    const work = await ctx.workspaces.create({ path: root })
    const id = await ctx.sessions.create({ workspaceId: work.workspaceId })
    await ctx.uiWorkspace.openSession(id)
    const directory = ctx.modelDirectories.directoryFor(id)
    await directory.load()
    const result = await directory.select({ provider: 'smoke-custom', model: 'other-model', reasoningEffort: 'low' })
    if (!result.ok) throw Error('Could not set up another session')
    return id
  }, root)
  await page.waitForFunction(() => !document.querySelector('.dshReasoning'))
  await openPanel()
  assert.equal(await slider().getAttribute('aria-valuetext'), 'Low')
  await slider().focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(id => {
    const state = window.__REASONING_SMOKE__.modelDirectories.directoryFor(id).store.getSnapshot()
    return state.current?.reasoningEffort === 'medium' && !state.pending
  }, otherSession)
  await page.evaluate(id => window.__REASONING_SMOKE__.uiWorkspace.openSession(id), sessionId)
  await page.waitForFunction(() => !document.querySelector('.dshReasoning'))
  await openPanel()
  await expectEffort('high')
  assert.equal(await slider().getAttribute('aria-valuetext'), 'High')
  // Tab and arrow navigation reach the slider without drilling into another pane.
  await page.locator('[data-dsh-reasoning-model]').focus()
  await page.keyboard.press('Tab')
  assert.equal(await slider().evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.locator('[data-dsh-reasoning-model]').evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('ArrowDown')
  assert.equal(await slider().evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => !document.querySelector('.dshReasoning'))
  await openPanel()
  await slider().focus()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.dshReasoning'))
  assert.equal(await trigger().evaluate(el => el === document.activeElement), true)
  await openPanel()
  // Switching style restores the original root row and its second-level list.
  await page.evaluate(() => window.__REASONING_SMOKE__.configForms.get('desktop-appearance').set('reasoningControl', 'select'))
  await page.getByRole('menuitem', { name: /推理等级/ }).click()
  await page.getByRole('menuitemradio', { name: 'Off', exact: true }).waitFor()
  assert.equal(await slider().count(), 0)
  assert.deepEqual((await page.getByRole('menuitemradio').allTextContents()).map(text => text.trim()), expectedOptions)
  assert.equal(await page.getByRole('menuitemradio', { name: 'High', exact: true }).getAttribute('aria-checked'), 'true')
  await page.getByRole('menuitemradio', { name: 'Xhigh', exact: true }).click()
  await expectEffort('xhigh')
  await page.evaluate(() => window.__REASONING_SMOKE__.configForms.get('desktop-appearance').set('reasoningControl', 'slider'))
  console.log('PASS: inline slider, native model/list navigation, keyboard, drag, failed-save recovery, themes and four widths')
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
  await openPanel()
  assert.equal(await slider().getAttribute('aria-valuetext'), 'Xhigh', 'slider style and reasoning effort survive host restart')
  assert.deepEqual(await page.locator('.dshReasoning__labels > span').allTextContents(), expectedOptions)
  await page.screenshot({ path: join(root, 'effort-menu-restored.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: six catalog levels; slider style and Xhigh survive host restart')
  console.log('Evidence: ' + root)
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
    await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally {
  await writeFile(join(root, 'errors.json'), JSON.stringify(errors, null, 2))
  await writeFile(join(root, 'host.log'), output)
  if (browser) await browser.close()
  stop()
}
