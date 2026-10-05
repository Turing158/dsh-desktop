import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Exercise actual menu rows and host processes in the isolated desktop test. */
export async function checkTerminalTabMenus(c, until, root, pass) {
  const click = async expression => {
    const point = await c.evaluate(`(() => { const el=${expression}; if(!el)throw Error('Missing menu target'); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const context = async expression => {
    const point = await c.evaluate(`(() => { const el=${expression}; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...point })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...point })
    await until("Boolean(document.querySelector('[data-dsh-terminal-tab-menu]'))")
  }
  const row = label => `[...document.querySelectorAll('[data-dsh-terminal-tab-menu] button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)}))`
  const currentDock = `(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__;return d.registry.view(d.dock.getSnapshot().tabs[0]).model})()`
  await c.evaluate(`window.menuOldDock=${currentDock};window.menuDockKey=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs[0].contentId`)
  await context("document.querySelector('[data-dsh-terminal-dock] [role=tab]')")
  await click(row('重启'))
  await until(`${currentDock}.id!==menuOldDock.id && ${currentDock}.state.getSnapshot().writable`)
  assert.equal(await c.evaluate('menuOldDock.state.getSnapshot().phase'), 'closed')
  assert.equal(await c.evaluate('window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs[0].contentId'), await c.evaluate('menuDockKey'))
  assert.equal(await c.evaluate(`${currentDock}.state.getSnapshot().info.shell.path`), await c.evaluate('menuOldDock.state.getSnapshot().info.shell.path'))
  pass('bottom tab restart creates a new process with the same shell and tab identity')

  await c.evaluate(`window.menuOldDock=${currentDock};window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.add()`)
  await until('window.__DSH_UPSTREAM_DOCK_SMOKE__.registry.view(window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs[1]).model.state.getSnapshot().writable')
  await c.evaluate('window.menuUntouched=window.__DSH_UPSTREAM_DOCK_SMOKE__.registry.view(window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().tabs[1]).model')
  await context("document.querySelector('[data-dsh-terminal-dock] [role=tab]')")
  await click(row('切换...'))
  await until("Boolean(document.querySelector('.dshTerminalTabMenu__submenu button:not(:disabled)'))")
  await c.evaluate(`(async()=>{window.menuShells=await T.webTerminals.launchShells(T.sidebarRight.mounted.getSnapshot(),new AbortController().signal);window.menuChosen=menuShells.shells.find(s=>s.path!==menuOldDock.state.getSnapshot().info.shell.path)||menuShells.shells[0]})()`)
  const geometry = await c.evaluate(`(()=>{const m=document.querySelector('.dshTerminalTabMenu__submenu'),r=m.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`)
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry))
  await writeFile(join(root, 'terminal-dock-tab-menu.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await click("[...document.querySelectorAll('.dshTerminalTabMenu__submenu button')].find(b=>b.textContent.startsWith(menuChosen.name))")
  await until(`${currentDock}.id!==menuOldDock.id && ${currentDock}.state.getSnapshot().info?.state==='running'`)
  assert.equal(await c.evaluate(`${currentDock}.state.getSnapshot().info.shell.path`), await c.evaluate('menuChosen.path'))
  assert.equal(await c.evaluate('menuOldDock.state.getSnapshot().phase'), 'closed')
  assert.equal(await c.evaluate('menuUntouched.state.getSnapshot().writable'), true)
  assert.equal(await c.evaluate('window.__DSH_UPSTREAM_DOCK_SMOKE__.dock.getSnapshot().active===menuDockKey'), false)
  pass('bottom submenu switches an inactive tab immediately, stays within the window and preserves the active terminal')
  await c.evaluate(`(()=>{const d=window.__DSH_UPSTREAM_DOCK_SMOKE__.dock;d.close(d.getSnapshot().tabs[1].contentId);d.activate(menuDockKey);window.dockModel=${currentDock}})()`)
  await until('dockModel.state.getSnapshot().writable')
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock] .xterm-helper-textarea').focus()")
  await c.send('Input.insertText', { text: 'echo SWITCHED_DOCK_OK_582' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until("(document.querySelector('[data-dsh-terminal-dock] .xterm-rows')?.textContent||'').split('SWITCHED_DOCK_OK_582').length>=3")
  pass('switched bottom terminal accepts input and renders real command output')
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  await c.evaluate("document.querySelector('[data-dsh-terminal-dock] [role=tab]').focus()")
  await key('F10', 'F10', 121, 8)
  await until("Boolean(document.querySelector('[data-dsh-terminal-tab-menu]'))")
  await c.evaluate(`${row('切换...')}.focus()`)
  await key('ArrowRight', 'ArrowRight', 39)
  await until("Boolean(document.querySelector('.dshTerminalTabMenu__submenu button:not(:disabled)'))")
  await key('ArrowLeft', 'ArrowLeft', 37)
  await until("!document.querySelector('.dshTerminalTabMenu__submenu')")
  await key('Escape', 'Escape', 27)
  await until("!document.querySelector('[data-dsh-terminal-tab-menu]')")
  assert.equal(await c.evaluate('document.activeElement.getAttribute("role")'), 'tab')
  pass('bottom tab menu supports Shift+F10, submenu arrow navigation and Escape focus return')

  await c.evaluate(`window.menuRightTab=T.sidebarRight.active();window.menuRightOld=model`)
  await context("[...document.querySelectorAll('[data-dockkit-tab]')].at(-1)")
  await click(row('切换...'))
  await until("Boolean(document.querySelector('.dshTerminalTabMenu__submenu button:not(:disabled)'))")
  await writeFile(join(root, 'terminal-right-tab-menu.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await click("[...document.querySelectorAll('.dshTerminalTabMenu__submenu button')].find(b=>b.textContent.startsWith(menuChosen.name))")
  const rightReady = `(()=>{const tab=T.sidebarRight.active();if(tab.id===menuRightTab.id)return false;const nav=T.sidebarRight.tabDomain.occurrence(T.sidebarRight.mounted.getSnapshot(),tab).navigation.getSnapshot();window.model=T.webTerminals.view(T.sidebarRight.mounted.getSnapshot(),tab.id,tab.contentId,nav.params?.terminalId,nav.params?.shellPath);return model.state.getSnapshot().writable})()`
  await until(rightReady)
  assert.equal(await c.evaluate('model.state.getSnapshot().info.shell.path'), await c.evaluate('menuChosen.path'))
  assert.equal(await c.evaluate('menuRightOld.state.getSnapshot().phase'), 'closed')
  pass('right tab menu switches the DSH terminal to the selected shell and closes the previous process')
  await c.evaluate('window.menuRightTab=T.sidebarRight.active();window.menuRightOld=model')
  await context("[...document.querySelectorAll('[data-dockkit-tab]')].at(-1)")
  await click(row('重启'))
  await until(rightReady)
  assert.equal(await c.evaluate('model.state.getSnapshot().info.shell.path'), await c.evaluate('menuChosen.path'))
  assert.equal(await c.evaluate('menuRightOld.state.getSnapshot().phase'), 'closed')
  pass('right tab restart retains the selected shell')
  return c.evaluate('dockModel.id')
}
