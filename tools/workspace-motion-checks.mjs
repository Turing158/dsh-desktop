import assert from 'node:assert/strict'
import { join } from 'node:path'

/** Run against the archive smoke's real DSH profile, with no model requests. */
export async function checkWorkspaceMotion(page, root, activeId) {
  const region = page.locator('[data-slot="sidebar.workspaces"]')
  const settle = () => page.waitForFunction(() => {
    const region = document.querySelector('[data-slot="sidebar.workspaces"]')
    return region && !region.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
  })
  const workspaceId = await page.evaluate(async activeId => {
    const ctx = window.__ARCHIVE_TEST__
    const workspace = ctx.workspaces.list.getSnapshot().items.find(workspace => workspace.sessionIds.includes(activeId))
    let newest = activeId
    for (let i = 1; i <= 8; i++) {
      const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
      newest = id
      const title = 'Motion session ' + i
      const response = await fetch('/archive-smoke/seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, title, turns: 1 }) })
      if (!response.ok) throw Error(await response.text())
      const held = ctx.sessions.retain(id, { source: 'motion-fixture' }); await held.ready
      await held.binding.session.rename(title); held.release()
    }
    // New clients automatically raise the row watermark to reveal the current
    // Session. Keep it near the top, then remount the list to reset that watermark.
    ctx.uiWorkspace.openSession(newest)
    const view = window.__DSH_ARCHIVE_SMOKE__.view
    view.actions.setGroupBy('flat')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    view.actions.setGroupBy('workspace')
    return workspace.workspaceId
  }, activeId)
  const project = region.locator('[data-row-key="workspace:' + workspaceId + '"]')
  const overflow = region.locator('[data-row-key="overflow:' + workspaceId + '"]')
  await overflow.waitFor()
  await settle()
  await page.evaluate(() => {
    window.workspaceMotionCalls = []
    window.workspaceMotionNodes = []
    const animate = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      if (this.closest('[data-slot="sidebar.workspaces"]')) {
        window.workspaceMotionCalls.push({ key: this.getAttribute('data-row-key'), frames, options })
        window.workspaceMotionNodes.push(this)
      }
      return animate.call(this, frames, options)
    }
  })
  const preference = async (animation, reduced = false) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
    await page.evaluate(animation => window.__ARCHIVE_TEST__.configForms.get('desktop-appearance').set('animation', animation), animation)
    await page.waitForFunction(animation => (document.documentElement.getAttribute('data-dsh-desktop-animation') || 'system') === animation, animation)
    await settle()
  }
  const sample = async locator => {
    // Only visible rows are animated. Long workspace lists put this fixture
    // below the viewport, so exercise it through the same scroll as a user.
    await locator.scrollIntoViewIfNeeded()
    if (await locator.getAttribute('class').then(value => value?.includes('dshArchive__toggle'))) {
      // The archive and workspace views share a scroll container. Reset the
      // fixture's prior scroll before sampling a different list's visible rows.
      await region.locator('[role="tree"]').evaluate(tree => {
        const root = tree.closest('[data-slot="sidebar.workspaces"]')
        for (let node = tree; node && node !== root; node = node.parentElement) node.scrollTop = 0
      })
    }
    await settle()
    const result = await locator.evaluate(async node => {
      const root = node.closest('[data-slot="sidebar.workspaces"]'), frames = []
      window.workspaceMotionCalls = []
      window.workspaceMotionNodes = []
      node.click()
      // A large view can take longer than the animation to commit. Start the
      // sampling window on its first frame, after that synchronous render.
      let start
      while (start === undefined || performance.now() - start < 260) {
        await new Promise(requestAnimationFrame)
        start ??= performance.now()
        // Sampling every imported row and ancestor can itself consume an entire
        // animation frame. Measure a bounded set of the actual animation targets.
        const rows = [...new Set(window.workspaceMotionNodes)].filter(node => node.isConnected).slice(0, 8)
        const opacities = new Map()
        const paintedOpacity = row => {
          if (!row || row === root) return 1
          if (!opacities.has(row)) opacities.set(row, Number(getComputedStyle(row).opacity) * paintedOpacity(row.parentElement))
          return opacities.get(row)
        }
        frames.push(rows.map((row, index) => {
          const opacity = paintedOpacity(row)
          const motionIndex = window.workspaceMotionNodes.indexOf(row)
          return { key: row.dataset.rowKey || (motionIndex >= 0 ? 'animation:' + motionIndex : 'exit:' + index), y: row.getBoundingClientRect().top, opacity }
        }))
      }
      return { frames, calls: window.workspaceMotionCalls }
    })
    return result
  }
  const samples = []
  const expectMotion = (result, label) => {
    assert.ok(result.calls.length, label + ' starts row animations')
    const values = new Map()
    for (const frame of result.frames) for (const row of frame) {
      if (!values.has(row.key)) values.set(row.key, new Set())
      values.get(row.key).add(row.y.toFixed(2) + ':' + row.opacity)
    }
    assert.ok([...values.values()].some(values => values.size > 2), label + ' interpolates over multiple frames: ' + JSON.stringify({
      frameCount: result.frames.length, callCount: result.calls.length,
      first: result.frames[0]?.slice(0, 5), last: result.frames.at(-1)?.slice(0, 5),
    }))
    samples.push({ label, calls: result.calls.length })
  }
  await preference('on', true)
  const searchMotion = async () => region.locator('[class*="_searchSlot"]').evaluate(async slot => {
    const widths = new Set()
    slot.querySelector('button').click()
    const start = performance.now()
    while (performance.now() - start < 230) {
      await new Promise(requestAnimationFrame)
      widths.add(slot.getBoundingClientRect().width.toFixed(2))
    }
    window.workspaceSearchMotion = { widths: [...widths], elements: [...slot.parentElement.children].map(node => ({
      className: node.className, transition: getComputedStyle(node).transition, animation: getComputedStyle(node).animation,
    })), mode: document.documentElement.getAttribute('data-dsh-desktop-animation') }
    return widths.size
  })
  assert.ok(await searchMotion() > 2, 'search expands even when explicit on overrides OS reduced motion')
  await page.keyboard.press('Escape')
  await settle()
  expectMotion(await sample(project), 'workspace collapse')
  expectMotion(await sample(project), 'workspace expand')
  expectMotion(await sample(overflow), 'expand remaining sessions')
  expectMotion(await sample(overflow), 'collapse remaining sessions')

  // Closing and reopening before the last frame must not retain exit copies.
  await project.evaluate(async node => { node.click(); await new Promise(resolve => setTimeout(resolve, 45)); node.click() })
  await settle()
  assert.equal(await project.getAttribute('aria-expanded'), 'true')
  assert.equal(await region.locator('[class*="_exits"] > *').count(), 0)
  await project.evaluate(node => node.click())
  await preference('off')
  assert.equal(await region.locator('[class*="_exits"] > *').count(), 0)
  await searchMotion()
  const offSearch = await page.evaluate(() => window.workspaceSearchMotion)
  // The current sidebar scrollbar can change the available width even while
  // search itself has no motion. Verify the header's actual animation contract.
  assert.ok(offSearch.elements.every(node => node.transition === 'none' && node.animation === 'none'),
    'search and adjacent header controls have no transitions or animations with motion off')
  await page.keyboard.press('Escape')
  await settle()
  for (const animation of ['off', 'system']) {
    await preference(animation, animation === 'system')
    for (let i = 0; i < 2; i++) assert.equal((await sample(project)).calls.length, 0, animation + ' skips both directions')
    assert.equal(await project.locator('[class*="_arrow"]').evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  }
  await preference('system', false)
  expectMotion(await sample(project), 'system permits motion')
  // The workspace was closed before the preference matrix; the last click opens it.
  await preference('on')
  await page.evaluate(() => {
    const view = window.__DSH_ARCHIVE_SMOKE__.view
    view.actions.setGroupBy('flat')
  })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="sidebar.workspaces"] [class*="_treeBody"]')].some(node => node.getAnimations().length))
  await settle()
  await page.evaluate(() => window.__DSH_ARCHIVE_SMOKE__.view.actions.setGroupBy('workspace'))
  await settle()
  const toggle = page.locator('.dshArchive__toggle')
  expectMotion(await sample(toggle), 'switch to archive')
  expectMotion(await sample(toggle), 'switch to workspace')
  await preference('off')
  await page.evaluate(() => window.__DSH_ARCHIVE_SMOKE__.view.actions.setGroupBy('flat'))
  await settle()
  assert.equal(await region.locator('[class*="_treeBody"]').evaluate(node => getComputedStyle(node).animationName), 'none')
  await page.evaluate(() => window.__DSH_ARCHIVE_SMOKE__.view.actions.setGroupBy('workspace'))
  await settle()
  await page.screenshot({ path: join(root, 'workspace-motion-settled.png') })
  return samples
}
