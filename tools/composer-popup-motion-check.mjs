import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const source = readFileSync('dsh-plugin/ui-overlay/dom.js', 'utf8').replace(/\r\n/g, '\n')
const startup = '\n  watchRemovalGhosts()\n'
assert.ok(source.includes(startup))
const overlay = source.replace(startup, '\n  window.popupExitKind = ghostKindFor' + startup)
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
try {
  const page = await browser.newPage()
  await page.setContent(`<style>${readFileSync('dsh-plugin/ui-overlay/theme.css', 'utf8')}</style>`)
  await page.addScriptTag({ content: overlay })
  const show = kind => page.evaluate(kind => {
    const node = document.createElement('div')
    node.id = 'popup'
    node.style.cssText = 'position:fixed;left:100px;top:150px;width:280px;height:180px'
    if (kind === 'commands') { node.setAttribute('data-trigger-menu', ''); node.innerHTML = '<div role="listbox"><div role="option">Command</div></div>' }
    else {
      node.className = 'fixture_panel'; node.setAttribute('role', 'dialog')
      node.innerHTML = kind === 'context' ? '<div><span class="fixture_percent">39%</span></div>' : '<dl><dt>Usage</dt><dd>100</dd></dl>'
    }
    document.body.append(node)
    return getComputedStyle(node).animationName
  }, kind)
  const close = () => page.evaluate(() => document.getElementById('popup').remove())
  for (const kind of ['commands', 'timing', 'usage', 'context']) {
    assert.equal(await show(kind), 'dsh-composer-popup-in')
    await page.waitForFunction(() => !document.getElementById('popup').getAnimations().length)
    await close()
    assert.equal(await page.locator('[data-dsh-ghost=menu]').count(), 1)
    assert.deepEqual(await page.locator('[data-dsh-ghost]').evaluate(n => ({inert:n.inert,hidden:n.getAttribute('aria-hidden'),left:n.style.left,top:n.style.top,animation:getComputedStyle(n).animationName})),
      {inert:true,hidden:'true',left:'100px',top:'150px',animation:'dsh-desktop-menu-out'})
    await page.waitForFunction(() => !document.querySelector('[data-dsh-ghost]'))
  }
  for (const pref of ['off', 'system', 'on', 'vanilla']) {
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.evaluate(pref => {
      document.documentElement.dataset.dshDesktopAnimation = pref
      document.documentElement.dataset.dshUi = pref === 'vanilla' ? 'vanilla' : 'desktop'
    }, pref)
    for (const kind of ['commands', 'usage', 'context']) {
      assert.equal(await show(kind), pref === 'on' ? 'dsh-composer-popup-in' : 'none')
      await close()
      assert.equal(await page.locator('[data-dsh-ghost]').count(), pref === 'on' ? 1 : 0)
      await page.waitForFunction(() => !document.querySelector('[data-dsh-ghost]'))
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.dshUi = 'desktop'
    document.documentElement.dataset.dshDesktopAnimation = 'on'
    const menu = document.createElement('div')
    menu.id = 'inline-submenu-parent'
    menu.setAttribute('role', 'menu')
    menu.style.cssText = 'position:fixed;left:300px;top:180px'
    menu.innerHTML = `<div><button role="menuitem">Parent item</button>
      <div role="menu" data-dsh-desktop="nested-menu" style="--dsh-menu-left:440px;--dsh-menu-top:180px">
        <button role="menuitem">Child item</button>
      </div></div>`
    document.body.append(menu)
  })
  const inlineMenu = await page.locator('#inline-submenu-parent').evaluate(async menu => {
    await Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished))
    const submenu = menu.querySelector('[data-dsh-desktop="nested-menu"]')
    const before = submenu.getBoundingClientRect().toJSON()
    menu.remove()
    await new Promise(requestAnimationFrame)
    const ghost = document.querySelector('[data-dsh-ghost="menu"] [data-dsh-desktop="nested-menu"]')
    return { before, after: ghost.getBoundingClientRect().toJSON(), animation: getComputedStyle(ghost).animationName }
  })
  assert.deepEqual(inlineMenu.after, inlineMenu.before, 'the submenu fades with its parent in place')
  assert.equal(inlineMenu.animation, 'none', 'the exiting submenu does not replay its entrance')
  await page.waitForFunction(() => !document.querySelector('[data-dsh-ghost]'))
  console.log('PASS: dismissing a parent menu keeps its inline submenu in place')

  await page.evaluate(() => {
    const layer = document.createElement('div')
    layer.setAttribute('role', 'presentation')
    layer.style.cssText = 'position:fixed;inset:0'
    layer.innerHTML = '<div id="settings-panel" class="fixture_panel" role="dialog" aria-modal="true"><section id="plugin-details"></section></div>'
    document.body.append(layer)
  })
  await page.locator('[data-dsh-chrome="layer"] > #settings-panel').waitFor({ state: 'attached' })
  await page.waitForFunction(() => !document.getElementById('settings-panel').getAnimations().length)
  for (const contents of ['<dl><dt>Plugin</dt><dd>Enabled</dd></dl>', '', '<div><span class="fixture_percent">50%</span></div>', '']) {
    const result = await page.evaluate(async contents => {
      document.getElementById('plugin-details').innerHTML = contents
      await new Promise(requestAnimationFrame)
      const panel = document.getElementById('settings-panel')
      return { animation: getComputedStyle(panel).animationName, running: panel.getAnimations().length,
        opacity: getComputedStyle(panel).opacity, exitKind: window.popupExitKind(panel) }
    }, contents)
    assert.deepEqual(result, { animation: 'dsh-desktop-panel-in', running: 0, opacity: '1', exitKind: 'layer' })
  }
  console.log('PASS: adding/removing plugin details does not replay modal entrance or misclassify modal exit')
  console.log('PASS: command/timing/usage/context enter-exit, fixed positioning, inert exits and animation preferences')
} finally { await browser.close() }
