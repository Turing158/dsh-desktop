/**
 * The boot page's own contract, asserted without a window.
 *
 * The mark and its CSS animation are present in the shipped markup. The script
 * replaces only the status and controls whether that animation is active. Two
 * failures are covered because both were seen on a real window and both read
 * as "the app is hung":
 *
 *  1. **No phase is ever painted.** While the IPC origin guard was refusing
 *     every boot-page command, the old page kept a static waiting line forever.
 *     The loading state now needs to exist even before JavaScript runs.
 *  2. **A refusal is silent.** `showFailure` ignores `stale-origin` on purpose
 *     (the real interface replaces the document moments later), so a refusal
 *     must not paint an error card - and must not be the reason the page looks
 *     dead either.
 *
 * The page is driven through a stub DOM and a stub Tauri bridge rather than a
 * browser: the file is deliberately dependency-free, which is what makes that
 * faithful.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '../src-tauri/ui/main.js'), 'utf8')
const MARKUP = readFileSync(join(here, '../src-tauri/ui/index.html'), 'utf8')

/** The initial status `index.html` ships before any script runs. */
const WAITING = '正在检查运行环境…'

/** An element stub with just enough surface for the page's `h()` helper. */
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = {}
    this.className = ''
    this.scrollTop = 0
    this.scrollHeight = 0
    this._text = ''
  }
  set textContent(value) {
    this.children = []
    this._text = String(value)
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('')
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value)
  }
  addEventListener() {}
  append(...nodes) {
    for (const node of nodes.flat()) {
      this.children.push(typeof node === 'string' ? new Text(node) : node)
    }
  }
  replaceChildren(...nodes) {
    this.children = []
    this._text = ''
    this.append(...nodes)
  }
  /** Every element in the subtree, this one included. */
  walk(found = []) {
    found.push(this)
    for (const child of this.children) if (child instanceof Node) child.walk(found)
    return found
  }
}

class Text {
  constructor(value) {
    this._text = String(value)
  }
  get textContent() {
    return this._text
  }
}

/**
 * Run the page against a stub bridge.
 *
 * @param {{invoke: Function}} bridge - `invoke` answers (or refuses) `probe_state`.
 * @returns the body element the page rendered into, and its event handlers.
 */
function loadPage(bridge) {
  const body = new Node('section')
  const app = new Node('main')
  app.setAttribute('data-state', 'loading')
  app.append(body)
  const document = {
    getElementById: (id) => ({ body, app })[id] ?? null,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => new Text(text),
    addEventListener: () => {},
  }
  const handlers = {}
  const window = {
    __TAURI__: {
      core: { invoke: bridge.invoke },
      event: {
        listen: async (event, handler) => {
          handlers[event] = handler
          return () => {}
        },
      },
    },
  }
  const context = { window, document, console, setTimeout, Error, String, Object, Promise }
  context.globalThis = context
  vm.runInNewContext(SOURCE, context, { filename: 'main.js' })
  return { body, app, handlers }
}

/** What a viewer of the window would see. */
function painted(body, app) {
  const nodes = body.walk()
  return {
    text: body.textContent.replace(/\s+/g, ' ').trim(),
    state: app.attributes['data-state'],
    headings: nodes.filter((node) => node.tagName === 'H2').map((node) => node.textContent),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const answer = (phase) => async () => ({ phase, install_command: 'npm i -g @deepseek-ai/dsh' })

test('the shipped markup includes the loading visual before JavaScript runs', () => {
  assert.ok(MARKUP.includes(WAITING), 'index.html must ship the waiting line')
  assert.ok(MARKUP.includes('data-state="loading"'), 'the page starts in the loading state')
  assert.ok(MARKUP.includes('class="boot-orbit"'), 'the loading visual cannot depend on IPC')
  assert.ok(MARKUP.includes('class="boot-mark"'), 'the brand mark is available on first paint')
})

test('the waiting state shows a spinner before the first probe answers', () => {
  const { body, app } = loadPage({ invoke: () => new Promise(() => {}) })
  const seen = painted(body, app)
  assert.equal(seen.text, WAITING)
  assert.equal(seen.state, 'loading', 'the loading visual stays active while the probe is outstanding')
})

test('each phase replaces the waiting line with its own message', async () => {
  const cases = [
    ['probing', { kind: 'probing' }, '正在检查运行环境…', 'loading'],
    ['installing', { kind: 'installing', version: '0.4.2' }, '正在安装 dsh 0.4.2', 'installing'],
    ['starting', { kind: 'starting', version: '0.4.2' }, '正在启动工作空间…', 'loading'],
    ['running', { kind: 'running', version: '0.4.2' }, '界面已就绪，正在载入…', 'ready'],
  ]
  for (const [label, phase, expected, state] of cases) {
    const { body, app } = loadPage({ invoke: answer(phase) })
    await settle()
    const seen = painted(body, app)
    assert.ok(
      seen.text.includes(expected),
      `${label} must render ${JSON.stringify(expected)}, got ${JSON.stringify(seen.text)}`,
    )
    assert.equal(seen.state, state)
  }
})

test('a phase with no version is still a sentence', async () => {
  const { body, app } = loadPage({ invoke: answer({ kind: 'starting' }) })
  await settle()
  assert.equal(painted(body, app).text, '正在启动工作空间…')
})

test('a stale-origin refusal stays quiet and keeps the page alive', async () => {
  // The refusal is expected on the edge of the navigation to the DSH server, so
  // no card may be painted - but the spinner has to remain, or the window would
  // sit on markup nothing will ever replace.
  const { body, app, handlers } = loadPage({
    invoke: async () => {
      throw new Error('stale-origin')
    },
  })
  await settle()
  const seen = painted(body, app)
  assert.deepEqual(seen.headings, [], 'a stale-origin refusal must not paint an error card')
  assert.equal(seen.text, WAITING, 'the waiting line stays up')
  assert.equal(seen.state, 'loading', 'and it stays animated')
  assert.equal(
    typeof handlers['status-changed'],
    'function',
    'the page must keep listening for the events that carry the next phase',
  )
})

test('a real failure is reported instead of swallowed', async () => {
  const { body, app } = loadPage({
    invoke: async () => {
      throw new Error('后台状态不可用')
    },
  })
  await settle()
  const seen = painted(body, app)
  assert.deepEqual(seen.headings, ['出错了'])
  assert.ok(seen.text.includes('后台状态不可用'))
  assert.equal(seen.state, 'failed', 'a real failure must stop the loading animation')
})
