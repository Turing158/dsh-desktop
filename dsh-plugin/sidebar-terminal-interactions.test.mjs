/**
 * Drives the terminal view's input surface for real: the copy/paste chords and
 * the right-click menu.
 *
 * ## Why this file exists
 *
 * Both behaviours are DECISIONS about a single event, made inside `createView`'s
 * custom key handler and `contextmenu` listener, and neither is visible in the
 * rendered tree that `sidebar-terminal-render.test.mjs` walks:
 *
 *   1. **Ctrl+C is two keys with one code.** With a selection it must Copy — and
 *      it must not ALSO reach the shell as ^C, or copying a command cancels it.
 *      With nothing selected the plain chord keeps its interrupt meaning. The
 *      contract is exactly `attachCustomKeyEventHandler`'s return value plus
 *      which bridge calls fired, so that is what is asserted.
 *   2. **The right-click menu is DOM the app's React never renders.** Its items'
 *      enabled states, the dismissals (outside pointerdown, Escape) and the
 *      fact that paste re-arms the input grant before writing are all runtime
 *      behaviour of the same view object.
 *
 * ## How
 *
 * `runtime.mjs` is bundled once with esbuild — the shipped code, not a copy —
 * with `@xterm/xterm` aliased to a stub that RECORDS: data handlers, key
 * handlers, selections, pastes and focus calls, so a test can play the shell's
 * side. The DOM is a minimal element stub with listener maps; the Tauri bridge
 * is a recording `invoke`. `createRegistry` runs for real, so every assertion
 * below goes through `registry.view(...)`'s actual `createView`.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PREFIX = 'dsh-resource://desktop-terminal/'
const tick = () => new Promise(resolve => setImmediate(resolve))

let createRegistry

/**
 * An xterm that keeps what the view hands it, so a test can act as the shell:
 * the recorded `dataHandlers` are what xterm would call with ^C and other
 * input, `selection` stands for a user drag, and `pasted` receives
 * `term.paste`. Instances register themselves for retrieval per view.
 */
const XTERM_STUB = `
export class Terminal {
  constructor() {
    globalThis.__xtermInstances.push(this)
    this.dataHandlers = []
    this.keyHandlers = []
    this.pasted = []
    this.focused = 0
    this.disposed = false
    this.selection = ''
    this._options = {}
  }
  loadAddon() {}
  onData(handler) { this.dataHandlers.push(handler) }
  attachCustomKeyEventHandler(handler) { this.keyHandlers.push(handler) }
  open() {}
  reset() { this.selection = '' }
  dispose() { this.disposed = true }
  clear() {}
  write(_data, done) { if (typeof done === 'function') done() }
  resize() {}
  paste(value) { this.pasted.push(value); for (const handler of this.dataHandlers) handler(value) }
  focus() { this.focused++ }
  getSelection() { return this.selection }
  hasSelection() { return Boolean(this.selection) }
  selectAll() { this.selectedAll = true }
  get options() { return this._options ?? {} }
  set options(value) { this._options = value }
  get cols() { return 80 }
  get rows() { return 24 }
}
`

const FIT_STUB = `
export class FitAddon {
  proposeDimensions() { return { cols: 80, rows: 24 } }
}
`

/** A DOM reduced to what `createView` touches: listeners, children, geometry. */
function createDocument() {
  class Element {
    constructor(tag) {
      this.tagName = tag
      this.className = ''
      this.textContent = ''
      this.children = []
      this.parent = null
      this.style = {}
      this.listeners = {}
      this.disabled = false
    }
    setAttribute(name, value) { this.attributes ??= {}; this.attributes[name] = value }
    getAttribute(name) { return this.attributes?.[name] ?? null }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
      this.parent = null
    }
    contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) }
    removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(fn => fn !== handler) }
    dispatch(type, event) { for (const handler of [...(this.listeners[type] || [])]) handler(event) }
    getBoundingClientRect() { return { width: 120, height: 64, left: 0, top: 0 } }
    get isConnected() { return false }
    closest() { return null }
  }
  const document = new Element('#document')
  document.createElement = tag => new Element(tag)
  const captures = []
  document.addEventListener = (type, handler) => captures.push({ type, handler })
  document.removeEventListener = (type, handler) => { const at = captures.findIndex(l => l.type === type && l.handler === handler); if (at >= 0) captures.splice(at, 1) }
  document.dispatchCapture = (type, event) => { for (const { type: at, handler } of [...captures]) if (at === type) handler(event) }
  document.documentElement = new Element('html')
  document.body = new Element('body')
  return document
}

let scratch

before(async () => {
  const { build } = await import('esbuild')
  scratch = await mkdtemp(join(tmpdir(), 'dsh-terminal-interactions-'))
  const xterm = join(scratch, 'xterm.mjs')
  const fit = join(scratch, 'fit.mjs')
  await writeFile(xterm, XTERM_STUB)
  await writeFile(fit, FIT_STUB)
  const out = join(scratch, 'runtime.mjs')
  await build({
    absWorkingDir: here,
    entryPoints: [join(here, 'sidebar-terminal', 'runtime.mjs')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    alias: { '@xterm/xterm': xterm, '@xterm/addon-fit': fit },
  })
  ;({ createRegistry } = await import(pathToFileURL(out).href))
})

test.after?.(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/**
 * A registry over the real `createView`, with the bridge and DOM in place.
 *
 * `connect: true` walks the whole open path (profiles → open → attach) and then
 * fires the surface's pointerdown, so `terminal_control` lands and the view
 * holds an input grant — the state a user's first click produces.
 */
async function harness(t, { connect = false } = {}) {
  const document = createDocument()
  globalThis.document = document
  globalThis.window = globalThis
  globalThis.innerWidth = 1280
  globalThis.innerHeight = 800
  globalThis.addEventListener = () => {}
  globalThis.removeEventListener = () => {}
  globalThis.requestAnimationFrame = handler => { handler(); return 0 }
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }
  globalThis.MutationObserver ??= class { observe() {} disconnect() {} }
  globalThis.crypto ??= { randomUUID: () => 'it-' + Math.random().toString(16).slice(2) }
  const calls = []
  const info = { resourceKey: PREFIX + 'it', terminalId: 't1', runId: 1, state: 'running', profileId: 'pwsh', cwd: 'C:\\a' }
  globalThis.__DSH_TERMINAL_IDENTITY__ = {}
  globalThis.__xtermInstances = []
  globalThis.__TAURI__ = {
    core: {
      invoke: async (name, args) => {
        calls.push([name, args])
        if (name === 'terminal_list') return []
        if (name === 'terminal_profiles') return [{ profileId: 'pwsh', name: 'PowerShell' }]
        if (name === 'terminal_open') return info
        if (name === 'terminal_attach') return 'a1'
        if (name === 'terminal_control') return 1
        if (name === 'clipboard_read_text') return 'from-clipboard'
        return {}
      },
      Channel: class {},
    },
  }
  const tabs = { [PREFIX + 'it']: { contentId: PREFIX + 'it' } }
  const store = { getSnapshot: () => ({ bySession: { s: { layout: { tabs } } } }), subscribe: () => () => {} }
  const ctx = {
    slots: { entriesOfSlot: () => [{ store: { create() { throw Error('must resolve the live store') } } }], resolveStore: () => store },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: ['s'], current: 's' }), subscribe: () => () => {} }, scope: () => ({}) },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [{ path: 'C:\\a', sessionIds: ['s'] }] }) } },
  }
  const registry = createRegistry(ctx, null)
  t.after(() => { registry.dispose(); delete globalThis.document; delete globalThis.window })
  const view = registry.view({ signal: {}, contentId: PREFIX + 'it' })
  const term = globalThis.__xtermInstances.at(-1)
  if (connect) {
    await view.connect()
    view.element.dispatch('pointerdown', {})
    await tick(); await tick()
  }
  const press = over => term.keyHandlers[0]({ type: 'keydown', key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: false, altKey: false, isComposing: false, preventDefault() { this.defaulted = true }, ...over })
  const openMenu = () => view.element.dispatch('contextmenu', { clientX: 40, clientY: 40, preventDefault() {}, stopPropagation() {} })
  const menu = () => view.element.children.find(child => child.className === 'dshTerminal__context')
  const item = label => menu()?.children.find(child => child.textContent === label)
  const writes = () => calls.filter(([name]) => name === 'terminal_write')
  return { view, term, calls, press, openMenu, menu, item, writes, document }
}

test('Ctrl+C with a selection copies through the bridge and never reaches the shell', async t => {
  const { term, press, calls } = await harness(t)
  term.selection = 'echo hello'
  const handled = press()
  assert.equal(handled, false, 'the chord must be swallowed, not routed to the shell as ^C')
  assert.equal(calls.filter(([name]) => name === 'terminal_write').length, 0)
  await tick()
  const copy = calls.find(([name]) => name === 'clipboard_write_text')
  assert.deepEqual(copy?.[1], { text: 'echo hello' })
})

test('Ctrl+C without a selection keeps its interrupt meaning', async t => {
  const { press, calls } = await harness(t)
  assert.equal(press(), true, 'xterm must receive the key so ^C reaches the shell')
  await tick()
  assert.equal(calls.filter(([name]) => name === 'clipboard_write_text').length, 0)
})

test('shared text menu keeps native terminal control, snapshots copy and selects the buffer', async t => {
  const { view, term, calls, openMenu, writes } = await harness(t, { connect: true })
  let opened, dismissed = 0
  globalThis.__DSH_TEXT_MENU__ = (point, entries, options) => {
    opened = { entries, options }
    return { menu: {}, dismiss: () => { dismissed++; options.onDismiss() } }
  }
  t.after(() => { delete globalThis.__DSH_TEXT_MENU__ })
  term.selection = 'saved selection   '
  openMenu()
  assert.equal(opened.options.parent, view.element, 'menu focus must remain inside the control owner')
  term.selection = 'later selection'
  await opened.entries.find(entry => entry.key === 'C').run()
  assert.deepEqual(calls.find(([name]) => name === 'clipboard_write_text')?.[1], { text: 'saved selection' })
  await opened.entries.find(entry => entry.key === 'V').run()
  await tick()
  assert.equal(writes().at(-1)?.[1].data, 'from-clipboard')
  opened.entries.find(entry => entry.key === 'A').run()
  assert.equal(term.selectedAll, true)
  view.unmount()
  assert.equal(dismissed, 1)
})

test('Ctrl+C survives an input grant end to end: selection copies, none interrupts', async t => {
  const { term, press, calls, writes } = await harness(t, { connect: true })
  assert.equal(writes().length, 0, 'the connected surface starts quiet')
  term.selection = 'npm run build'
  assert.equal(press(), false)
  await tick()
  assert.equal(writes().length, 0, 'a copied chord must not cancel the selected command')
  assert.ok(calls.some(([name, args]) => name === 'clipboard_write_text' && args.text === 'npm run build'))
  term.selection = ''
  assert.equal(press(), true)
  for (const handler of term.dataHandlers) handler('^C')
  await tick()
  assert.deepEqual(writes().at(-1)?.[1].data, '^C')
})

test('Ctrl+Shift+C with nothing selected is swallowed, not sent and not copied', async t => {
  const { press, calls } = await harness(t)
  assert.equal(press({ shiftKey: true }), false)
  await tick()
  assert.equal(calls.filter(([name]) => name === 'clipboard_write_text').length, 0)
})

test('composition and non-C chords pass through untouched', async t => {
  const { press } = await harness(t)
  assert.equal(press({ isComposing: true }), true)
  assert.equal(press({ code: 'KeyD' }), true)
  assert.equal(press({ altKey: true, ctrlKey: true }), true, 'AltGr+C types a letter on some layouts')
})

test('Ctrl+V pastes through the clipboard bridge', async t => {
  const { term, press, calls } = await harness(t)
  assert.equal(press({ code: 'KeyV', key: 'v' }), false)
  await tick()
  assert.ok(calls.some(([name]) => name === 'clipboard_read_text'))
  assert.deepEqual(term.pasted, ['from-clipboard'])
})

test('right-click opens the menu with each item gated on its own precondition', async t => {
  const { term, openMenu, menu, item } = await harness(t)
  openMenu()
  const opened = menu()
  assert.ok(opened, 'the menu is a child of the screen element')
  assert.equal(opened.children.length, 2)
  assert.equal(item('复制').disabled, true, 'nothing is selected yet')
  assert.equal(item('粘贴').disabled, true, 'the surface was never connected')
  term.selection = 'abc'
  openMenu()
  assert.equal(item('复制').disabled, false)
  assert.equal(item('粘贴').disabled, true)
})

test('the menu copies the selection and closes, leaving the selection alive', async t => {
  const { term, calls, openMenu, item, menu } = await harness(t)
  term.selection = 'git status'
  openMenu()
  item('复制').dispatch('click', {})
  await tick()
  assert.ok(calls.some(([name, args]) => name === 'clipboard_write_text' && args.text === 'git status'))
  assert.ok(!menu(), 'an acted menu closes')
  assert.equal(term.hasSelection(), true, 'copying never clears the selection')
})

test('menu paste re-arms the input grant and writes the clipboard through the shell', async t => {
  const { openMenu, item, writes } = await harness(t, { connect: true })
  openMenu()
  assert.equal(item('粘贴').disabled, false, 'the connected surface is running')
  item('粘贴').dispatch('click', {})
  await tick(); await tick(); await tick()
  assert.deepEqual(writes().at(-1)?.[1].data, 'from-clipboard')
})

test('a pointerdown outside the surface dismisses the menu', async t => {
  const { view, openMenu, menu, document } = await harness(t)
  openMenu()
  assert.ok(menu())
  document.dispatchCapture('pointerdown', { target: { parent: null } })
  assert.ok(!menu())
  assert.equal(view.element.children.length, 0)
})

test('Escape dismisses the menu and hands focus back to the terminal', async t => {
  const { term, openMenu, menu, document } = await harness(t)
  openMenu()
  document.dispatchCapture('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.ok(!menu())
  assert.ok(term.focused > 0)
})

test('a second right-click moves the menu instead of stacking a second one', async t => {
  const { openMenu, menu, view } = await harness(t)
  openMenu()
  openMenu()
  assert.equal(view.element.children.filter(child => child.className === 'dshTerminal__context').length, 1)
})
