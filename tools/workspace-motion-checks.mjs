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
    for (let i = 1; i <= 8; i++) {
      const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
      const title = 'Motion session ' + i
      const response = await fetch('/archive-smoke/seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, title, turns: 1 }) })
      if (!response.ok) throw Error(await response.text())
      const held = ctx.sessions.retain(id, { source: 'motion-fixture' }); await held.ready
      await held.binding.session.rename(title); held.release()
    }
    ctx.uiWorkspace.openSession(activeId)
    return workspace.workspaceId
  }, activeId)
  const project = region.locator('[data-row-key="workspace:' + workspaceId + '"]')
  const overflow = region.locator('[data-row-key="overflow:' + workspaceId + '"]')
  await overflow.waitFor()
  await settle()
  await page.evaluate(() => {
    window.workspaceMotionCalls = []
    const animate = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      if (this.closest('[data-slot="sidebar.workspaces"]')) window.workspaceMotionCalls.push({ key: this.getAttribute('data-row-key'), frames, options })
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
    const result = await locator.evaluate(async node => {
      const root = node.closest('[data-slot="sidebar.workspaces"]'), frames = []
      window.workspaceMotionCalls = []
      node.click()
      const start = performance.now()
      while (performance.now() - start < 260) {
        await new Promise(requestAnimationFrame)
        frames.push([...root.querySelectorAll('[data-row-key]')].map(row => ({ key: row.dataset.rowKey, y: row.getBoundingClientRect().top, opacity: getComputedStyle(row).opacity })))
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
    assert.ok([...values.values()].some(values => values.size > 2), label + ' interpolates over multiple frames')
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
  assert.equal(await searchMotion(), 1, 'search expands immediately with motion off')
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
