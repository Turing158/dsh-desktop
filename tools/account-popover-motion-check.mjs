/** Exercise real browser animation interruption and the shared preference contract. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage()
  await page.setContent('<button id="trigger">Account</button>')
  await page.addScriptTag({ content: readFileSync('dsh-plugin/account-popover/motion.mjs', 'utf8').replace('export function', 'function') })
  await page.evaluate(() => {
    window.resetMotion = () => {
      window.motion?.dispose(); window.panel?.remove(); window.hiddenCount = 0
      window.panel = document.createElement('section')
      panel.style.cssText = 'position:fixed;left:10px;top:100px;width:318px;height:209px;background:white'
      panel.innerHTML = '<button>Feedback</button>'
      document.body.append(panel)
      window.motion = createPopoverMotion(document, () => { hiddenCount++; panel.remove() })
    }
  })
  for (const [preference, reduced, expected] of [
    ['off', 'no-preference', false], ['on', 'reduce', true],
    ['system', 'reduce', false], ['system', 'no-preference', true], ['vanilla', 'no-preference', false],
  ]) {
    await page.emulateMedia({ reducedMotion: reduced })
    const state = await page.evaluate(preference => {
      document.documentElement.setAttribute('data-dsh-ui', preference === 'vanilla' ? 'vanilla' : 'desktop')
      document.documentElement.setAttribute('data-dsh-desktop-animation', preference)
      resetMotion(); motion.update(true, panel)
      const entering = panel.getAnimations().length
      panel.getAnimations().forEach(animation => animation.finish())
      motion.update(false, panel)
      return { entering, exiting: panel.getAnimations().length, hiddenCount }
    }, preference)
    assert.equal(state.entering, expected ? 1 : 0)
    assert.equal(state.exiting, expected ? 1 : 0)
    assert.equal(state.hiddenCount, expected ? 0 : 1)
    if (expected) await page.waitForFunction(() => hiddenCount === 1 && !panel.isConnected)
  }
  console.log('PASS: on/off/system/reduced-motion/vanilla gates apply to both directions')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const interrupted = await page.evaluate(() => {
    document.documentElement.setAttribute('data-dsh-ui', 'desktop')
    document.documentElement.setAttribute('data-dsh-desktop-animation', 'on')
    resetMotion(); motion.update(true, panel)
    let animation = panel.getAnimations()[0]
    animation.pause(); animation.currentTime = 55
    const enteringOpacity = Number(getComputedStyle(panel).opacity)
    motion.update(false, panel)
    animation = panel.getAnimations()[0]; animation.pause(); animation.currentTime = 0
    const closingStart = Number(getComputedStyle(panel).opacity)
    animation.currentTime = 65
    const closingOpacity = Number(getComputedStyle(panel).opacity)
    motion.update(true, panel)
    animation = panel.getAnimations()[0]; animation.pause(); animation.currentTime = 0
    const reopeningStart = Number(getComputedStyle(panel).opacity)
    motion.update(true, panel)
    return { enteringOpacity, closingStart, closingOpacity, reopeningStart, count: panel.getAnimations().length,
      same: animation === panel.getAnimations()[0], hiddenCount }
  })
  assert.ok(interrupted.enteringOpacity > 0 && interrupted.enteringOpacity < 1)
  assert.ok(Math.abs(interrupted.closingStart - interrupted.enteringOpacity) < .001)
  assert.ok(interrupted.closingOpacity < interrupted.closingStart)
  assert.ok(Math.abs(interrupted.reopeningStart - interrupted.closingOpacity) < .001)
  assert.equal(interrupted.count, 1); assert.equal(interrupted.same, true); assert.equal(interrupted.hiddenCount, 0)
  await page.evaluate(() => document.documentElement.setAttribute('data-dsh-desktop-animation', 'off'))
  await page.waitForFunction(() => panel.getAnimations().length === 0 && getComputedStyle(panel).opacity === '1')
  console.log('PASS: rapid toggles continue from the visible frame; updates do not restart entrance')

  for (const kind of ['switch', 'system']) {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(kind => {
      document.documentElement.setAttribute('data-dsh-desktop-animation', kind === 'switch' ? 'on' : 'system')
      resetMotion(); motion.update(true, panel)
      panel.getAnimations().forEach(animation => animation.finish())
      motion.update(false, panel); panel.getAnimations()[0].pause()
    }, kind)
    if (kind === 'switch') await page.evaluate(() => document.documentElement.setAttribute('data-dsh-desktop-animation', 'off'))
    else await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => hiddenCount === 1 && !panel.isConnected)
  }
  await page.evaluate(() => { motion.dispose(); document.documentElement.setAttribute('data-dsh-ui', 'vanilla') })
  assert.equal(await page.evaluate(() => hiddenCount), 1)
  console.log('PASS: disabling motion during exit removes it immediately; teardown releases observers')
} finally { await browser.close() }
