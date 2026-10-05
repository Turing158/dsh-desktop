/** Exercise plugin disclosures without replaying the settings dialog entrance.
 * Run: node tools/plugin-settings-motion-smoke.mjs. Requires the bundled Playwright + Edge.
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
const root = await mkdtemp(resolve('src-tauri/target/plugin-settings-motion-'))
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

  await page.locator('[class*="_navList"] button').filter({hasText:'插件'}).click()
  await page.waitForTimeout(350)
  await page.evaluate(() => {
    window.pluginAnimations = []
    document.addEventListener('animationstart', event => window.pluginAnimations.push({name:event.animationName, tag:event.target.tagName,cls:event.target.className,role:event.target.getAttribute('role')}))
    window.panel = document.querySelector('[data-shortcut-modal="settings"]')
  })
  async function sample(selector) {
    return page.evaluate(async selector => {
      window.pluginAnimations = []
      const target = document.querySelector(selector), panel = window.panel
      const disclosure = target.closest('.dshInventory__card, [data-plugin-scope]')
      target.click()
      const samples = [], start = performance.now()
      while (performance.now()-start < 450) {
        await new Promise(requestAnimationFrame)
        const style = getComputedStyle(panel), mask = getComputedStyle(panel.parentElement)
        samples.push({opacity:style.opacity,mask:mask.opacity,animation:style.animationName,tag:panel.parentElement.getAttribute('data-dsh-chrome'),same:panel===document.querySelector('[data-shortcut-modal="settings"]'),motion:disclosure.getAnimations({subtree:true}).length})
      }
      return {samples,events:window.pluginAnimations}
    },selector)
  }
  async function checkToggle(selector, animated = true) {
    const result = await sample(selector)
    assert.ok(result.samples.every(frame => frame.same && frame.opacity === '1' && frame.mask === '1'), 'settings must stay mounted and opaque: ' + JSON.stringify(result))
    assert.equal(result.events.some(event => event.role === 'dialog' || event.role === 'presentation'), false, 'folding a plugin must not replay modal motion')
    assert.equal(result.samples.some(frame => frame.motion > 0), animated, 'the disclosure still respects the animation setting')
  }
  for (const id of await page.locator('[data-plugin-id]').evaluateAll(nodes => nodes.map(node => node.dataset.pluginId))) {
    const selector='[data-plugin-id="'+id+'"] [aria-expanded]'
    await checkToggle(selector)
    await checkToggle(selector)
  }
  pass('built-in plugin details open and close without flashing the settings dialog')
  await page.getByRole('tab',{name:'插件列表',exact:true}).click()
  await page.waitForTimeout(450)
  for (const selector of ['[data-plugin-module] .dshInventory__cardContent','[data-plugin-scope="preset"] .dshInventory__groupToggle','[data-plugin-scope="global"] .dshInventory__groupToggle']) {
    assert.ok(await page.locator(selector).count(), 'real plugin disclosure exists')
    await checkToggle(selector)
    await checkToggle(selector)
  }
  pass('plugin list details and preset/global groups do not replay modal motion')
  const plugin = '[data-plugin-module] .dshInventory__cardContent'
  for (const [animation, reducedMotion, enabled] of [['off','no-preference',false], ['system','reduce',false], ['on','reduce',true]]) {
    await page.emulateMedia({ reducedMotion })
    await page.evaluate(animation => window.__MOTION_SMOKE__.configForms.get('desktop-appearance').set('animation',animation),animation)
    await page.waitForFunction(animation => document.documentElement.getAttribute('data-dsh-desktop-animation') === (animation === 'system' ? null : animation),animation)
    // Re-enabling CSS animations can start existing entrance rules. Let the
    // preference change settle before measuring the subsequent disclosure click.
    await page.waitForFunction(() => !window.panel.getAnimations().length && !window.panel.parentElement.getAnimations().length)
    await checkToggle(plugin,enabled)
    await checkToggle(plugin,enabled)
  }
  pass('animation off/system/on preferences still control only disclosure motion')
  assert.deepEqual(errors, [])
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

