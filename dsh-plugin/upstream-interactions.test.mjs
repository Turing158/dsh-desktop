import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installUpstreamTerminalInteractions } from './sidebar-terminal/upstream-interactions.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  // Node's EventTarget needs the options object to remove a capture listener.
  class BrowserTarget extends EventTarget {
    removeEventListener(type, handler, capture = false) {
      super.removeEventListener(type, handler, { capture })
    }
  }
  const window = new BrowserTarget(), document = new BrowserTarget(), terminal = new EventTarget()
  const calls = [], pastes = [], errors = []
  let selection = null, clipboard = null
  window.Event = Event
  window.__TAURI__ = { core: { invoke: async (command, args) => {
    calls.push({ command, args })
    return command === 'clipboard_read_text' ? clipboard : undefined
  } } }
  document.defaultView = window
  terminal.ownerDocument = document
  terminal.isConnected = true
  terminal.getClientRects = () => terminal.isConnected ? [{}] : []
  terminal.closest = selector => selector === '[data-sidebar-terminal] .xterm' ? terminal : null
  const textarea = new EventTarget()
  textarea.closest = terminal.closest
  textarea.focus = () => {}
  terminal.querySelector = () => textarea
  terminal.addEventListener('copy', event => {
    if (selection !== null) event.clipboardData.setData('text/plain', selection)
  })
  textarea.addEventListener('paste', event => pastes.push(event.clipboardData.getData('text/plain')))
  const dispose = installUpstreamTerminalInteractions(document, error => errors.push(error))
  const emit = (type, fields = {}) => {
    const event = new Event(type, { cancelable: true })
    for (const [name, value] of Object.entries({ target: textarea, ...fields })) {
      Object.defineProperty(event, name, { value })
    }
    window.dispatchEvent(event)
    return event
  }
  emit('focusin')
  return { window, terminal, calls, pastes, errors, dispose, emit,
    select: value => { selection = value }, clipboard: value => { clipboard = value } }
}

test('upstream Ctrl+C copies the buffer selection and only interrupts when unselected', async () => {
  const f = fixture()
  try {
    f.select('  selected output   ')
    assert.equal(f.emit('keydown', { ctrlKey: true, code: 'KeyC' }).defaultPrevented, true)
    await tick()
    assert.deepEqual(f.calls, [{ command: 'clipboard_write_text', args: { text: '  selected output' } }])
    f.select(null)
    assert.equal(f.emit('keydown', { ctrlKey: true, code: 'KeyC' }).defaultPrevented, false)
    assert.equal(f.emit('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyC' }).defaultPrevented, true)
    await tick()
    assert.equal(f.calls.length, 1)
  } finally { f.dispose() }
})

test('upstream paste ignores null and empty clipboard values and emits text once', async () => {
  const f = fixture()
  try {
    for (const value of [null, '']) {
      f.clipboard(value)
      await f.window.__DSH_TERMINAL_EDIT__.paste()
    }
    assert.deepEqual(f.pastes, [])
    f.clipboard('line one\nline two')
    assert.equal(f.emit('keydown', { ctrlKey: true, code: 'KeyV' }).defaultPrevented, true)
    await tick()
    assert.deepEqual(f.pastes, ['line one\nline two'])
    assert.deepEqual(f.errors, [])
  } finally { f.dispose() }
})

test('upstream paste cannot write to a terminal closed while the clipboard is loading', async () => {
  const f = fixture()
  try {
    let resolveRead
    f.clipboard(new Promise(resolve => { resolveRead = resolve }))
    const pending = f.window.__DSH_TERMINAL_EDIT__.paste()
    f.terminal.isConnected = false
    resolveRead('stale input')
    await pending
    assert.deepEqual(f.pastes, [])
  } finally { f.dispose() }
})

test('upstream disposal removes clipboard shortcuts and the title bar edit target', async () => {
  const f = fixture()
  f.select('selected')
  f.dispose()
  assert.equal(f.window.__DSH_TERMINAL_EDIT__, undefined)
  assert.equal(f.emit('keydown', { ctrlKey: true, code: 'KeyC' }).defaultPrevented, false)
  await tick()
  assert.deepEqual(f.calls, [])
})

test('upstream right-click shares the text menu and copies the saved buffer selection', async () => {
  const f = fixture()
  let opened, dismissed = 0
  f.window.__DSH_TEXT_MENU__ = (point, entries, options) => {
    opened = { point, entries, options }
    return { menu: { contains: () => false }, dismiss: () => { dismissed++; options.onDismiss() } }
  }
  try {
    f.select('  output at right click   ')
    const event = f.emit('contextmenu', { clientX: 12, clientY: 34 })
    assert.equal(event.defaultPrevented, true)
    assert.deepEqual(opened.point, { clientX: 12, clientY: 34 })
    assert.equal(opened.options.keyboard, false)
    assert.equal(opened.options.scope, f.terminal)
    f.select('changed later')
    await opened.entries.find(entry => entry.key === 'C').run()
    assert.deepEqual(f.calls.at(-1), { command: 'clipboard_write_text', args: { text: '  output at right click' } })
    f.clipboard('paste through xterm')
    await opened.entries.find(entry => entry.key === 'V').run()
    assert.deepEqual(f.pastes, ['paste through xterm'])
  } finally { f.dispose() }
  assert.equal(dismissed, 1)
})
