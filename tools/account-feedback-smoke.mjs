/** Real account launcher, isolated OAuth fixture and intercepted feedback browser boundary. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { handleOnboarding, dismissInitialWelcome, offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/account-feedback-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  ui: desktop\n  animation: on\n')
let authorization, platformOrigin, initializations = 0
const platform = createServer(async (req, res) => {
  const url = new URL(req.url, platformOrigin)
  let body = ''; for await (const chunk of req) body += chunk
  const json = value => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: value } }))
  }
  if (url.pathname.endsWith('/auth_init')) {
    authorization = JSON.parse(body); initializations++
    return json({ authorize_url: platformOrigin + '/dsh/authorize', authorize_id: 'fixture-' + initializations, expires_in: 600 })
  }
  if (url.pathname.endsWith('/auth_exchange')) return json({ token: 'isolated-fixture-token', authorized_url: platformOrigin + '/dsh/authorized' })
  if (url.pathname.endsWith('/auth_cancel') || url.pathname.endsWith('/logout')) return json({})
  if (url.pathname === '/dsh/authorize') {
    const callback = new URL(authorization.redirect_uri)
    callback.searchParams.set('state', authorization.state); callback.searchParams.set('code', 'fixture-code')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end('<a href="' + callback.href.replaceAll('&', '&amp;') + '">Authorize test account</a>')
  }
  if (url.pathname === '/dsh/authorized') return res.end('Authorized fixture')
  res.writeHead(404).end()
})
await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve))
platformOrigin = 'http://127.0.0.1:' + platform.address().port
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: '@dsh-desktop/feedback-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
await writeFile(join(probe, 'index.js'), 'export function apply() {}')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'@dsh-desktop/feedback-smoke',factory:()=>({
  inject:['slots','layout','locale','theme','configForms'],apply(ctx){window.feedbackContext=ctx}
})})`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch + `\n- id: deepseek-account\n  config:\n    platformOrigin: ${platformOrigin}\n    allowLoopbackHttp: true\n- insert:\n    - id: feedback-smoke\n      name: ${pathToFileURL(join(probe, 'index.js')).href}\n`
const patchPath = join(root, 'desktop.patch.yml'); await writeFile(patchPath, patch)
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_UI_SMOKE_KEY: 'offline-fixture' },
})
let logs = '', browser, page
child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data)
const report = { root, checks: [], errors: [] }
const pass = name => { report.checks.push(name); console.log('PASS: ' + name) }
async function sidebar(collapsed) {
  await page.evaluate(collapsed => {
    if ((document.querySelector('.dshAccountLauncher')?.dataset.collapsed === 'true') !== collapsed) window.feedbackContext.layout.toggleSidebar()
  }, collapsed)
  await page.locator(`.dshAccountLauncher[data-collapsed=${collapsed}]`).waitFor()
  await page.waitForTimeout(250)
}
async function interceptFeedback() {
  await page.evaluate(() => {
    window.feedbackOriginalOpen = window.open
    window.feedbackOpenCalls = []; window.failFeedback = false
    window.open = (...args) => {
      if (window.failFeedback) throw Error('feedback boundary fixture')
      window.feedbackOpenCalls.push(args)
      return null
    }
  })
}
async function restoreOpen() { await page.evaluate(() => { window.open = window.feedbackOriginalOpen }) }
async function checkClick(keyboard = false) {
  const count = await page.evaluate(() => window.feedbackOpenCalls.length)
  const feedback = page.locator('.dshAccountLauncher__feedback')
  if (keyboard) { await feedback.focus(); await page.keyboard.press('Enter') }
  else await feedback.click()
  await page.waitForFunction(count => window.feedbackOpenCalls.length === count + 1, count)
  assert.equal(await page.getByRole('menu').count(), 0, 'feedback never opens the account menu')
}
async function checkGeometry() {
  const geometry = await page.evaluate(() => {
    const account = document.querySelector('.dshAccountLauncher__native').getBoundingClientRect()
    const trigger = document.querySelector('[data-dsh-account-sign-in], [data-dsh-account-trigger]').getBoundingClientRect()
    const feedback = document.querySelector('.dshAccountLauncher__feedback')?.getBoundingClientRect()
    const settings = document.querySelector('.dshSidebarSettings__button, .dshAccount__settings').getBoundingClientRect()
    const badge = document.querySelector('.dshUpdateBadge')?.getBoundingClientRect()
    const bounds = document.querySelector('[class*="_sidebarCol"]').getBoundingClientRect()
    const compact = document.querySelector('.dshAccountLauncher').dataset.collapsed === 'true'
    const controls = [account, settings, ...(feedback ? [feedback] : []), ...(badge ? [badge] : [])]
    return { compact, trigger: trigger.toJSON(), account: account.toJSON(), feedback: feedback?.toJSON(), settings: settings.toJSON(), badge: badge?.toJSON(),
      clipped: controls.some(r => r.left < bounds.left - 1 || r.right > bounds.right + 1 || !r.width || !r.height) }
  })
  assert.equal(geometry.clipped, false, 'all footer controls fit inside sidebar')
  if (geometry.compact) {
    for (const control of [geometry.settings, ...(geometry.feedback ? [geometry.feedback] : [])]) {
      assert.ok(Math.abs(geometry.trigger.x + geometry.trigger.width / 2 - control.x - control.width / 2) < 1,
        'collapsed account, feedback and settings share a horizontal center')
    }
    assert.ok(geometry.account.bottom <= (geometry.feedback ?? geometry.settings).top + 1)
    if (geometry.feedback) assert.ok(geometry.feedback.bottom <= geometry.settings.top + 1)
  } else {
    for (const control of [geometry.settings, ...(geometry.feedback ? [geometry.feedback] : []), ...(geometry.badge ? [geometry.badge] : [])]) {
      assert.ok(Math.abs(geometry.trigger.y + geometry.trigger.height / 2 - control.y - control.height / 2) < 1,
        'expanded account, feedback, settings and update badge share a vertical center')
    }
    assert.ok(geometry.account.right <= (geometry.badge ?? geometry.feedback ?? geometry.settings).left + 1)
    assert.ok((geometry.badge?.right ?? geometry.account.right) <= (geometry.feedback ?? geometry.settings).left + 1)
    if (geometry.feedback) assert.ok(geometry.feedback.right <= geometry.settings.left + 1)
  }
}
async function preference(value, reduced = 'no-preference') {
  await page.emulateMedia({ reducedMotion: reduced })
  await page.evaluate(value => window.feedbackContext.configForms.get('desktop-appearance').set('animation', value), value)
  await page.waitForFunction(value => document.documentElement.getAttribute('data-dsh-desktop-animation') === (value === 'system' ? null : value), value)
}
try {
  let url
  for (let i = 0; i < 300; i++) {
    url = logs.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error(logs.slice(-3000))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, logs.slice(-3000))
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 850 } })
  page.on('pageerror', error => report.errors.push(error.message))
  await page.addInitScript(() => {
    window.__DSH_UI_BOOT__ = { smoke: true }
    window.__TAURI__ = { core: { Channel: class {}, invoke: async () => null }, event: { listen: async () => () => {} } }
  })
  await handleOnboarding(page); await page.goto(url); await page.waitForFunction(() => window.feedbackContext)
  await dismissInitialWelcome(page)
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  await sidebar(false)
  const feedback = page.locator('.dshAccountLauncher__feedback')
  assert.equal(await feedback.textContent(), '')
  assert.equal(await feedback.getAttribute('aria-label'), '意见反馈')
  assert.equal(await feedback.locator('svg').count(), 1)
  await checkGeometry(); await interceptFeedback(); await checkClick(); await checkClick(true)
  pass('signed-out feedback is icon-only and launches feedback directly by mouse and keyboard')

  await page.mouse.click(600, 90); await page.waitForTimeout(250)
  const resting = await feedback.evaluate(node => ({ bg: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderWidth,
    opacity: getComputedStyle(node, '::before').opacity, shadow: getComputedStyle(node).boxShadow }))
  assert.equal(resting.bg, 'rgba(0, 0, 0, 0)'); assert.equal(resting.border, '0px'); assert.equal(resting.opacity, '0'); assert.equal(resting.shadow, 'none')
  await feedback.hover()
  await page.waitForFunction(() => document.querySelector('.dshAccountLauncher__feedback').getAnimations({ subtree: true }).length > 0)
  const sampled = await feedback.evaluate(node => {
    for (const animation of node.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 80 }
    return { opacity: Number(getComputedStyle(node, '::before').opacity), glyph: getComputedStyle(node.querySelector('svg')).transform }
  })
  assert.ok(sampled.opacity > 0 && sampled.opacity < 1, 'hover surface visibly fades in')
  assert.notEqual(sampled.glyph, 'none')
  await feedback.evaluate(node => node.getAnimations({ subtree: true }).forEach(animation => animation.finish()))
  await page.getByRole('tooltip', { name: '意见反馈', exact: true }).waitFor()
  await checkGeometry(); await page.screenshot({ path: join(root, 'hover.png') })
  await page.mouse.move(600, 90); await page.waitForTimeout(250)
  assert.equal(await feedback.evaluate(node => getComputedStyle(node, '::before').opacity), '0')
  await page.screenshot({ path: join(root, 'resting.png') })
  pass('rest has no surface; hover interpolates border/background and glyph, shows tooltip, and exits smoothly')

  for (const [value, reduced, animated] of [['off', 'no-preference', false], ['system', 'reduce', false], ['on', 'reduce', true]]) {
    await preference(value, reduced); await feedback.hover(); await page.waitForTimeout(250)
    const result = await feedback.evaluate(node => ({ duration: getComputedStyle(node, '::before').transitionDuration,
      glyph: getComputedStyle(node.querySelector('svg')).transform, opacity: getComputedStyle(node, '::before').opacity }))
    assert.equal(result.duration !== '0s', animated); assert.equal(result.glyph !== 'none', animated); assert.equal(result.opacity, '1')
    await page.mouse.move(600, 90); await page.waitForTimeout(250)
  }
  await preference('on')
  pass('animation off and reduced motion retain hover affordance without movement')

  await page.evaluate(() => {
    window.savedUpdateService = window.__DSH_DSH_UPDATE__
    window.__DSH_DSH_UPDATE__ = { getSnapshot: () => ({ versions: { stableUpdateAvailable: true, latest: '0.3.0' }, busy: '', error: null }) }
    document.dispatchEvent(new Event('dsh-desktop:dsh-update'))
  })
  await page.locator('.dshUpdateBadge').waitFor()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.feedbackContext.theme.setTheme(theme), theme)
    await page.waitForTimeout(200); await checkGeometry()
    await page.screenshot({ path: join(root, theme + '-update.png') })
  }
  await sidebar(true); await checkGeometry(); await checkClick()
  await page.mouse.click(600, 90)
  await feedback.hover(); await page.getByRole('tooltip', { name: '意见反馈', exact: true }).waitFor()
  await page.screenshot({ path: join(root, 'compact.png') })
  await page.mouse.move(600, 90)
  await page.evaluate(() => { window.__DSH_DSH_UPDATE__ = window.savedUpdateService; document.dispatchEvent(new Event('dsh-desktop:dsh-update')) })
  await sidebar(false)
  pass('light/dark and collapsed layouts keep account, update, feedback and settings apart')

  await page.evaluate(() => window.feedbackContext.locale.setLocale('en'))
  await page.waitForFunction(() => document.querySelector('.dshAccountLauncher__feedback')?.getAttribute('aria-label') === 'Feedback')
  await page.evaluate(() => window.feedbackContext.locale.setLocale('zh'))
  await page.waitForFunction(() => document.querySelector('.dshAccountLauncher__feedback')?.getAttribute('aria-label') === '意见反馈')
  await page.evaluate(() => { window.failFeedback = true }); await feedback.click()
  await page.getByText('操作未完成，请重试。', { exact: true }).waitFor()
  await page.evaluate(() => { window.failFeedback = false }); await restoreOpen()
  pass('locale changes update labels and launch failures display a toast while signed out')

  const popupPromise = page.waitForEvent('popup')
  await page.locator('[data-dsh-account-sign-in]').click(); const popup = await popupPromise
  await popup.waitForURL(platformOrigin + '/dsh/authorize**')
  assert.equal(initializations, 1)
  await popup.getByRole('link', { name: 'Authorize test account' }).click()
  await page.locator('[data-dsh-account-trigger]').waitFor()
  // OAuth leaves the popup active. Resume main-page animation frames before
  // measuring sidebar transitions or interacting with the restored controls.
  await page.bringToFront()
  assert.equal(await page.locator('[data-dsh-account-sign-in]').count(), 0)
  await feedback.waitFor({ state: 'detached' }); await checkGeometry()
  await page.screenshot({ path: join(root, 'signed-in.png') })
  await page.locator('[data-dsh-account-trigger]').click()
  await page.locator('[data-dsh-account-popover]').waitFor()
  assert.equal(await page.locator('[data-dsh-account-popover] .dshAccount__feedback').count(), 0)
  await page.keyboard.press('Escape')
  await sidebar(true); assert.equal(await feedback.count(), 0); await checkGeometry()
  pass('real OAuth sign-in hides sidebar feedback in expanded and collapsed layouts while preserving the account popover')

  await page.locator('[data-dsh-account-trigger]').click()
  await page.locator('.dshAccount__logout').click()
  const confirmation = page.getByRole('dialog', { name: '退出登录', exact: true })
  await confirmation.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.locator('[data-dsh-account-sign-in]').waitFor(); await feedback.waitFor()
  await confirmation.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => !document.querySelector('[data-dsh-ghost][role="dialog"], [data-dsh-ghost] [role="dialog"]'))
  await interceptFeedback(); await checkClick(true); await checkGeometry()
  await page.screenshot({ path: join(root, 'signed-out-compact.png') })
  await sidebar(false); await checkGeometry()
  await page.screenshot({ path: join(root, 'signed-out-expanded.png') })
  pass('sign-out restores the sidebar feedback action without leaving a layout gap')

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode', { detail: { mode: 'vanilla' } })))
  await feedback.waitFor({ state: 'detached' })
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode', { detail: { mode: 'desktop' } })))
  await feedback.waitFor(); assert.equal(await feedback.count(), 1)
  pass('vanilla withdraws the feedback adapter; desktop restores it once')
  assert.deepEqual(report.errors, [])
} catch (error) {
  report.failure = error.stack
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  console.error(error.stack); process.exitCode = 1
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'backend.log'), logs)
  await browser?.close()
  if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
  platform.closeAllConnections(); await new Promise(resolve => platform.close(resolve))
  console.log('Report: ' + root)
}
