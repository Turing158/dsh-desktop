import assert from 'node:assert/strict'
import { join } from 'node:path'

// Runs inside composer-material-smoke's disposable profile. Real MenuSurface,
// Tooltip and HoverCard primitives cover the structures supplied by upstream;
// live application menus below cover placement, dismissal and keyboard input.
export async function checkPopupMaterials(page, { appearance, section, root, pass }) {
  const group = () => page.getByRole('group', { name: '弹出层效果', exact: true })
  const set = (field, value) => page.evaluate(([field, value]) =>
    window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').set(field, value), [field, value])
  const controls = [
    ['transparent', '透明', '底色透明度', 'popupTransparency', 70],
    ['frosted', '纯磨砂', '纯磨砂效果程度', 'popupFrostedIntensity', 75],
    ['glass', '毛玻璃', '毛玻璃效果程度', 'popupGlassIntensity', 25],
  ]
  async function read(locator) {
    return locator.evaluate(node => {
      const s = getComputedStyle(node), r = node.getBoundingClientRect()
      const backdrop = getComputedStyle(node, '::before')
      const filter = backdrop.content !== 'none' ? backdrop.backdropFilter : s.backdropFilter
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d'); ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1)
      return { alpha: ctx.getImageData(0, 0, 1, 1).data[3] / 255, color: s.color,
        blur: Number(filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0),
        filter, shadow: s.boxShadow, background: s.backgroundImage,
        opacity: s.opacity, width: r.width, height: r.height,
        backdropWidth: parseFloat(backdrop.width), backdropHeight: parseFloat(backdrop.height),
        innerWidth: node.clientWidth, innerHeight: node.clientHeight }
    })
  }
  await appearance()
  const initial = await section()
  const dialogBefore = await read(page.locator('[data-shortcut-modal=settings]'))
  const composerBefore = await read(page.locator('[data-dsh-desktop=composer]').first())
  for (const [id, label, name, field, value] of controls) {
    await group().getByRole('button', { name: label, exact: true }).click()
    const slider = group().getByRole('slider', { name, exact: true })
    await slider.fill(String(value))
    assert.equal((await section())[field], undefined, 'drag only previews its own setting')
    await slider.dispatchEvent('pointerup')
    await page.waitForFunction(([field, value]) => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value[field] === value, [field, value])
    assert.equal((await section()).popupMaterial, id)
  }
  assert.deepEqual(await read(page.locator('[data-shortcut-modal=settings]')), dialogBefore)
  assert.deepEqual(await read(page.locator('[data-dsh-desktop=composer]').first()), composerBefore)
  await page.setViewportSize({ width: 375, height: 812 })
  const slider = group().getByRole('slider', { name: '毛玻璃效果程度', exact: true })
  await slider.scrollIntoViewIfNeeded()
  assert.ok((await slider.boundingBox()).width >= 200)
  await slider.press('ArrowRight')
  await page.waitForFunction(() => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.popupGlassIntensity === 26)
  await slider.press('ArrowLeft')
  await page.waitForFunction(() => window.__SETTINGS_SMOKE__.configForms.get('desktop-appearance').getSnapshot().value.popupGlassIntensity === 25)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(root, 'mobile-popup-settings.png') })
  await page.setViewportSize({ width: 1280, height: 840 })
  await group().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(root, 'popup-settings.png') })
  await page.getByRole('button', { name: '字号大小', exact: true }).click()
  const liveMenu = () => page.locator('[role=menu]:visible:not([data-dsh-ghost])').last()
  await liveMenu().waitFor()
  assert.equal((await read(liveMenu())).blur, 9, 'settings dropdown uses popup strength, not Dialog strength')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcut-modal=settings]').waitFor({ state: 'hidden' })
  await set('animation', 'off')
  pass('popup controls preview, persist and support keyboard/narrow layouts independently of Dialog and composer')

  await page.evaluate(() => {
    const { React, createRoot, ui } = window.__POPUP_SMOKE__, h = React.createElement
    const host = document.createElement('div'); host.id = 'popup-material-fixtures'
    host.style.cssText = 'position:fixed;left:540px;top:160px;z-index:1500;display:grid;grid-template-columns:repeat(2,220px);gap:20px;padding:24px;background:repeating-linear-gradient(45deg,#487bcd 0px 3px,#dbad71 3px 6px)'
    document.body.appendChild(host)
    const button = text => h('button', { role: 'menuitem' }, text)
    const fixture = (id, extra = {}) => ({ 'data-popup-fixture': id, ...extra })
    const root = createRoot(host)
    root.render(h(React.Fragment, null,
      h(ui.MenuSurface, fixture('menu', { role: 'menu' }), button('Menu item')),
      h(ui.MenuSurface, fixture('model', { role: 'group' }), h('div', { role: 'menu', 'data-popup-inner': '' }, button('Model'))),
      h(ui.MenuSurface, fixture('completion', { 'data-trigger-menu': '' }), h('div', { role: 'listbox', 'data-popup-inner': '' }, h('div', { role: 'option' }, 'Completion'))),
      h(ui.MenuSurface, fixture('jobs'), h('ul', null, h('li', null, 'Background task'))),
      h('div', fixture('select', { className: '_card_popupSmoke', style: { position: 'relative' } }), h('div', { role: 'listbox', 'data-popup-inner': '' }, h('div', { role: 'option' }, 'Select option'))),
      h('div', fixture('dock', { 'data-dockkit-tab-menu': '', style: { position: 'relative' } }), button('Dock menu')),
      h('section', fixture('account', { className: 'dshAccount', 'data-dsh-account-popover': '', role: 'dialog', 'aria-modal': 'false', style: { position: 'relative', width: 200, padding: 12 } }), 'Account panel'),
      h(ui.Tooltip, { label: 'Popup tooltip', side: 'bottom', portal: true }, h('button', { id: 'popup-tooltip-anchor' }, 'Tooltip')),
      h(ui.HoverCard, { anchor: h('button', { id: 'popup-hover-anchor' }, 'Hover card'), content: 'Popup hover content', openDelayMs: 0 })))
    window.__UNMOUNT_POPUP_FIXTURES__ = () => { root.unmount(); host.remove() }
  })
  await page.locator('[data-popup-fixture=menu]').waitFor()
  const ids = ['menu', 'model', 'completion', 'jobs', 'select', 'dock', 'account']
  for (const dark of [false, true]) {
    await page.evaluate(dark => window.__SETTINGS_SMOKE__.configForms.get('ui-theme').set('preference', dark ? 'dark' : 'light'), dark)
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, dark)
    await set('popupMaterial', 'opaque')
    const opaque = Object.fromEntries(await Promise.all(ids.map(async id => [id, await read(page.locator('[data-popup-fixture=' + id + ']'))])))
    for (const [id, surface] of Object.entries(opaque)) {
      assert.equal(surface.alpha, 1, 'opaque completely covers the background: ' + id)
      assert.equal(surface.blur, 0, 'opaque has no backdrop blur: ' + id)
    }
    assert.ok((await page.locator('#popup-material-fixtures [class*=_material]').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).display))).every(display => display === 'none'), 'opaque hides upstream translucent backings')
    for (const [id, , , field, value] of controls) {
      await set('popupMaterial', id)
      for (const level of [0, 50, 100]) {
        await set(field, level)
        for (const surface of ids) {
          const actual = await read(page.locator('[data-popup-fixture=' + surface + ']'))
          assert.equal(actual.blur, id === 'transparent' ? 0 : level * .36, surface + '/' + id)
          assert.equal(actual.opacity, '1', surface + ' keeps text opaque')
          assert.equal(actual.width, opaque[surface].width)
          assert.equal(actual.height, opaque[surface].height)
          if (id === 'transparent') assert.ok(Math.abs(actual.alpha - (1 - level / 100)) < .01)
          else if (level === 0) assert.equal(actual.alpha, 0, surface + ' is fully clear at zero strength')
          else assert.ok(actual.alpha > 0 && actual.alpha < 1)
          if (id !== 'glass') assert.equal(actual.shadow, 'none')
        }
        for (const inner of await page.locator('[data-popup-inner]').all()) {
          const actual = await read(inner)
          assert.equal(actual.alpha, 0, 'inner scroll surface stays clear')
          assert.equal(actual.blur, 0, 'inner scroll surface does not double blur')
        }
        assert.ok((await page.locator('#popup-material-fixtures [class*=_material]').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).display))).every(display => display === 'none'))
      }
      await set(field, value)
      await page.locator('#popup-tooltip-anchor').hover()
      const tooltip = page.getByRole('tooltip', { name: 'Popup tooltip', exact: true })
      await tooltip.waitFor()
      assert.equal((await read(tooltip)).blur, id === 'transparent' ? 0 : value * .36)
      assert.equal((await read(tooltip)).color, (await read(page.locator('[data-popup-fixture=menu]'))).color)
      await page.locator('#popup-hover-anchor').hover()
      const hover = page.locator('[style*="--dsh-hover-preview-fade"]')
      await hover.waitFor()
      assert.equal((await read(hover)).blur, id === 'transparent' ? 0 : value * .36)
      await page.screenshot({ path: join(root, (dark ? 'dark-' : 'light-') + id + '-popups.png') })
      await page.mouse.move(0, 0)
    }
    await set('popupMaterial', 'opaque')
    for (const id of ids) assert.deepEqual(await read(page.locator('[data-popup-fixture=' + id + ']')), opaque[id], 'opaque restores ' + id)
  }
  await set('popupMaterial', 'glass')
  await page.evaluate(() => document.documentElement.setAttribute('data-dsh-ui', 'vanilla'))
  assert.equal((await read(page.locator('[data-popup-fixture=dock]'))).blur, 0, 'desktop effects withdraw in vanilla mode')
  await page.evaluate(() => { document.documentElement.setAttribute('data-dsh-ui', 'desktop'); window.__UNMOUNT_POPUP_FIXTURES__() })
  pass('both themes apply four popup materials to menus, completions, selects, dock/account panels, tooltips and hover cards without nested blur')

  await page.locator('.dshTb__item').filter({ hasText: /^更多$/ }).click()
  await liveMenu().waitFor()
  assert.equal((await read(liveMenu())).blur, 9)
  assert.equal(await liveMenu().evaluate(node => {
    const r = node.getBoundingClientRect()
    return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && node.contains(document.elementFromPoint(r.x + 12, r.y + 12))
  }), true, 'menu remains in the viewport and above the title bar')
  await page.screenshot({ path: join(root, 'popup-titlebar-menu.png') })
  await page.keyboard.press('Escape')
  await page.locator('.dshTb__item').filter({ hasText: /^会话$/ }).click()
  const submenuTrigger = liveMenu().getByRole('menuitem', { name: /^复制\.\.\./ })
  const parentBox = await submenuTrigger.boundingBox()
  await submenuTrigger.click()
  await page.waitForFunction(() => document.querySelectorAll('[role=menu]:not([data-dsh-ghost])').length >= 2)
  for (const menu of await page.locator('[role=menu]:visible:not([data-dsh-ghost])').all()) assert.equal((await read(menu)).blur, 9)
  const submenu = page.locator('[data-dsh-desktop=nested-menu]').last()
  const parentMenu = submenu.locator('xpath=ancestor::*[@role="menu"][1]')
  for (const dark of [false, true]) {
    await page.evaluate(dark => window.__SETTINGS_SMOKE__.configForms.get('ui-theme').set('preference', dark ? 'dark' : 'light'), dark)
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, dark)
    for (const [id, , , field, value] of controls) {
      await set('popupMaterial', id)
      for (const level of [0, 50, 100]) {
        await set(field, level)
        const parent = await read(parentMenu), child = await read(submenu)
        for (const key of ['alpha', 'color', 'blur', 'filter', 'background', 'shadow', 'opacity']) {
          assert.equal(child[key], parent[key], 'all menu levels share ' + key + ': ' + id + '/' + level)
        }
        for (const surface of [parent, child]) {
          assert.ok(Math.abs(surface.backdropWidth - surface.innerWidth) <= 1, 'backdrop covers the entire menu width: ' + JSON.stringify(surface))
          assert.ok(Math.abs(surface.backdropHeight - surface.innerHeight) <= 1, 'backdrop covers the entire menu height: ' + JSON.stringify(surface))
        }
      }
      await set(field, value)
    }
  }
  await set('popupMaterial', 'glass')
  const childBox = await submenu.boundingBox()
  assert.ok(Math.abs(childBox.x - (parentBox.x + parentBox.width)) <= 12, 'submenu stays adjacent to its trigger: ' + JSON.stringify({ parentBox, childBox }))
  assert.ok(Math.abs(childBox.y - parentBox.y) <= 12, 'submenu stays vertically aligned')
  await page.mouse.move(childBox.x + 16, childBox.y + 14)
  assert.equal(await submenu.isVisible(), true, 'pointer can reach the submenu')
  await page.screenshot({ path: join(root, 'popup-submenu.png') })
  pass('all menu levels share transparency and full backdrop coverage across both themes and every effect strength')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const editor = page.locator('[data-dsh-desktop=composer] [contenteditable=true]').first()
  await editor.fill('Popup context menu')
  await editor.click({ button: 'right' })
  const contextMenu = page.locator('.dshTextMenu:visible')
  await contextMenu.waitFor()
  assert.equal((await read(contextMenu)).blur, 9)
  await page.screenshot({ path: join(root, 'popup-context-menu.png') })
  await page.keyboard.press('Escape')
  await editor.fill('')
  await set('animation', initial.animation)
  assert.equal((await section()).composerMaterial, initial.composerMaterial)
  assert.equal((await section()).dialogMaterial, initial.dialogMaterial)
  await appearance()
  pass('live settings dropdown, title-bar menus, submenus and right-click menu retain placement and dismissal with popup effects')
}
