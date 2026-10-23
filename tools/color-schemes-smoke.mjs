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
  factory: require => {
    const React = require('react'), { createRoot } = require('react-dom/client')
    const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
    return { inject: ['configForms', 'slots', 'theme', 'sessions', 'workspaces', 'uiWorkspace', 'modelDirectories'], apply(ctx) {
      window.__MOUNT_PALETTE_SWITCHES__ = surface => {
        function Controls() {
          const [checked, setChecked] = React.useState(true)
          return React.createElement(React.Fragment, null,
            React.createElement(Switch, { checked, onChange: setChecked, label: 'Palette switch' }),
            React.createElement(Switch, { checked: false, disabled: true, label: 'Disabled palette switch' }))
        }
        const root = createRoot(surface)
        root.render(React.createElement(Controls))
        return () => root.unmount()
      }
      window.__COLOR_SCHEMES_SMOKE__ = ctx
    } }
  },
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
function luminance(hex) {
  const linear = [1, 3, 5].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear.reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0)
}
function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}
async function ready(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => {
    if (document.body.textContent.includes('Failed to load plugins')) throw Error(document.body.innerText)
    return window.__COLOR_SCHEMES_SMOKE__?.configForms.get('desktop-appearance').getSnapshot().status === 'ready'
  }, undefined, { timeout: 30000 })
}
async function openAppearance(page) {
  if (await page.locator('[class*=_frame][data-sidebar-collapsed]').count()) {
    await page.locator('.dshTb__mark').click()
    await page.locator('[class*=_frame][data-sidebar-collapsed]').waitFor({ state: 'detached' })
  }
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
    const keys = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-module-platform', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-link', '--dsw-alias-brand-primary', '--dsw-alias-button-primary-fill', '--dsw-alias-button-elevated-fill', '--dsw-alias-button-floating-hover', '--dsh-palette-dialog', '--dsh-palette-control-soft', '--dsh-palette-control-hover', '--dsw-alias-border-l3', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active', '--dsw-alias-state-success-primary']
    const sidebar = document.querySelector('[class*=_sidebarCol]')
    const surfaces = Object.fromEntries(['[class*=_sidebarCol]', '[data-slot=sidebar]', '[class*=_centerCol]', '[data-dsh-desktop=composer]', '[data-dsh-desktop=composer] button[class*=_primary]', '.dshTb', '[class*=_composerSeat]', '[data-shortcut-modal=settings]', 'button[class*=_newSession]'].map(selector => {
      const el = document.querySelector(selector)
      if (!el) return [selector, null]
      const cs = getComputedStyle(el)
      return [selector, { class: el.className, background: cs.backgroundColor, image: cs.backgroundImage, style: el.getAttribute('style'), tokens: Object.fromEntries(Array.from(cs).filter(k => /^--.*(sidebar|composer|titlebar|button|chat|bg)/.test(k)).map(k => [k, cs.getPropertyValue(k).trim()])) }]
    }))
    return { scheme: document.documentElement.getAttribute('data-dsh-color-scheme'), dark: document.body.hasAttribute('data-ds-dark-theme'), tokens: Object.fromEntries(keys.map(k => [k, s.getPropertyValue(k).trim()])), sidebar: sidebar ? getComputedStyle(sidebar).backgroundColor : null, surfaces }
  })
}
function paletteColors(palette) {
  // Palette restoration concerns paint, not asynchronously updated layout sizes.
  return { scheme: palette.scheme, dark: palette.dark, tokens: palette.tokens, sidebar: palette.sidebar,
    surfaces: Object.fromEntries(Object.entries(palette.surfaces).map(([selector, surface]) =>
      [selector, surface && { background: surface.background, image: surface.image }])) }
}
async function checkTintedSurfaces(page, p, mode, actual) {
  for (const [selector, token, base] of [
    ['[data-shortcut-modal=settings]', '--dsh-palette-dialog', p['layer-2']],
    ['button[class*=_newSession]', '--dsw-alias-button-elevated-fill', p.panel],
  ]) {
    const fill = actual.tokens[token]
    assert.equal(actual.surfaces[selector]?.background, rgb(fill), selector + ' uses the theme tint')
    assert.notEqual(fill, base, selector + ' carries a little theme color')
    const distance = Math.max(...[1, 3, 5].map(offset => Math.abs(
      parseInt(fill.slice(offset, offset + 2), 16) - parseInt(base.slice(offset, offset + 2), 16))))
    assert.ok(distance <= 18, selector + ' remains close to the neutral surface')
    for (const foreground of [p.ink, p.muted]) assert.ok(contrast(foreground, fill) >= 4.5, 'tinted surfaces retain readable text')
  }
  const outline = page.locator('[data-shortcut-modal=settings] button[class*="_outline_"]').first()
  assert.equal(await outline.evaluate(el => getComputedStyle(el).backgroundColor), rgb(actual.tokens['--dsh-palette-control-soft']))
  for (const token of ['--dsh-palette-control-soft', '--dsh-palette-control-hover']) {
    for (const foreground of [p.ink, p.muted]) assert.ok(contrast(foreground, actual.tokens[token]) >= 4.5, 'secondary actions retain readable rest and hover text')
  }
  const group = page.getByRole('group', { name: 'Dialog 效果', exact: true })
  const tint = actual.tokens['--dsh-palette-dialog']
  const channels = [1, 3, 5].map(offset => parseInt(tint.slice(offset, offset + 2), 16))
  for (const [id, label] of [['glass', '毛玻璃'], ['frosted', '纯磨砂'], ['transparent', '透明'], ['opaque', '不透明']]) {
    await group.getByRole('button', { name: label, exact: true }).click()
    await page.waitForFunction(id => document.documentElement.getAttribute('data-dsh-dialog-material') === id, id)
    const style = await page.locator('[data-shortcut-modal=settings]').evaluate(el => {
      const s = getComputedStyle(el), canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d'); context.fillStyle = s.backgroundColor; context.fillRect(0, 0, 1, 1)
      return { rgba: Array.from(context.getImageData(0, 0, 1, 1).data), blur: s.backdropFilter, opacity: s.opacity }
    })
    assert.ok(channels.every((channel, i) => Math.abs(style.rgba[i] - channel) <= 2), mode + '/' + id + ' retains the subtle dialog tint')
    assert.equal(style.blur.includes('blur('), id === 'glass' || id === 'frosted')
    assert.equal(style.opacity, '1')
    assert.equal(style.rgba[3], id === 'opaque' ? 255 : Math.round(255 * (id === 'transparent' ? .8 : mode === 'dark' ? .58 : .72)))
  }
}
async function checkButtonHover(page, actual) {
  // Escape also closes the remote sidebar drawer when settings unmounts.
  if (await page.locator('[class*=_frame][data-sidebar-collapsed]').count()) {
    await page.locator('.dshTb__mark').click()
    await page.locator('[class*=_frame][data-sidebar-collapsed]').waitFor({ state: 'detached' })
  }
  const button = page.locator('button[class*=_newSession]').first()
  await button.hover()
  await button.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))))
  assert.equal(await button.evaluate(el => getComputedStyle(el).backgroundColor), rgb(actual.tokens['--dsw-alias-button-floating-hover']))
  await page.mouse.move(0, 0)
}
async function prepareAccentControls(page) {
  await page.evaluate(async root => {
    const ctx = window.__COLOR_SCHEMES_SMOKE__
    const workspace = await ctx.workspaces.create({ path: root })
    const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    await ctx.uiWorkspace.openSession(id)
    const directory = ctx.modelDirectories.directoryFor(id)
    await directory.load()
    const result = await directory.select({ provider: 'desktop-smoke', model: 'offline-fixture', reasoningEffort: 'high' })
    if (!result.ok) throw Error(JSON.stringify(result.error))
    await ctx.configForms.get('desktop-appearance').set('reasoningControl', 'slider')
  }, root)
}
async function checkAccentControls(page, label, expected) {
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcut-modal="settings"]').waitFor({ state: 'detached' })
  const drawer = page.locator('.dshMobile__backdrop')
  if (await drawer.isVisible()) {
    await drawer.click()
    await drawer.waitFor({ state: 'hidden' })
  }
  await page.locator('[data-slot="conversation.input.model"] button[aria-haspopup="menu"]').click()
  const slider = page.getByRole('slider', { name: '推理等级', exact: true })
  await slider.waitFor()
  for (const [key, value] of [['End', '5'], ['Home', '0'], ['End', '5']]) {
    await slider.focus()
    await page.keyboard.press(key)
    await page.waitForFunction(value => {
      const input = document.querySelector('.dshReasoning input')
      return input?.value === value && input.getAttribute('aria-disabled') === 'false'
    }, value)
  }
  assert.equal(await page.locator('.dshReasoning__track').evaluate(el => getComputedStyle(el, '::before').backgroundColor), rgb(expected), label + ' filled slider uses the palette accent')
  await page.locator('[data-dsh-reasoning-slider]').screenshot({ path: join(root, label + '-slider.png') })
  await page.keyboard.press('Escape')
  await slider.waitFor({ state: 'detached' })
  await page.evaluate(() => {
    const surface = document.createElement('div')
    surface.id = 'palette-switches'
    Object.assign(surface.style, { position: 'fixed', top: '60px', right: '20px', display: 'flex', gap: '12px', padding: '12px', background: 'var(--dsw-alias-bg-layer-2)', zIndex: '1000' })
    document.body.append(surface)
    window.__UNMOUNT_PALETTE_SWITCHES__ = window.__MOUNT_PALETTE_SWITCHES__(surface)
  })
  const toggle = page.getByRole('switch', { name: 'Palette switch', exact: true })
  await toggle.waitFor()
  try {
    assert.equal(await toggle.evaluate(el => getComputedStyle(el).backgroundColor), rgb(expected), label + ' enabled switch uses the palette accent')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    const inactive = await toggle.evaluate(el => getComputedStyle(el).backgroundColor)
    assert.notEqual(inactive, rgb(expected), label + ' inactive switch remains distinct')
    const disabled = page.getByRole('switch', { name: 'Disabled palette switch', exact: true })
    assert.equal(await disabled.isDisabled(), true)
    assert.equal(await disabled.evaluate(el => getComputedStyle(el).backgroundColor), inactive)
    await toggle.press('Space')
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.equal(await toggle.evaluate(el => getComputedStyle(el).backgroundColor), rgb(expected))
    await page.locator('#palette-switches').screenshot({ path: join(root, label + '-switches.png') })
  } finally {
    await page.evaluate(() => {
      window.__UNMOUNT_PALETTE_SWITCHES__()
      delete window.__UNMOUNT_PALETTE_SWITCHES__
      document.getElementById('palette-switches').remove()
    })
    await page.keyboard.press('Escape')
    await openAppearance(page)
  }
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
  await prepareAccentControls(page)
  await page.locator('[data-dsh-desktop=composer] button[class*=_primary]').waitFor()
  // Inspect the navigation while expanded, where its theme tint occupies space.
  if (await page.locator('[class*=_frame][data-sidebar-collapsed]').count()) {
    await page.locator('.dshTb__mark').click()
    await page.locator('[class*=_frame][data-sidebar-collapsed]').waitFor({ state: 'detached' })
  }
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
      await checkTintedSurfaces(page, p, mode, actual)
      for (const [token, value] of Object.entries({
        '--dsw-alias-bg-base': p.canvas, '--dsw-alias-bg-layer-1': p.panel, '--dsw-alias-bg-module-platform': p.panel,
        '--dsw-alias-label-primary': p.ink, '--dsw-alias-label-secondary': p.muted,
        '--dsw-alias-link': p.accent, '--dsw-alias-button-primary-fill': p.button, '--dsw-alias-border-l3': p.border,
      })) assert.equal(actual.tokens[token].toLowerCase(), value.toLowerCase(), scheme.id + '/' + mode + '/' + token)
      for (const [selector, value] of Object.entries({
        '[class*=_sidebarCol]': p.sidebar, '.dshTb': p.sidebar,
        '[data-dsh-desktop=composer]': p.panel, '[data-dsh-desktop=composer] button[class*=_primary]': p.button,
      })) assert.equal(actual.surfaces[selector]?.background, rgb(value), scheme.id + '/' + mode + '/' + selector)
      const colors = actual.tokens
      assert.equal(colors['--dsw-alias-brand-primary'], p.accent, 'interactive brand token uses the palette accent')
      assert.notEqual(colors['--dsw-alias-brand-primary'], colors['--dsw-alias-label-primary'], 'interactive accent remains distinct from neutral text')
      const layers = [1, 2, 3].map(layer => colors['--dsw-alias-bg-layer-' + layer])
      assert.equal(new Set(layers).size, 3, scheme.id + '/' + mode + ' has distinct surface layers')
      const layerLuminance = layers.map(luminance)
      assert.ok(layerLuminance.every((value, i) => !i || (mode === 'dark'
        ? value > layerLuminance[i - 1] : value < layerLuminance[i - 1])), 'surface brightness follows the theme')
      const hover = colors['--dsw-alias-interactive-bg-hover'], active = colors['--dsw-alias-interactive-bg-active']
      assert.ok(mode === 'dark' ? luminance(hover) < luminance(active) : luminance(hover) > luminance(active), 'hover is quieter than selection')
      const surfaces = [p.canvas, p.sidebar, p.soft, ...layers, hover, active]
      for (const token of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-link']) {
        for (const background of surfaces) {
          assert.ok(contrast(colors[token], background) >= 4.5, scheme.id + '/' + mode + '/' + token + ' is readable on ' + background)
        }
      }
      for (const background of [p.button, p['button-hover']]) {
        assert.ok(contrast(p['on-button'], background) >= 4.5, 'button text is readable at rest and on hover')
      }
      for (const selector of ['[class*=_sidebarCol]', '[data-slot=sidebar]', '.dshTb']) {
        const region = 'sidebar'
        const navigation = actual.surfaces[selector]
        assert.ok(navigation, selector + ' is mounted')
        const navigationHover = navigation.tokens['--dsw-alias-interactive-bg-hover']
        const navigationActive = navigation.tokens['--dsw-alias-interactive-bg-active']
        assert.equal(navigationHover, p[region + '-hover'], selector + ' uses its tinted hover fill')
        assert.equal(navigationActive, p[region + '-selection'], selector + ' uses its tinted selected fill')
        assert.ok(mode === 'dark' ? luminance(navigationHover) < luminance(navigationActive)
          : luminance(navigationHover) > luminance(navigationActive), 'navigation hover is quieter than selection')
        for (const foreground of [p.ink, p.muted, p.accent]) {
          for (const background of [p[region], navigationHover, navigationActive]) {
            assert.ok(contrast(foreground, background) >= 4.5, selector + ' keeps navigation text readable')
          }
        }
      }
      assert.equal(actual.tokens['--dsw-alias-state-success-primary'], baseline[mode].tokens['--dsw-alias-state-success-primary'])
      report.palettes.push({ id: scheme.id, mode, ...actual })
      await page.screenshot({ path: join(root, scheme.id + '-' + mode + '.png'), fullPage: true })
      await page.keyboard.press('Escape')
      await page.locator('.dshAppearance').waitFor({ state: 'hidden' })
      await checkButtonHover(page, actual)
      await page.screenshot({ path: join(root, scheme.id + '-' + mode + '-app.png'), fullPage: true })
      await checkAccentControls(page, scheme.id + '-' + mode, p.accent)
    }
  }
  pass('all twelve variants color actual sidebars, title bars and composers, preserving semantic status colors')
  pass('all twelve variants color enabled switches and filled reasoning sliders, preserving inactive and disabled states and keyboard input')
  pass('all twelve variants have readable neutral text, ordered surface layers and quieter hover fills')
  pass('sidebars and title bars share base, hover and selected colors with readable navigation text')
  pass('all twelve variants gently tint Dialogs, new-session buttons and secondary actions, preserving material opacity and blur')
  await ensureAppearance(page)
  await page.locator('[data-color-scheme=moss]').click()
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dsh-color-scheme') === 'moss' &&
    window.__COLOR_SCHEMES_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.colorScheme === 'moss')
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
    await page.getByRole('group', { name: '输入框/面板效果', exact: true }).getByRole('button', { name: label, exact: true }).click()
    await page.waitForFunction(id => document.documentElement.getAttribute('data-dsh-composer-material') === id, id)
    const style = await composer.evaluate(el => {
      const s = getComputedStyle(el)
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const context = canvas.getContext('2d'); context.fillStyle = s.backgroundColor; context.fillRect(0, 0, 1, 1)
      return { background: s.backgroundColor, rgba: Array.from(context.getImageData(0, 0, 1, 1).data), blur: s.backdropFilter }
    })
    const panelChannels = [1, 3, 5].map(offset => parseInt(colorSchemes.find(scheme => scheme.id === 'moss').dark.panel.slice(offset, offset + 2), 16))
    assert.ok(panelChannels.every((channel, i) => Math.abs(style.rgba[i] - channel) <= 2), id + ' keeps the selected panel tint: ' + style.background)
    assert.equal(style.blur.includes('blur('), id === 'glass' || id === 'frosted')
    if (id === 'glass') assert.ok(/saturate\(1\)/.test(style.blur), 'glass does not boost wallpaper saturation')
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
    assert.deepEqual(paletteColors(await readPalette(page)), paletteColors(baseline[mode]))
    await checkAccentControls(page, 'default-' + mode, baseline[mode].tokens['--dsw-alias-brand-primary'])
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
