/**
 * Render the shipped appearance component and stylesheet in isolated headless Edge.
 * Checks selector layout and actual hover styles in both palettes, with motion
 * enabled/disabled and the native-select fallback. Menu interactions and font-size
 * persistence are covered by vanilla-client.test.mjs; this probe stubs only the
 * Menu anchor and React renderer, never the control markup or its styles.
 * Run: node tools/_fontselectprobe.mjs [optional-screenshot.png]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const edgePath = process.env.EDGE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
assert.ok(edgePath, 'Edge is required; set EDGE_PATH for a custom installation')
const dir = mkdtempSync(join(tmpdir(), 'dsh-appearance-probe-'))
const css = readFileSync(new URL('../dsh-plugin/ui-overlay/theme.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../dsh-plugin/ui-client/client.js', import.meta.url), 'utf8')

// Runs inside the fixture page, against the unchanged bundle's public apply().
function mountAppearance(fallback) {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: (initial) => [initial, () => {}],
    useRef: (current) => ({ current }),
    Fragment: Symbol('Fragment'),
  }
  let section
  const plugin = window.appearanceEntry.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return fallback ? {} : { Menu: (props) => React.createElement('span', null, props.anchor) }
    }
    throw Error('Unexpected dependency: ' + name)
  })
  plugin.apply({
    theme: { getTheme: () => ({ preference: 'system', fontSize: 14 }) },
    settingsScope: { bind: () => ({
      getSnapshot: () => ({ status: 'ready', value: { animation: 'on', ui: 'desktop' } }),
      subscribe: () => () => {},
    }) },
    slots: {
      inject: (_name, callback) => callback(),
      register: (_spec, component) => { section = component; return () => {} },
    },
    on: () => () => {},
    effect: (callback) => callback(),
  })
  function render(node) {
    if (node == null || node === false) return document.createTextNode('')
    if (Array.isArray(node)) {
      const fragment = document.createDocumentFragment()
      node.forEach((child) => fragment.append(render(child)))
      return fragment
    }
    if (typeof node !== 'object') return document.createTextNode(String(node))
    if (typeof node.type === 'function') return render(node.type(node.props))
    if (node.type === React.Fragment) return render(node.children)
    const element = document.createElement(node.type)
    for (const [key, value] of Object.entries(node.props)) {
      if (key === 'style') {
        for (const [property, val] of Object.entries(value)) {
          const unitless = ['flex', 'opacity', 'fontWeight', 'lineHeight', 'zIndex']
          element.style[property] = typeof val === 'number' && val !== 0 && !unitless.includes(property)
            ? val + 'px' : val
        }
      } else if (key === 'ref') value.current = element
      else if (!key.startsWith('on') && key !== 'key' && value != null) {
        element.setAttribute(key === 'className' ? 'class' : key, String(value))
      }
    }
    node.children.forEach((child) => element.append(render(child)))
    return element
  }
  document.querySelector('#appearance').replaceChildren(render(section()))
}

const html = `<!doctype html><meta charset="utf-8"><style>
body { margin: 32px; font: 14px/22px system-ui; background: white;
  --dsw-alias-bg-module-platform: #f0f1f3; --dsw-alias-label-primary: #202124;
  --dsw-alias-label-tertiary: #71757c; --dsw-alias-border-l2: #e0e1e4;
  --dsw-alias-border-l4: #b5b8be; --dsw-alias-interactive-bg-hover: #e5e7eb; }
body[data-ds-dark-theme] { background: #151517;
  --dsw-alias-bg-module-platform: #232324; --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-tertiary: #adb2b8; --dsw-alias-border-l2: #333;
  --dsw-alias-border-l4: #60646c; --dsw-alias-interactive-bg-hover: #3a3c42; }
.fixture_tools { display: flex; gap: 8px; margin-bottom: 16px; }
.fixture_add { width: 36px; height: 36px; border: none; border-radius: 18px;
  background: transparent; color: var(--dsw-alias-label-primary); }
.fixture_add:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.fixture_add svg { width: 16px; height: 16px; }
#appearance { width: 640px; }
</style><style>${css}</style><body><div class="fixture_tools">
<button class="fixture_add" aria-label="添加">+</button>
<button class="fixture_add" aria-label="附件"><svg viewBox="0 0 16 16"><path d="M4 8V4a3 3 1 0 1 6 0v7a2 2 0 0 1-4 0V5" fill="none" stroke="currentColor"/></svg></button>
<button class="fixture_add" disabled>+</button></div><div id="appearance"></div>
<script>window.__ModuleLoader__ = { load: entry => window.appearanceEntry = entry }</script>
<script>${source.replaceAll('</script', '<\\/script')}</script>
<script>window.mountAppearance = ${mountAppearance}; mountAppearance(false)</script>`
const file = join(dir, 'probe.html')
writeFileSync(file, html)
const edge = spawn(edgePath, ['--headless=new', '--remote-debugging-port=0',
  '--user-data-dir=' + join(dir, 'profile'), '--no-first-run', '--disable-gpu',
  '--window-size=900,700', pathToFileURL(file).href], { stdio: 'ignore', windowsHide: true })
const stopped = once(edge, 'exit').catch(() => {})
let launchError
edge.on('error', (error) => { launchError = error })
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let ws
let send
try {
  const activePort = join(dir, 'profile', 'DevToolsActivePort')
  for (let attempt = 0; !existsSync(activePort); attempt++) {
    if (launchError) throw launchError
    assert.ok(attempt < 80 && edge.exitCode === null, 'Edge did not start')
    await delay(100)
  }
  const port = Number(readFileSync(activePort, 'utf8').split('\n')[0])
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((page) => page.type === 'page' && page.url === pathToFileURL(file).href)
  assert.ok(target, 'The isolated fixture page must exist')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail })
  let nextId = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data), waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    message.error ? waiter.fail(Error(message.error.message)) : waiter.done(message.result)
  }
  send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); fail(Error('CDP timed out: ' + method)) }, 10000)
    pending.set(id, { done, fail, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || 'Page error')
    return result.result.value
  }
  for (let attempt = 0; !await evaluate('!!document.querySelector(".dshAppearance__selector")'); attempt++) {
    assert.ok(attempt < 50, 'Appearance component did not render')
    await delay(100)
  }
  await send('DOM.enable')
  await send('CSS.enable')
  const controls = '.fixture_add, .dshAppearance__option, .dshAppearance__selector'
  const measure = `Array.from(document.querySelectorAll(${JSON.stringify(controls)}), el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return { tag: el.tagName, className: el.className, selected: el.getAttribute('aria-pressed'), disabled: el.disabled,
      transition: s.transitionProperty, duration: s.transitionDuration, background: s.backgroundColor,
      color: s.color, border: s.border, opacity: s.opacity, transform: s.transform,
      width: r.width, height: r.height, x: r.x, y: r.y, right: r.right,
      radius: s.borderRadius, image: s.backgroundImage };
  })`
  async function hover(enabled) {
    const { root } = await send('DOM.getDocument')
    const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: controls })
    for (const nodeId of nodeIds) await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: enabled ? ['hover'] : [] })
    await delay(180)
  }
  for (const fallback of [false, true]) {
    if (fallback) await evaluate('mountAppearance(true)')
    for (const dark of [false, true]) {
      await evaluate(`document.body.toggleAttribute('data-ds-dark-theme', ${dark}); document.documentElement.setAttribute('data-dsh-desktop-animation', 'on')`)
      await hover(false)
      const rest = await evaluate(measure)
      await hover(true)
      const hovered = await evaluate(measure)
      assert.equal(rest.length, 10, 'Three composer controls, six options and the selector')
      for (let index = 0; index < rest.length; index++) {
        const before = rest[index], after = hovered[index]
        assert.equal(after.transition, 'background-color', 'Only the background may interpolate')
        assert.equal(after.duration, '0.12s')
        for (const property of ['color', 'border', 'opacity', 'transform', 'width', 'height', 'x', 'y', 'image']) {
          assert.equal(after[property], before[property], `${property} must stay fixed on hover (control ${index})`)
        }
        if (before.disabled || before.selected === 'true') assert.equal(after.background, before.background)
        else assert.notEqual(after.background, before.background, 'Enabled controls must show hover feedback')
      }
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".fixture_add svg")).transitionProperty'), 'none')
      const pill = hovered.find((control) => control.className === 'dshAppearance__selector')
      assert.equal(pill.tag, fallback ? 'SELECT' : 'BUTTON')
      assert.equal(pill.height, 36)
      assert.equal(pill.radius, '18px')
      assert.match(pill.border, /^0px none/)
      assert.notEqual(pill.image, 'none')
      for (const width of [640, 320]) {
        await evaluate(`document.querySelector('#appearance').style.width = '${width}px'`)
        const geometry = await evaluate(`(() => {
          const pill = document.querySelector('.dshAppearance__selector');
          const row = document.querySelector('.dshAppearance').children[1];
          const r = row.getBoundingClientRect(), p = pill.getBoundingClientRect();
          return { width: p.width, right: r.right - p.right, center: r.y + r.height/2 - p.y - p.height/2 };
        })()`)
        assert.ok(geometry.width < width / 2 && Math.abs(geometry.right) < 1 && Math.abs(geometry.center) < 1,
          'The intrinsic pill must be right-aligned and vertically centred: ' + JSON.stringify(geometry))
      }
      await evaluate("document.querySelector('#appearance').style.width = '640px'")
      await evaluate("document.documentElement.setAttribute('data-dsh-desktop-animation', 'off')")
      assert.ok((await evaluate(measure)).every((control) => control.transition === 'none'), 'Off suppresses hovered transitions')
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await evaluate("document.documentElement.setAttribute('data-dsh-desktop-animation', 'system')")
      assert.ok((await evaluate(measure)).every((control) => control.transition === 'none'), 'System honours reduced motion')
      await evaluate("document.documentElement.setAttribute('data-dsh-desktop-animation', 'on')")
      assert.ok((await evaluate(measure)).every((control) => control.transition === 'background-color'), 'On overrides reduced motion')
      console.log(`PASS ${dark ? 'dark' : 'light'} ${fallback ? 'fallback select' : 'menu button'}: hover, layout (640/320px), motion preferences`)
    }
  }
  if (process.argv[2]) {
    await evaluate('mountAppearance(false)')
    await hover(false)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(process.argv[2]), Buffer.from(screenshot.data, 'base64'))
  }
} finally {
  if (send) await send('Browser.close').catch(() => {})
  if (ws) ws.close()
  if (edge.exitCode === null) edge.kill()
  await Promise.race([stopped.catch(() => {}), delay(3000)])
  const child = relative(resolve(tmpdir()), resolve(dir))
  assert.ok(child.startsWith('dsh-appearance-probe-') && !child.includes('..'), 'Cleanup must stay in the probe temp directory')
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
