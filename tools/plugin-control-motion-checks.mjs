import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Run inside the isolated, real DSH acceptance profile. Sample rendered frames,
// rather than only checking that a stylesheet contains transition declarations.
export async function checkPluginMotion(page, root) {
  const evidence = []
  async function preference(animation, reducedMotion = 'no-preference') {
    await page.emulateMedia({ reducedMotion })
    await page.evaluate(animation => window.__PLUGIN_SMOKE__.configForms.get('desktop-appearance').set('animation', animation), animation)
    await page.waitForFunction(animation => document.documentElement.getAttribute('data-dsh-desktop-animation') === (animation === 'system' ? null : animation), animation)
  }
  async function sample(selector, kind) {
    const frames = await page.evaluate(async ({ selector, kind }) => {
      const target = document.querySelector(selector)
      const card = target.closest('.dshPlugins__card')
      const reveal = kind === 'switch' ? document.querySelector('.dshPlugins__restartReveal') : card.querySelector('.dshPlugins__reveal')
      const read = () => ({
        height: reveal.getBoundingClientRect().height,
        opacity: Number(getComputedStyle(reveal.querySelector('.dshPlugins__revealContent')).opacity),
        visibility: getComputedStyle(reveal).visibility,
        inert: reveal.inert,
        cardHeight: card.getBoundingClientRect().height,
        listTop: document.querySelector('.dshPlugins__cards').getBoundingClientRect().top,
        footnoteTop: document.querySelector('.dshPlugins__footnote').getBoundingClientRect().top,
        content: Boolean(reveal.querySelector('.dshPlugins__details,.dshPlugins__restart')),
        checked: target.getAttribute('aria-checked'),
        expanded: target.getAttribute('aria-expanded'),
        thumb: kind === 'switch' ? getComputedStyle(target.firstElementChild).transform : null,
        track: getComputedStyle(target).backgroundColor,
        transitions: reveal.getAnimations({ subtree: true }).map(animation => animation.transitionProperty),
      })
      const frames = [read()], initial = kind === 'switch' ? frames[0].checked : frames[0].expanded
      target.click()
      const start = performance.now()
      let changedAt
      while (performance.now() - start < 5000) {
        await new Promise(requestAnimationFrame)
        const frame = read()
        frames.push(frame)
        if ((kind === 'switch' ? frame.checked : frame.expanded) !== initial) changedAt ??= performance.now()
        if (changedAt !== undefined && performance.now() - changedAt > 300 && !target.disabled) break
      }
      return frames
    }, { selector, kind })
    evidence.push({ selector, kind, frames })
    return frames
  }
  function continuous(frames, key, message) {
    const start = frames[0][key], end = frames.at(-1)[key]
    assert.ok(Math.abs(start - end) > 1, message + ': endpoints differ')
    const between = frames.filter(frame => frame[key] > Math.min(start, end) + .1 && frame[key] < Math.max(start, end) - .1)
    assert.ok(new Set(between.map(frame => frame[key])).size >= 3, message + ': multiple intermediate positions')
  }
  const switchSelector = '[data-plugin-id="desktop-sidebar-terminal"] [role=switch]'
  try {
    await preference('on')
    for (const card of await page.locator('.dshPlugins__card').all()) {
      await page.mouse.move(0, 0)
      await page.waitForTimeout(220)
      await card.hover()
      const hover = await card.evaluate(node => [...node.getAnimations(), ...node.querySelector('.dshPlugins__head').getAnimations()].map(animation => animation.transitionProperty))
      assert.ok(hover.includes('background-color'), 'every card animates its hovered header')
      const id = await card.getAttribute('data-plugin-id')
      const selector = '[data-plugin-id="' + id + '"] .dshPlugins__disclosure'
      const opening = await sample(selector, 'disclosure')
      continuous(opening, 'height', id + ' opens')
      const closing = await sample(selector, 'disclosure')
      continuous(closing, 'height', id + ' closes')
      assert.ok(closing.some(frame => frame.height > 0 && frame.height < closing[0].height && frame.content), 'closing content stays mounted')
      assert.equal(closing.at(-1).height, 0)
      assert.equal(closing.at(-1).content, false)
      assert.equal(closing.at(-1).inert, true, 'closed details cannot receive keyboard focus')
    }
    for (const opening of [true, false]) {
      const frames = await sample(switchSelector, 'switch')
      continuous(frames, 'height', 'restart card ' + (opening ? 'enters' : 'exits'))
      continuous(frames, 'listTop', 'plugin list follows restart card')
      assert.ok(frames.some(frame => frame.opacity > 0 && frame.opacity < 1), 'restart card fades')
      assert.ok(new Set(frames.map(frame => frame.thumb)).size >= 3, 'switch thumb slides')
      assert.ok(new Set(frames.map(frame => frame.track)).size >= 3, 'switch track changes color smoothly')
      if (!opening) {
        assert.equal(frames.at(-1).height, 0)
        assert.equal(frames.at(-1).content, false)
        assert.equal(frames.at(-1).inert, true)
      }
    }
    console.log('PASS: all plugin cards hover/open/close; switch, restart fade and document flow interpolate')

    for (const [animation, reducedMotion, enabled] of [
      ['off', 'no-preference', false], ['system', 'reduce', false], ['on', 'reduce', true], ['system', 'no-preference', true],
    ]) {
      await preference(animation, reducedMotion)
      for (const kind of ['disclosure', 'switch']) {
        const selector = kind === 'switch' ? switchSelector : '[data-plugin-id="desktop-notify"] .dshPlugins__disclosure'
        for (let i = 0; i < 2; i++) {
          const frames = await sample(selector, kind)
          const moving = frames.some(frame => frame.transitions.includes('grid-template-rows'))
          assert.equal(moving, enabled, animation + '/' + reducedMotion + ' gates ' + kind)
          if (!enabled) {
            assert.ok(frames.every(frame => frame.height === frames[0].height || frame.height === frames.at(-1).height), 'motion off applies final layout immediately')
            if (kind === 'switch') assert.ok(new Set(frames.map(frame => frame.thumb)).size <= 2, 'motion off snaps the thumb')
          }
        }
      }
    }
    console.log('PASS: off/system/on and reduced motion gate expansion, switches, restart and layout')

    await preference('on')
    const disclosure = '[data-plugin-id="desktop-sidebar-terminal"] .dshPlugins__disclosure'
    await page.locator(disclosure).evaluate(node => node.click())
    await page.waitForTimeout(60)
    await page.locator(disclosure).evaluate(node => node.click())
    await page.waitForTimeout(40)
    await page.locator(disclosure).evaluate(node => node.click())
    await page.waitForTimeout(280)
    assert.equal(await page.locator(disclosure).getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('#dsh-plugin-details-desktop-sidebar-terminal .dshPlugins__details').count(), 1)
    await page.locator(disclosure).evaluate(node => node.click())
    await page.waitForTimeout(60)
    await preference('off')
    await page.waitForFunction(() => !document.querySelector('#dsh-plugin-details-desktop-sidebar-terminal .dshPlugins__details'))
    assert.equal(await page.locator('#dsh-plugin-details-desktop-sidebar-terminal').evaluate(node => node.getBoundingClientRect().height), 0)
    console.log('PASS: rapid reversals and disabling motion mid-close release retained content')
  } finally {
    await writeFile(join(root, 'motion-frames.json'), JSON.stringify(evidence, null, 2))
    await preference('off')
  }
}
