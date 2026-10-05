/** Exercise the real add-provider form and animation preferences in an isolated DSH profile.
 * Run: node tools/model-provider-motion-smoke.mjs. Requires the bundled Playwright + Edge.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/model-provider-motion-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home)
await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: on\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/motion-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({ id: '@dsh-desktop/motion-smoke',
  factory: () => ({ inject: ['configForms', 'slots', 'sessions', 'workspaces', 'uiWorkspace', 'sidebarRight'],
    apply(ctx) { window.__MOTION_SMOKE__ = ctx } }) })`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: desktop-motion-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { root, checks: [] }
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }

try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-2000))
    await sleep(100)
  }
  assert.ok(url, 'isolated backend starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.__MOTION_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status === 'ready')
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  for (const label of ['继续', '我知道了', '稍后配置']) {
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.count()) await button.click()
  }
  await page.waitForTimeout(350)
  if (!await page.locator('[data-shortcut-modal="settings"]').count()) {
    await page.locator('button[aria-haspopup="dialog"]').first().evaluate(node => node.click())
  }
  await page.locator('[class*="_navList"] button').filter({ hasText: '模型' }).click()
  const add = page.getByRole('button', { name: '添加模型提供商', exact: true })
  await add.waitFor()
  await page.evaluate(() => {
    window.providerBlock = [...document.querySelectorAll('button')].find(node => node.textContent === '添加模型提供商').parentElement.parentElement
    window.providerContent = window.providerBlock.firstElementChild
  })
  const settle = () => page.waitForFunction(() => !window.providerBlock.hasAttribute('data-dsh-provider-motion'))
  async function toggle(open, animated) {
    const result = await page.evaluate(async open => {
      const block = window.providerBlock
      const before = block.getBoundingClientRect().height
      const button = [...block.querySelectorAll('button')].find(node => node.textContent.trim() === (open ? '添加模型提供商' : '取消'))
      if (!button) throw Error('Missing toggle: ' + block.innerText)
      button.click()
      await new Promise(requestAnimationFrame)
      return { before, after: block.getBoundingClientRect().height,
        same: block.firstElementChild === window.providerContent,
        frames: block.getAnimations().map(animation => animation.effect.getKeyframes()),
        ghost: Boolean(block.querySelector('[data-dsh-model-exit][inert][aria-hidden="true"]')) }
    }, open)
    assert.ok(result.same, 'actual React content div is reused')
    assert.equal(result.frames.length, animated ? 1 : 0)
    assert.equal(result.ghost, animated)
    if (animated) {
      const frames = result.frames[0]
      assert.ok(open ? parseFloat(frames[0].height) < parseFloat(frames.at(-1).height) : parseFloat(frames[0].height) > parseFloat(frames.at(-1).height))
      assert.ok(Math.abs(result.before - result.after) < 10, 'first frame starts at the previous height')
    }
    await settle()
    assert.equal(await page.locator('[data-dsh-model-exit]').count(), 0)
  }
  for (const [preference, reducedMotion, animated] of [
    ['on', 'no-preference', true], ['off', 'no-preference', false],
    ['system', 'reduce', false], ['on', 'reduce', true], ['system', 'no-preference', true],
  ]) {
    await page.emulateMedia({ reducedMotion })
    await page.evaluate(preference => window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('animation', preference), preference)
    await page.waitForTimeout(80)
    await toggle(true, animated)
    await toggle(false, animated)
    pass('real add/cancel buttons: ' + preference + ', system ' + reducedMotion)
  }
  await page.evaluate(() => window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('animation', 'on'))
  await toggle(true, true)
  await page.screenshot({ path: join(root, 'provider-open.png') })
  await page.evaluate(async () => {
    const block = window.providerBlock
    const cancel = [...block.querySelectorAll('button')].find(node => node.textContent.trim() === '取消')
    cancel.click()
    await new Promise(requestAnimationFrame)
    window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('animation', 'off')
  })
  await settle()
  await add.waitFor()
  assert.equal(await page.locator('[data-dsh-model-exit]').count(), 0)
  assert.equal(await page.evaluate(() => window.providerBlock.getAnimations({ subtree: true }).length), 0)
  pass('turning animation off during collapse completes immediately with no ghost or clipped container')
  assert.deepEqual(errors, [])
  pass('no browser errors')
} catch (error) {
  report.error = error.stack
  if (page) {
    report.body = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log('Report: ' + join(root, 'report.json'))
}

