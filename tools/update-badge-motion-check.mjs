import assert from 'node:assert/strict'

/** Check the real React badge, including preference changes during a transition. */
export async function checkUpdateBadgeMotion(page) {
  const badge = page.locator('.dshUpdateBadge'), pill = badge.locator('.dshUpdateBadge__pill')
  const preference = async (value, reduced = 'no-preference') => {
    await page.emulateMedia({ reducedMotion: reduced })
    await page.evaluate(value => window.updateContext.configForms.get('desktop-appearance').set('animation', value), value)
    await page.waitForFunction(value => document.documentElement.getAttribute('data-dsh-desktop-animation') === (value === 'system' ? null : value), value)
  }
  await page.evaluate(() => {
    const service = window.__DSH_DSH_UPDATE__, read = service.getSnapshot
    const initial = read(), previous = document.documentElement.getAttribute('data-dsh-desktop-animation') || 'system'
    let snapshot = initial
    service.getSnapshot = () => snapshot
    window.badgeMotionProbe = {
      previous,
      publish(state) {
        snapshot = { ...initial, busy: state === 'waiting' ? 'waiting' : state === 'installing' ? 'install' : '', error: state === 'error' ? 'motion fixture' : null }
        document.dispatchEvent(new Event('dsh-desktop:dsh-update'))
      },
      restore() { service.getSnapshot = read; document.dispatchEvent(new Event('dsh-desktop:dsh-update')) },
    }
  })
  const publish = state => page.evaluate(state => window.badgeMotionProbe.publish(state), state)
  const pauseTransition = async state => {
    await publish(state)
    await page.waitForFunction(state => document.querySelector('.dshUpdateBadge')?.dataset.state === state, state)
    return pill.evaluate(node => {
      const content = node.querySelector('.dshUpdateBadge__content'), ghost = node.querySelector('.dshUpdateBadge__ghost')
      const animations = content.getAnimations()
      animations.forEach(animation => { animation.pause(); animation.currentTime = 0 })
      const startOpacity = Number(getComputedStyle(content).opacity)
      for (const animation of node.getAnimations({ subtree: true })) {
        if (animation.effect.target.className === 'dshUpdateBadge__spinner') continue
        animation.pause(); animation.currentTime = 60
      }
      return { count: animations.length, startOpacity, opacity: Number(getComputedStyle(content).opacity),
        ghostOpacity: Number(getComputedStyle(ghost).opacity), ghostText: ghost.textContent,
        ghostSpinnerCount: ghost.querySelectorAll('.dshUpdateBadge__spinner').length,
        text: content.textContent, width: node.getBoundingClientRect().width }
    })
  }
  const settle = () => pill.evaluate(node => {
    node.getAnimations({ subtree: true }).forEach(animation => {
      if (animation.effect.target.className !== 'dshUpdateBadge__spinner') animation.finish()
    })
  })
  try {
    for (const [value, reduced, animated] of [
      ['on', 'reduce', true], ['off', 'no-preference', false],
      ['system', 'reduce', false], ['system', 'no-preference', true],
    ]) {
      await preference(value, reduced)
      await publish('available'); await page.waitForTimeout(200)
      await page.mouse.move(400, 200)
      await badge.hover(); await page.waitForTimeout(180)
      const hover = await pill.evaluate(node => ({ transform: getComputedStyle(node).transform, duration: getComputedStyle(node).transitionDuration }))
      assert.equal(hover.transform !== 'none', animated, value + ': hover respects animation preference')
      assert.equal(hover.duration !== '0s', animated, value + ': hover transition respects animation preference')
      await page.mouse.move(400, 200); await page.waitForTimeout(180)
      const waiting = await pauseTransition('waiting')
      assert.equal(waiting.count > 0, animated, value + ': status transition respects animation preference')
      assert.equal(waiting.text, '等待中')
      if (animated) {
        assert.ok(waiting.opacity > 0 && waiting.opacity < 1, 'new content fades in')
        assert.ok(waiting.ghostOpacity > 0 && waiting.ghostOpacity < 1, 'previous content fades out')
        assert.equal(waiting.ghostText, '新版本')
      } else assert.equal(waiting.ghostText, '')
      await settle()
      await page.waitForTimeout(30)
      const spinner = badge.locator('.dshUpdateBadge__content .dshUpdateBadge__spinner')
      const before = await spinner.evaluate(node => getComputedStyle(node).transform)
      await page.waitForTimeout(100)
      assert.equal((await spinner.evaluate(node => getComputedStyle(node).transform)) !== before, animated, value + ': spinner respects animation preference')
    }

    await preference('on')
    await publish('available'); await page.waitForTimeout(200)
    const availableWidth = await pill.evaluate(node => node.getBoundingClientRect().width)
    const waiting = await pauseTransition('waiting')
    const installing = await pauseTransition('installing')
    assert.ok(Math.abs(installing.startOpacity - waiting.opacity) < .001, 'interrupted content continues from its visible opacity')
    assert.equal(installing.text, '更新中')
    await settle(); await page.waitForTimeout(30)
    const error = await pauseTransition('error')
    assert.equal(error.text, '重试')
    assert.ok(error.width < availableWidth && error.width > availableWidth - 11, 'pill width animates between old and new text widths')
    assert.equal(await badge.getAttribute('aria-label'), '更新失败，点击查看并重试')
    await pill.evaluate(node => {
      const content = node.querySelector('.dshUpdateBadge__content')
      window.currentBadgeAnimation = content.getAnimations()[0]
      window.badgeMotionProbe.publish('error')
    })
    await page.waitForTimeout(30)
    assert.ok(await pill.evaluate(node => node.querySelector('.dshUpdateBadge__content').getAnimations()[0] === window.currentBadgeAnimation), 'unchanged content does not restart motion')
    await preference('off')
    assert.equal(await pill.evaluate(node => node.getAnimations({ subtree: true }).length), 0, 'turning animation off cancels the current transition')
    assert.equal(await pill.locator('.dshUpdateBadge__ghost').textContent(), '')

    await preference('system')
    await pauseTransition('waiting')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => document.querySelector('.dshUpdateBadge__pill').getAnimations({ subtree: true }).length === 0)
    assert.equal(await pill.locator('.dshUpdateBadge__ghost').textContent(), '', 'system reduction cancels the current transition')
  } finally {
    await page.evaluate(() => window.badgeMotionProbe.restore())
    const previous = await page.evaluate(() => window.badgeMotionProbe.previous)
    await preference(previous)
    await page.waitForTimeout(200)
    await page.evaluate(() => { delete window.badgeMotionProbe; delete window.currentBadgeAnimation })
  }
}
