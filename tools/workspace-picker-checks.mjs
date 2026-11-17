import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

/** Exercise saved sessions and the empty-state picker with desktop materials. */
export async function checkWorkspacePicker(page, root, activeId) {
  const region = page.locator('[data-slot="sidebar.workspaces"]')
  const paths = Array.from({ length: 18 }, (_, i) => join(root, 'picker-workspace-' + i))
  await Promise.all(paths.map(path => mkdir(path)))
  await page.evaluate(async paths => {
    for (const path of paths) await window.__ARCHIVE_TEST__.workspaces.create({ path })
  }, paths)
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
    const context = canvas.getContext('2d'); context.fillStyle = '#31465f'; context.fillRect(0, 0, 64, 64)
    const settings = window.__ARCHIVE_TEST__.configForms.get('desktop-appearance')
    for (const [key, value] of Object.entries({ animation: 'on', backgroundImage: canvas.toDataURL(), backgroundNavigation: true,
      backgroundChat: true, backgroundBlur: 20, composerMaterial: 'glass', popupMaterial: 'frosted' })) await settings.set(key, value)
  })
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-dsh-background-left'))
  assert.ok(await region.locator('[data-row-key="session:' + activeId + '"]').isVisible(), 'existing session stays visible with the sidebar background')
  const workspaces = await page.evaluate(activeId => {
    const ctx = window.__ARCHIVE_TEST__
    const items = ctx.workspaces.list.getSnapshot().items
    const first = items.find(item => item.sessionIds.includes(activeId))
    const second = items.find(item => item.title === 'workspace-b')
    ctx.uiWorkspace.startSession(first.workspaceId)
    return [first, second].map(item => ({ id: item.workspaceId, title: item.title }))
  }, activeId)
  await page.locator('[data-composer-card]').waitFor()
  await page.screenshot({ path: join(root, 'workspace-picker-before.png') })
  const trigger = page.locator('[class*="_centerCol"] button').filter({ hasText: workspaces[0].title }).first()
  await trigger.click()
  const menu = page.locator('[role="menu"]:not([data-dsh-ghost])').filter({ has: page.getByRole('menuitem', { name: workspaces[1].title, exact: true }) })
  await menu.waitFor()
  await menu.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)) })
  const anchor = await trigger.boundingBox(), popup = await menu.boundingBox()
  console.log('PICKER GEOMETRY: ' + JSON.stringify({ anchor, popup }))
  assert.ok(Math.abs(popup.x - anchor.x) < 32, 'workspace picker opens at its trigger')
  const closingFrames = await menu.getByRole('menuitem', { name: workspaces[1].title, exact: true }).evaluate(async button => {
    button.click()
    const frames = []
    for (let i = 0; i < 12; i++) {
      await new Promise(requestAnimationFrame)
      const ghost = document.querySelector('[data-dsh-ghost="menu"]')
      if (ghost) frames.push(ghost.getBoundingClientRect().toJSON())
    }
    return frames
  })
  assert.ok(closingFrames.length, 'selection keeps the closing menu visible during its exit')
  assert.ok(closingFrames.every(rect => Math.abs(rect.x - popup.x) < 2 && Math.abs(rect.y - popup.y) < 5),
    'the closing menu stays at its original position after its CSS anchor is removed')
  await menu.waitFor({ state: 'hidden' })
  const nextTrigger = page.locator('[class*="_centerCol"] button').filter({ hasText: workspaces[1].title }).first()
  await nextTrigger.waitFor()
  await nextTrigger.click()
  await menu.waitFor()
  await menu.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)) })
  const nextAnchor = await nextTrigger.boundingBox(), nextPopup = await menu.boundingBox()
  assert.ok(Math.abs(nextPopup.x - nextAnchor.x) < 32, 'workspace picker stays at its trigger after selection')
  await page.screenshot({ path: join(root, 'workspace-picker-after.png') })
  await menu.getByRole('menuitem', { name: workspaces[1].title, exact: true }).focus()
  await page.keyboard.press('Enter')
  await menu.waitFor({ state: 'hidden' })
  const ghost = page.locator('[data-dsh-ghost="menu"]')
  if (await ghost.count()) {
    const rect = await ghost.boundingBox()
    assert.ok(Math.abs(rect.x - nextPopup.x) < 2 && Math.abs(rect.y - nextPopup.y) < 5, 'keyboard selection preserves the exit position')
    assert.equal(await ghost.getAttribute('aria-hidden'), 'true')
    assert.equal(await ghost.evaluate(node => node.inert), true)
  }
  // Reopening during the exit must still resolve to the live menu's anchor.
  const keyboardTrigger = nextTrigger
  await keyboardTrigger.click()
  await menu.waitFor()
  await menu.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)) })
  const reopened = await menu.boundingBox()
  assert.ok(Math.abs(reopened.x - (await keyboardTrigger.boundingBox()).x) < 2, 'rapid reopening retains the live anchor')
  await page.keyboard.press('Escape')
  await ghost.waitFor({ state: 'detached' })
  await page.evaluate(() => window.__ARCHIVE_TEST__.configForms.get('desktop-appearance').set('animation', 'off'))
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dsh-desktop-animation') === 'off')
  await keyboardTrigger.click()
  await menu.waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await ghost.count(), 0, 'animation off closes without an exit copy')
  await page.evaluate(id => window.__ARCHIVE_TEST__.uiWorkspace.openSession(id), activeId)
  await region.locator('[data-row-key="session:' + activeId + '"]').waitFor()
  assert.ok(await region.locator('[data-sidebar-workspace-header]').isVisible(), 'switching in a long list keeps the workspace browser mounted')
  return { anchor, popup, nextAnchor, nextPopup, reopened, closingFrames }
}
