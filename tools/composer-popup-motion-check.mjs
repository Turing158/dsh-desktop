import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const source = readFileSync('dsh-plugin/ui-overlay/dom.js', 'utf8').replace(/\r\n/g, '\n')
const gate = source.slice(source.indexOf('  function animationsActive()'), source.indexOf('\n  /** Animate navigation'))
const ghosts = source.slice(source.indexOf('  function ghostKindFor('), source.indexOf('\n  /**\n   * The one open menu'))
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
try {
  const page = await browser.newPage()
  await page.setContent(`<style>${readFileSync('dsh-plugin/ui-overlay/theme.css', 'utf8')}</style>`)
  await page.addScriptTag({ content: `
    var GHOST_ATTRIBUTE='data-dsh-ghost', GHOST_MENU='menu', GHOST_LAYER='layer', GHOST_COLLAPSE='collapse',
      COLLAPSE_ATTRIBUTE='data-dsh-chrome', COLLAPSE_BODY='collapse-body', GHOST_MAX_LIFETIME_MS=240;
    function isVanilla(){return document.documentElement.dataset.dshUi==='vanilla'}
    function isRemotePage(){return false}
    function isOffsetFullSurfaceLayer(){return false}
    ${gate}\n${ghosts}\nwatchRemovalGhosts();` })
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
    const layer = document.createElement('div')
    layer.setAttribute('data-dsh-chrome', 'layer')
    layer.setAttribute('role', 'presentation')
    layer.innerHTML = '<div id="settings-panel" class="fixture_panel" role="dialog" aria-modal="true"><section id="plugin-details"></section></div>'
    document.body.append(layer)
  })
  await page.waitForFunction(() => !document.getElementById('settings-panel').getAnimations().length)
  for (const contents of ['<dl><dt>Plugin</dt><dd>Enabled</dd></dl>', '', '<div><span class="fixture_percent">50%</span></div>', '']) {
    const result = await page.evaluate(async contents => {
      document.getElementById('plugin-details').innerHTML = contents
      await new Promise(requestAnimationFrame)
      const panel = document.getElementById('settings-panel')
      return { animation: getComputedStyle(panel).animationName, running: panel.getAnimations().length,
        opacity: getComputedStyle(panel).opacity, exitKind: ghostKindFor(panel) }
    }, contents)
    assert.deepEqual(result, { animation: 'dsh-desktop-panel-in', running: 0, opacity: '1', exitKind: 'layer' })
  }
  console.log('PASS: adding/removing plugin details does not replay modal entrance or misclassify modal exit')
  console.log('PASS: command/timing/usage/context enter-exit, fixed positioning, inert exits and animation preferences')
} finally { await browser.close() }
