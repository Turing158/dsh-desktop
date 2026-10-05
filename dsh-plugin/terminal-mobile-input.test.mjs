import test from 'node:test'
import assert from 'node:assert/strict'
import { installMobileTerminalInput } from './sidebar-terminal/mobile-input.mjs'

function fixture(t, { browser = true } = {}) {
  const document = new EventTarget(), forwarded = [], lookups = [], writes = []
  document.documentElement = { hasAttribute: () => browser }
  const attrs = new Map()
  const element = {
    value: '', hidden: false, terminal: true,
    matches: () => element.terminal,
    closest: selector => selector === '[hidden]' ? (element.hidden ? {} : null) : {},
    setAttribute: (key, value) => attrs.set(key, value),
  }
  const model = { writable: true, state: { getSnapshot: () => ({ writable: model.writable }) }, write: text => writes.push(text) }
  const navigation = { address: 'terminal://one', params: { terminalId: 'terminal-one', shellPath: '/bin/sh' } }
  const target = { sessionId: 'session-one', tabId: 'tab-one', occurrence: { navigation: { getSnapshot: () => navigation } } }
  const ctx = {
    sidebarRight: { commandTarget: () => target },
    webTerminals: { view: (...args) => { lookups.push(args); return model } },
  }
  const stop = installMobileTerminalInput(ctx, document)
  t.after(stop)
  const types = ['focusin', 'blur', 'keydown', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'paste']
  for (const type of types) document.addEventListener(type, event => forwarded.push(event.type))
  function send(type, properties = {}) {
    const event = new Event(type, { cancelable: properties.cancelable ?? true })
    Object.defineProperty(event, 'target', { value: element })
    for (const [key, value] of Object.entries(properties)) {
      if (key !== 'cancelable') Object.defineProperty(event, key, { value })
    }
    document.dispatchEvent(event)
    return event
  }
  // Model the browser: a canceled beforeinput produces neither a DOM edit nor
  // an input event. Noncancelable edits fall back to input after the DOM edit.
  function edit(text, cancelable = true) {
    const event = send('beforeinput', { inputType: 'insertText', data: text, cancelable })
    if (!event.defaultPrevented) {
      element.value += text
      send('input', { inputType: 'insertText', data: text, cancelable: false })
    }
  }
  return { document, element, attrs, model, target, navigation, lookups, writes, forwarded, send, edit, stop }
}

test('mobile text edits reach the live terminal once, with zero or IME key codes', t => {
  const f = fixture(t)
  for (const text of ['1', ' ', '/', '；', '中文', '🙂']) {
    f.send('keydown', { key: 'Unidentified', keyCode: 229 })
    f.send('keypress', { key: [...text].length === 1 ? text : 'Unidentified', keyCode: 0 })
    f.edit(text)
  }
  assert.equal(f.writes.join(''), '1 /；中文🙂')
  assert.deepEqual(f.forwarded, [])
  assert.equal(f.element.value, '')
  assert.equal(f.attrs.get('autocapitalize'), 'off')
  assert.equal(f.attrs.get('inputmode'), 'text')
})

test('noncancelable edits, dictation and input-only events preserve Unicode', t => {
  const f = fixture(t)
  f.edit('12', false)
  f.send('beforeinput', { inputType: 'insertReplacementText', data: ' 语音🙂' })
  f.element.value = '；'
  f.send('input', { inputType: 'insertText', data: null, cancelable: false })
  assert.deepEqual(f.writes, ['12', ' 语音🙂', '；'])
  assert.deepEqual(f.forwarded, ['beforeinput'])
})

test('soft and physical editing keys send terminal control sequences once', t => {
  const f = fixture(t)
  for (const key of ['Enter', 'Backspace', 'Delete']) {
    assert.equal(f.send('keydown', { key }).defaultPrevented, true)
    f.send('keypress', { key })
  }
  for (const inputType of ['insertLineBreak', 'deleteContentBackward', 'deleteContentForward']) {
    f.send('beforeinput', { inputType })
  }
  assert.equal(f.writes.join(''), '\r\x7f\x1b[3~\r\x7f\x1b[3~')
  assert.deepEqual(f.forwarded, [])
  for (const properties of [{ key: 'c', ctrlKey: true }, { key: 'ArrowUp' }, { key: 'Tab' }, { key: 'v', metaKey: true }]) {
    assert.equal(f.send('keydown', properties).defaultPrevented, false)
  }
  f.send('paste')
  assert.deepEqual(f.forwarded, ['keydown', 'keydown', 'keydown', 'keydown', 'paste'])
})

test('IME confirmation belongs to xterm; plain input resumes after composition', async t => {
  const f = fixture(t)
  for (const order of ['input-first', 'end-first']) {
    f.send('compositionstart')
    f.send('keydown', { key: 'Enter', isComposing: true })
    f.send('input', { inputType: 'insertCompositionText', data: 'zhong', isComposing: true })
    const commit = () => f.send('input', { inputType: 'insertText', data: '中' })
    if (order === 'input-first') commit()
    f.send('compositionend')
    if (order === 'end-first') commit()
    assert.deepEqual(f.writes, [])
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.deepEqual(f.forwarded, ['compositionstart', 'compositionend', 'compositionstart', 'compositionend'])
  f.edit('1')
  assert.deepEqual(f.writes, ['1'])
})

test('input resolves the current session and tab, respects writability and ignores hidden content', t => {
  const f = fixture(t)
  f.edit('a')
  f.target.sessionId = 'session-two'
  f.target.tabId = 'tab-two'
  f.navigation.address = 'terminal://two'
  f.navigation.params = { terminalId: 'terminal-two', shellPath: 'cmd.exe' }
  f.edit('b')
  assert.deepEqual(f.lookups.at(-1), ['session-two', 'tab-two', 'terminal://two', 'terminal-two', 'cmd.exe'])
  f.model.writable = false
  f.edit('blocked')
  assert.deepEqual(f.writes, ['a', 'b'])
  assert.deepEqual(f.forwarded, [], 'read-only edits cannot fall through to xterm')
  const lookups = f.lookups.length
  f.element.hidden = true
  f.send('keydown', { key: 'Enter' })
  f.element.hidden = false
  f.element.terminal = false
  f.send('keydown', { key: 'Enter' })
  assert.equal(f.lookups.length, lookups)
  assert.deepEqual(f.forwarded, ['keydown', 'keydown'])
})

test('desktop pages and disposed listeners leave native keyboard handling intact', t => {
  const desktop = fixture(t, { browser: false })
  desktop.send('keydown', { key: 'Enter' })
  assert.deepEqual(desktop.lookups, [])
  assert.deepEqual(desktop.forwarded, ['keydown'])
  const f = fixture(t)
  f.send('compositionstart')
  f.send('compositionend')
  f.stop()
  f.send('keydown', { key: 'Enter' })
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.forwarded, ['compositionstart', 'compositionend', 'keydown'])
})
