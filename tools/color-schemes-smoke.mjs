/** Real DSH settings, CSS cascade and restart checks using an isolated profile. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { colorSchemes } from '../dsh-plugin/ui-overlay/color-schemes.mjs'
import { handleOnboarding, dismissInitialWelcome, openDshSettings, offlineModelPatch } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(resolve('src-tauri/target/color-schemes-'))
const home = join(root, 'home'), probe = join(root, 'probe')
await mkdir(home); await mkdir(probe)
await writeFile(join(home, 'settings.yaml'), 'desktop-appearance:\n  animation: off\n  ui: desktop\n')
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: '@dsh-desktop/color-schemes-smoke', type: 'module', main: 'index.js',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] } },
}))
await writeFile(join(probe, 'index.js'), 'export function apply() {}\n')
await writeFile(join(probe, 'client.js'), `window.__ModuleLoader__.load({
  id: '@dsh-desktop/color-schemes-smoke',
  factory: () => ({ inject: ['configForms', 'slots', 'theme'], apply(ctx) { window.__COLOR_SCHEMES_SMOKE__ = ctx } }),
})\n`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch + '\n- insert:\n    - id: desktop-color-schemes-smoke\n      name: ' + pathToFileURL(join(probe, 'index.js')).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
let child, browser, page, output = ''
const report = { root, checks: [], palettes: [] }
async function start() {
  output = ''
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_UI_SMOKE_KEY: 'offline-fixture' },
  })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 300; i++) {
    const url = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (url) return url
    if (child.exitCode !== null) throw Error('DSH exited: ' + output.slice(-4000))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('DSH did not become ready: ' + output.slice(-4000))
}
function stop() {
  if (!child || child.exitCode !== null) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
  catch (error) { try { process.kill(child.pid, 0); throw error } catch (probe) { if (probe.code !== 'ESRCH') throw probe } }
  child = null
}
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
function rgb(hex) { return 'rgb(' + [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ') + ')' }
async function ready(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => {
    if (document.body.textContent.includes('Failed to load plugins')) throw Error(document.body.textContent)
    return window.__COLOR_SCHEMES_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status === 'ready'
  }, undefined, { timeout: 30000 })
}
async function openAppearance(page) {
  await openDshSettings(page)
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.locator('.dshAppearance').waitFor()
}
async function ensureAppearance(page) {
  if (!await page.locator('.dshAppearance').isVisible()) await openAppearance(page)
}
async function checkSelectedOptions(page) {
  // Theme changes animate the new selected fill; compare after that transition.
  await page.mouse.move(0, 0)
  await page.locator('.dshAppearance__option').evaluateAll(options => Promise.all(options.flatMap(el =>
    el.getAnimations().map(animation => animation.finished.catch(() => {})))))
  const groups = await page.locator('.dshAppearance [role=group]').evaluateAll(groups => groups.flatMap(group => {
    const options = [...group.querySelectorAll('.dshAppearance__option')]
    if (!options.length) return []
    const selected = options.filter(button => button.getAttribute('aria-pressed') === 'true')
    const swatch = document.createElement('span')
    swatch.style.backgroundColor = 'var(--dsw-alias-interactive-bg-active)'
    group.append(swatch)
    const expected = getComputedStyle(swatch).backgroundColor
    swatch.remove()
    return [{ label: group.getAttribute('aria-label'), selected: selected.length,
      backgrounds: selected.map(button => getComputedStyle(button).backgroundColor), expected }]
  }))
  for (const group of groups) {
    assert.equal(group.selected, 1, group.label + ' has exactly one selected option')
    assert.deepEqual(group.backgrounds, [group.expected], group.label + ' retains its selected fill')
  }
  for (const { label: group } of groups) {
    const selected = page.getByRole('group', { name: group, exact: true }).locator('.dshAppearance__option[aria-pressed=true]')
    await selected.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    const before = await selected.evaluate(el => {
      const s = getComputedStyle(el)
      return { background: s.backgroundColor, border: s.border, color: s.color }
    })
    await selected.hover()
    await selected.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))))
    const after = await selected.evaluate(el => {
      const s = getComputedStyle(el)
      return { background: s.backgroundColor, border: s.border, color: s.color }
    })
    assert.deepEqual(after, before, group + ' selected option does not change on hover')
    await page.mouse.move(0, 0)
  }
  await page.getByRole('group', { name: '主题', exact: true }).scrollIntoViewIfNeeded()
}
async function readPalette(page) {
  return page.evaluate(() => {
    const s = getComputedStyle(document.body)
    const keys = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-module-platform', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-link', '--dsw-alias-button-primary-fill', '--dsw-alias-border-l3', '--dsw-alias-state-success-primary']
    const sidebar = document.querySelector('[class*=_sidebarCol]')
    const surfaces = Object.fromEntries(['[class*=_sidebarCol]', '[data-slot=sidebar]', '[class*=_centerCol]', '[data-dsh-desktop=composer]', '[data-dsh-desktop=composer] button[class*=_primary]', '.dshTb', '[class*=_composerSeat]'].map(selector => {
      const el = document.querySelector(selector)
      if (!el) return [selector, null]
      const cs = getComputedStyle(el)
      return [selector, { class: el.className, background: cs.backgroundColor, image: cs.backgroundImage, style: el.getAttribute('style'), tokens: Object.fromEntries(Array.from(cs).filter(k => /^--.*(sidebar|composer|titlebar|button|chat|bg)/.test(k)).map(k => [k, cs.getPropertyValue(k).trim()])) }]
    }))
    return { scheme: document.documentElement.getAttribute('data-dsh-color-scheme'), dark: document.body.hasAttribute('data-ds-dark-theme'), tokens: Object.fromEntries(keys.map(k => [k, s.getPropertyValue(k).trim()])), sidebar: sidebar ? getComputedStyle(sidebar).backgroundColor : null, surfaces }
  })
}
async function mountTerminal(page) {
  await page.evaluate(() => {
    // Exercise the shipped xterm renderer without starting a native shell.
    const original = { bridge: window.__TAURI__, identity: window.__DSH_TERMINAL_IDENTITY__ }
    const key = 'dsh-resource://desktop-terminal/palette-smoke'
    const info = { resourceKey: key, terminalId: 'palette-smoke', runId: 1, state: 'running', profileId: 'fixture' }
    window.__DSH_TERMINAL_IDENTITY__ = {}
    window.__TAURI__ = { core: { Channel: class {}, invoke: async name => ({
      terminal_list: [], terminal_profiles: [{ profileId: 'fixture', name: 'Fixture' }], terminal_open: info,
      terminal_attach: 'fixture-attachment', terminal_control: 1,
    })[name] ?? {} } }
    const store = { getSnapshot: () => ({ bySession: { fixture: { layout: { tabs: { fixture: { contentId: key } } } } } }), subscribe: () => () => {} }
    const registry = window.DSHTerminal.createRegistry({
      slots: { entriesOfSlot: () => [{ store: { create() {} } }], resolveStore: () => store },
      sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: ['fixture'], current: 'fixture' }), subscribe: () => () => {} }, scope: () => ({}) },
      workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [] }) } },
    }, null)
    const surface = document.createElement('section')
    surface.className = 'dshTerminal'
    Object.assign(surface.style, { position: 'fixed', bottom: '0', right: '0', width: '450px', height: '160px', zIndex: '1000' })
    document.body.append(surface)
    const view = registry.view({ contentId: key, signal: {} })
    view.mount(surface)
    window.__PALETTE_TERMINAL__ = { surface, destroy() {
      registry.dispose(); surface.remove()
      window.__TAURI__ = original.bridge; window.__DSH_TERMINAL_IDENTITY__ = original.identity
      delete window.__PALETTE_TERMINAL__
    } }
  })
}
try {
  const firstUrl = await start()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await handleOnboarding(page)
  await ready(page, firstUrl)
  await dismissInitialWelcome(page)
  await openAppearance(page)
  const buttons = page.locator('.dshAppearance [data-color-scheme]')
  assert.deepEqual(await buttons.allTextContents(), ['默认', '经典蓝', '雾海青', '苔原绿', '暮光紫', '纸墨琥珀', '玫瑰灰'])
  assert.equal(await buttons.first().getAttribute('aria-pressed'), 'true')
  const baseline = {}
  for (const mode of ['light', 'dark']) {
    await page.getByRole('button', { name: mode === 'light' ? '浅色' : '深色', exact: true }).click()
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, mode === 'dark')
    baseline[mode] = await readPalette(page)
  }
  pass('Default is first, initially selected, and all six requested schemes are visible')
  for (const scheme of colorSchemes) {
    await ensureAppearance(page)
    await page.locator('[data-color-scheme=' + scheme.id + ']').click()
    await page.waitForFunction(id => window.__COLOR_SCHEMES_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.colorScheme === id, scheme.id)
    for (const mode of ['light', 'dark']) {
      await ensureAppearance(page)
      await page.getByRole('button', { name: mode === 'light' ? '浅色' : '深色', exact: true }).click()
      await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, mode === 'dark')
      await checkSelectedOptions(page)
      const actual = await readPalette(page), p = scheme[mode]
      for (const [token, value] of Object.entries({
        '--dsw-alias-bg-base': p.canvas, '--dsw-alias-bg-layer-1': p.panel, '--dsw-alias-bg-module-platform': p.panel,
        '--dsw-alias-label-primary': p.ink, '--dsw-alias-label-secondary': p.muted,
        '--dsw-alias-link': p.accent, '--dsw-alias-button-primary-fill': p.button, '--dsw-alias-border-l3': p.border,
      })) assert.equal(actual.tokens[token].toLowerCase(), value.toLowerCase(), scheme.id + '/' + mode + '/' + token)
      for (const [selector, value] of Object.entries({
        '[class*=_sidebarCol]': p.sidebar, '.dshTb': p.sidebar,
        '[data-dsh-desktop=composer]': p.panel, '[data-dsh-desktop=composer] button[class*=_primary]': p.button,
      })) assert.equal(actual.surfaces[selector]?.background, rgb(value), scheme.id + '/' + mode + '/' + selector)
      assert.equal(actual.tokens['--dsw-alias-state-success-primary'], baseline[mode].tokens['--dsw-alias-state-success-primary'])
      report.palettes.push({ id: scheme.id, mode, ...actual })
      await page.screenshot({ path: join(root, scheme.id + '-' + mode + '.png'), fullPage: true })
      await page.keyboard.press('Escape')
      await page.locator('.dshAppearance').waitFor({ state: 'hidden' })
      await page.screenshot({ path: join(root, scheme.id + '-' + mode + '-app.png'), fullPage: true })
    }
  }
  pass('all twelve variants color actual sidebars, title bars and composers, preserving semantic status colors')
  await ensureAppearance(page)
  await page.locator('[data-color-scheme=moss]').click()
  await page.getByRole('group', { name: '动画', exact: true }).getByRole('button', { name: '开启', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dsh-desktop-animation') === 'on')
  await checkSelectedOptions(page)
  const themeOptions = page.getByRole('group', { name: '主题', exact: true })
  await themeOptions.getByRole('button', { name: '浅色', exact: true }).click()
  await page.mouse.move(0, 0)
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'))
  await checkSelectedOptions(page)
  await themeOptions.getByRole('button', { name: '深色', exact: true }).click()
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'))
  await checkSelectedOptions(page)
  await page.getByRole('group', { name: '动画', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dsh-desktop-animation') === 'off')
  pass('all appearance options retain selection through hover, pointer exit and theme changes with animations enabled or disabled')
  const composer = page.locator('[data-dsh-desktop=composer]')
  for (const [id, label] of [['glass', '毛玻璃'], ['frosted', '纯磨砂'], ['transparent', '透明'], ['opaque', '不透明']]) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForFunction(id => document.documentElement.getAttribute('data-dsh-composer-material') === id, id)
    const style = await composer.evaluate(el => {
      const s = getComputedStyle(el)
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const context = canvas.getContext('2d'); context.fillStyle = s.backgroundColor; context.fillRect(0, 0, 1, 1)
      return { background: s.backgroundColor, rgba: Array.from(context.getImageData(0, 0, 1, 1).data), blur: s.backdropFilter }
    })
    assert.ok([37, 48, 32].every((channel, i) => Math.abs(style.rgba[i] - channel) <= 2), id + ' keeps the selected panel tint: ' + style.background)
    assert.equal(style.blur.includes('blur('), id === 'glass' || id === 'frosted')
  }
  pass('glass, frosted, transparent and opaque materials retain the selected tint and their effects')
  const vanilla = await page.evaluate(() => {
    const root = document.documentElement, read = () => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base')
    root.setAttribute('data-dsh-ui', 'vanilla')
    const selected = read()
    root.setAttribute('data-dsh-color-scheme', 'default')
    const original = read()
    root.setAttribute('data-dsh-color-scheme', 'moss')
    root.setAttribute('data-dsh-ui', 'desktop')
    return { selected, original }
  })
  assert.equal(vanilla.selected, vanilla.original)
  pass('vanilla mode excludes selected palette overrides')
  await mountTerminal(page)
  for (const id of ['teal', 'moss', 'rose', 'default']) {
    await page.locator('[data-color-scheme=' + id + ']').click()
    const bg = id === 'default' ? baseline.dark.tokens['--dsw-alias-bg-base'] : colorSchemes.find(s => s.id === id).dark.canvas
    await page.waitForFunction(expected => {
      const surface = window.__PALETTE_TERMINAL__.surface
      return getComputedStyle(surface).backgroundColor === expected && getComputedStyle(surface.querySelector('.xterm-viewport')).backgroundColor === expected
    }, rgb(bg))
  }
  await page.evaluate(() => window.__PALETTE_TERMINAL__.destroy())
  pass('the shipped terminal renderer follows live palette changes and restores Default')
  await page.locator('[data-color-scheme=default]').click()
  for (const mode of ['light', 'dark']) {
    await page.getByRole('button', { name: mode === 'light' ? '浅色' : '深色', exact: true }).click()
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, mode === 'dark')
    await checkSelectedOptions(page)
    assert.deepEqual(await readPalette(page), baseline[mode])
  }
  pass('Default restores the exact original light and dark tokens')
  await page.locator('[data-color-scheme=teal]').click()
  await page.waitForFunction(() => window.__COLOR_SCHEMES_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.colorScheme === 'teal')
  const freshPage = await browser.newPage()
  await handleOnboarding(freshPage)
  const firstPaint = await freshPage.request.get(firstUrl)
  assert.match(await firstPaint.text(), /setAttribute\("data-dsh-color-scheme","teal"\)/)
  for (let attempt = 0; attempt < 100; attempt++) {
    const saved = JSON.parse(await readFile(join(home, 'desktop-settings.json'), 'utf8'))
    if (saved.namespaces['desktop-appearance'].colorScheme === 'teal') break
    if (attempt === 99) throw Error('Teal selection was not written to disk')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await page.close(); page = null
  stop()
  const secondUrl = await start()
  await ready(freshPage, secondUrl)
  assert.equal((await readPalette(freshPage)).scheme, 'teal')
  await openAppearance(freshPage)
  assert.equal(await freshPage.locator('[data-color-scheme=teal]').getAttribute('aria-pressed'), 'true')
  const saved = JSON.parse(await readFile(join(home, 'desktop-settings.json'), 'utf8'))
  assert.equal(saved.namespaces['desktop-appearance'].colorScheme, 'teal')
  assert.equal(saved.namespaces['desktop-appearance'].animation, 'off')
  pass('saved scheme is present before first paint and survives a Host restart on a new origin')
  for (const width of [375, 768, 1280]) {
    await freshPage.setViewportSize({ width, height: 960 })
    assert.equal(await freshPage.locator('[data-color-scheme]').count(), 7)
    assert.ok(await freshPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
  await freshPage.setViewportSize({ width: 1280, height: 960 })
  await freshPage.screenshot({ path: join(root, 'appearance-teal.png'), fullPage: true })
  assert.deepEqual(errors, [])
  pass('settings remain usable at narrow widths without browser errors')
} catch (error) {
  report.error = error.stack
  if (page) {
    report.page = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {})
  }
  throw error
} finally {
  await writeFile(join(root, 'last-host.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  stop()
  console.log('Evidence: ' + join(root, 'report.json'))
}
