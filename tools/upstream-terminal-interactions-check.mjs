import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Use real mouse/key events against the upstream xterm in each desktop seat. */
export async function checkTerminalInteractions(c, until, root, pass, { seat, selector, model, marker }) {
  const menu = '[data-dsh-upstream-terminal-menu]'
  const key = async (key, code, virtual, modifiers = 0, text) => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, modifiers, ...(text ? { text } : {}) })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers })
  }
  const click = async (point, button = 'left', count = 1) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: count, ...point })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: count, ...point })
  }
  await c.evaluate(`(() => {
    window.interactionTerminal = document.querySelector(${JSON.stringify(selector)});
    window.interactionModel = ${model};
    window.interactionWrites = [];
    window.interactionWrite = interactionModel.write;
    interactionModel.write = function (text) { interactionWrites.push(text); return interactionWrite.call(this, text) };
  })()`)
  // Restore clipboard text without including its contents in test output.
  // The native reader returns null for an empty/non-text clipboard.
  await c.evaluate("(async()=>{window.interactionClipboard=(await window.__TAURI__.core.invoke('clipboard_read_text')) ?? ''})()")
  try {
    const point = await c.evaluate(`(() => {
      const row = [...interactionTerminal.querySelectorAll('.xterm-rows > div')].find(row => row.textContent.trim() === ${JSON.stringify(marker)});
      if (!row) throw Error('Missing terminal output marker');
      const span = [...row.querySelectorAll('span')].find(span => span.textContent.includes(${JSON.stringify(marker)}));
      const r = (span || row).getBoundingClientRect(); return {x:r.left+16,y:r.top+r.height/2};
    })()`)
    // Start away from the terminal: the first physical right-click must work.
    await c.evaluate("document.querySelector('[data-dsh-terminal-dock-toggle]')?.focus()")
    await click(point, 'right')
    await until(`Boolean(document.querySelector('${menu}'))`)
    assert.equal(await c.evaluate("document.querySelectorAll('.dshTextMenu').length"), 0)
    assert.deepEqual(await c.evaluate(`Array.from(document.querySelectorAll('${menu} button'), b=>b.textContent)`), ['复制', '粘贴'])
    await writeFile(join(root, `${seat}-terminal-context.png`), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await key('Escape', 'Escape', 27)
    assert.equal(await c.evaluate(`Boolean(document.querySelector('${menu}'))`), false)
    pass(`${seat}: first right-click opens only the terminal copy/paste menu`)

    // xterm selection is deliberately made by mouse, not by touching its refs.
    await click(point, 'left', 2)
    await c.evaluate('interactionWrites.length=0')
    await key('c', 'KeyC', 67, 2, '\x03')
    await until(`window.__TAURI__.core.invoke('clipboard_read_text').then(text=>text===${JSON.stringify(marker)})`)
    assert.deepEqual(await c.evaluate('interactionWrites'), [], 'copy must not reach the shell')
    await key('C', 'KeyC', 67, 10)
    assert.deepEqual(await c.evaluate('interactionWrites'), [])
    pass(`${seat}: Ctrl+C and Ctrl+Shift+C copy the real selection without interrupting`)

    await click(point, 'right')
    await until(`Boolean(document.querySelector('${menu} button:not(:disabled)'))`)
    await c.evaluate("window.__TAURI__.core.invoke('clipboard_write_text',{text:'before-menu-copy'})")
    const copyPoint = await c.evaluate(`(()=>{const r=document.querySelector('${menu} button').getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2}})()`)
    await click(copyPoint)
    await until(`window.__TAURI__.core.invoke('clipboard_read_text').then(text=>text===${JSON.stringify(marker)})`)
    assert.deepEqual(await c.evaluate('interactionWrites'), [])
    pass(`${seat}: context-menu copy preserves the selected terminal text`)

    await click(point) // A plain left-click clears xterm's selection.
    await c.evaluate('interactionWrites.length=0')
    await key('c', 'KeyC', 67, 2, '\x03')
    await until("interactionWrites.includes('\u0003')")
    await c.evaluate('interactionWrites.length=0')
    await key('C', 'KeyC', 67, 10)
    assert.deepEqual(await c.evaluate('interactionWrites'), [], 'empty shifted copy must not interrupt')
    pass(`${seat}: Ctrl+C with no selection retains interrupt behavior`)

    await c.evaluate("window.__TAURI__.core.invoke('clipboard_write_text',{text:'DSH_PASTE_592'})")
    await click(point, 'right')
    const pastePoint = await c.evaluate(`(()=>{const r=document.querySelectorAll('${menu} button')[1].getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2}})()`)
    await click(pastePoint)
    await until("interactionWrites.some(text=>text.includes('DSH_PASTE_592'))")
    assert.equal(await c.evaluate("interactionWrites.filter(text=>text.includes('DSH_PASTE_592')).length"), 1)
    await key('c', 'KeyC', 67, 2, '\x03')
    await c.evaluate('interactionWrites.length=0')
    await key('v', 'KeyV', 86, 2)
    await until("interactionWrites.some(text=>text.includes('DSH_PASTE_592'))")
    assert.equal(await c.evaluate("interactionWrites.filter(text=>text.includes('DSH_PASTE_592')).length"), 1)
    await key('c', 'KeyC', 67, 2, '\x03')
    pass(`${seat}: menu paste and Ctrl+V each enter text exactly once`)

    await c.evaluate("window.__TAURI__.core.invoke('clipboard_write_text',{text:''})")
    await c.evaluate('interactionWrites.length=0')
    await key('v', 'KeyV', 86, 2)
    await c.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert.deepEqual(await c.evaluate('interactionWrites'), [])
    pass(`${seat}: a clipboard without text does not send terminal input`)

    await key('F10', 'F10', 121, 8)
    await until(`document.activeElement?.closest('${menu}')!==null`)
    await key('Escape', 'Escape', 27)
    assert.equal(await c.evaluate("document.activeElement===interactionTerminal.querySelector('.xterm-helper-textarea')"), true)
    pass(`${seat}: keyboard menu opens and Escape restores terminal focus`)
  } finally {
    await c.evaluate("(async()=>{interactionModel.write=interactionWrite;await window.__TAURI__.core.invoke('clipboard_write_text',{text:interactionClipboard});delete window.interactionClipboard})()")
  }
}
