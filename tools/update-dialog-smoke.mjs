/** Render the real update dialog/primitives in an isolated DSH profile.
 * Native update replies are controlled; no package is installed or downloaded.
 * Run: node tools/update-dialog-smoke.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = await mkdtemp(resolve('src-tauri/target/update-dialog-'))
const home = join(root, 'home')
await mkdir(home)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n')
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin },
})
let output = '', browser, page
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const report = { root, checks: [] }
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
try {
  let url
  for (let i = 0; i < 300; i++) {
    url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) break
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-2000))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, 'isolated backend starts')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.updateCalls = []
    window.updateReplies = {}
    window.__TAURI__ = { app: { getVersion: async () => '0.1.0' }, core: { invoke: async (command, args) => {
      window.updateCalls.push({ command, args })
      if (command === 'check_desktop_update' || command === 'check_dsh_update') {
        return new Promise((resolve, reject) => { window.updateReplies[command] = { resolve, reject } })
      }
      if (command === 'window_is_maximized') return false
      return null
    } } }
  })
  await page.goto(url)
  await page.locator('.dshTb').waitFor()
  for (let i = 0; i < 10; i++) {
    for (const name of ['继续', '稍后配置']) {
      const button = page.getByRole('button', { name, exact: true })
      if (await button.isVisible() && await button.isEnabled()) await button.click()
    }
    await page.waitForTimeout(100)
  }
  if (await page.locator('[data-shortcut-modal="settings"]').count()) await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '检测更新...', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '检测更新', exact: true })
  await dialog.waitFor()
  await dialog.getByText('正在检测软件更新…', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.updateCalls.filter(call => /^check_(desktop|dsh)_update$/.test(call.command)).map(call => call.command).sort()), ['check_desktop_update', 'check_dsh_update'])
  pass('one menu click opens the real Modal and starts both checks')
  await page.screenshot({ path: join(root, 'checking.png') })
  const release = {
    current: '0.1.0', release: { version: '0.2.0', name: 'dsh-desktop v0.2.0', prerelease: false,
      publishedAt: '2026-10-08T02:00:00Z', updateAvailable: true,
      url: 'https://github.com/Turing158/dsh-desktop/releases/tag/v0.2.0',
      notes: '## 更新内容\n\n- 改进桌面体验与窗口交互。\n- 修复已知问题，提高运行稳定性。\n\n## 详细说明\n\n' + '- 支持 **Markdown** 更新说明和较长的内容。\n'.repeat(12) },
  }
  await page.evaluate(release => window.updateReplies.check_desktop_update.resolve(release), release)
  await dialog.getByText('发现新版本', { exact: true }).waitFor()
  assert.ok(await dialog.locator('.dshTb__releaseBody strong').count(), 'real safe Markdown renderer is used')
  await dialog.getByRole('tab', { name: 'dsh 更新' }).click()
  await dialog.getByText('正在检测 dsh 更新…', { exact: true }).waitFor()
  await page.evaluate(() => window.updateReplies.check_dsh_update.resolve({ current: '0.1.5-rc.2', latest: '0.1.7-rc.2', next: '0.2.0-rc.1' }))
  await dialog.getByText('dsh 可更新', { exact: true }).waitFor()
  await dialog.getByRole('tab', { name: 'dsh 更新' }).press('ArrowLeft')
  assert.equal(await dialog.getByRole('tab', { name: '软件更新' }).getAttribute('aria-selected'), 'true')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dsh-update-tab-desktop')
  pass('independent results, Markdown rendering and keyboard tabs work')
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.waitForTimeout(200)
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 768], [375, 720]]) {
      await page.setViewportSize({ width, height })
      for (const tab of ['软件更新', 'dsh 更新']) {
        await dialog.getByRole('tab', { name: tab }).click()
        const bounds = await dialog.boundingBox()
        if (width >= 768) assert.equal(Math.round(bounds.width), 560, 'the update dialog has room for release notes')
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, JSON.stringify({ theme, width, tab, bounds }))
        const overflow = await dialog.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }))
        assert.ok(overflow.scroll <= overflow.client + 1, JSON.stringify({ theme, width, tab, overflow }))
        if (tab === '软件更新') {
          const contrast = await dialog.locator('.dshTb__releaseBody > *').evaluate(node => {
            const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number)
            const luminance = color => rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
            const fg = luminance(getComputedStyle(node).color), bg = luminance(getComputedStyle(node.closest('[role=dialog]')).backgroundColor)
            return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05)
          })
          assert.ok(contrast >= 4.5, `release notes contrast: ${theme} ${contrast}`)
        }
        await page.screenshot({ path: join(root, `${theme}-${width}-${tab === '软件更新' ? 'app' : 'dsh'}.png`) })
      }
    }
  }
  pass('both tabs fit 375/768/1024/1440px in light and dark themes')
  await page.setViewportSize({ width: 1280, height: 840 })
  await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '检测更新...', exact: true }).click()
  assert.equal(await page.evaluate(() => window.updateCalls.filter(call => /^check_(desktop|dsh)_update$/.test(call.command)).length), 4)
  await page.evaluate(() => {
    window.updateReplies.check_desktop_update.reject('GitHub 暂时限制了请求，请稍后重试。')
    window.updateReplies.check_dsh_update.resolve({ current: '0.1.7-rc.2', latest: '0.1.7-rc.2', next: '0.1.7-rc.2' })
  })
  await dialog.getByRole('alert').waitFor()
  await page.screenshot({ path: join(root, 'error.png') })
  await dialog.getByRole('tab', { name: 'dsh 更新' }).click()
  assert.equal(await dialog.getByRole('button', { name: '最新稳定版', exact: true }).isDisabled(), true)
  assert.equal(await dialog.getByRole('button', { name: '最新预览版', exact: true }).count(), 0)
  pass('reopening refreshes both; a GitHub error leaves dsh results intact')
  assert.deepEqual(errors, [])
  pass('no browser runtime errors')
} catch (error) {
  report.error = error.stack
  report.dialogs = await page?.getByRole('dialog').allTextContents().catch(() => [])
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'backend.log'), output)
  await browser?.close()
  child.kill()
  console.log('Report: ' + root)
}
