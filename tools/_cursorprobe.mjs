/**
 * Measures the terminal cursor in a real engine, against the SHIPPED bundle.
 *
 * ## Why a browser and not a test
 *
 * `cursorWidth` is not a width at all — it is the spread of an inset `box-shadow`
 * that xterm injects into a `<style>` element inside the terminal. Nothing about
 * the rendered shape can be read out of the option object, and the option object is
 * the only thing a text assertion can see. So this probe renders and measures.
 *
 * ## Why TWO PAGES rather than two terminals side by side
 *
 * The first version of this probe opened the production terminal and a control
 * terminal in ONE page, and the control corrupted the measurement. xterm's renderer
 * scopes its cursor rules with a per-module counter — `.xterm-dom-renderer-owner-1`
 * — and the bundle carries its OWN copy of xterm while a `<script src="xterm.js">`
 * carries another. Both copies start that counter at 1, so both emitted
 * `.xterm-dom-renderer-owner-1 .xterm-rows .xterm-cursor.xterm-cursor-bar` at equal
 * specificity, and the control's `1px` — injected second — won the cascade and was
 * painted for the REAL terminal too. Reported: a 1px white bar, which is exactly
 * what a broken change would look like.
 *
 * The production page loads one copy of xterm and cannot hit this. The probe
 * therefore measures one terminal per page load and compares ACROSS navigations:
 * same engine, same fonts, same DOM, same window size — only the code under test
 * differs.
 *
 * ## What is real here, and what is stubbed
 *
 * `dsh-plugin/sidebar-terminal/assets/terminal.js` — the exact file
 * `desktop-ui.mjs` injects into the served page — is loaded as a `<script>`. The
 * registry and view under test are therefore the production path: this probe calls
 * `createRegistry(...).view(...).mount(...)`, which is what `createBody`'s layout
 * effect calls, and xterm is the real 5.5.0 from `node_modules`.
 *
 * Stubbed: the Tauri bridge (`window.__TAURI__.core`), exactly as
 * `sidebar-terminal-interactions.test.mjs` stubs it. No native PTY is created, so
 * the only thing measured is what the view hands xterm — the change under test.
 *
 * Run: node tools/_cursorprobe.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9381

/** The production bundle and its stylesheet, as the served page receives them. */
const BUNDLE = join(root, 'dsh-plugin/sidebar-terminal/assets/terminal.js')
const TERMINAL_CSS = join(root, 'dsh-plugin/sidebar-terminal/assets/terminal.css')
const XTERM_LIB = join(root, 'node_modules/@xterm/xterm/lib/xterm.js')

for (const file of [BUNDLE, TERMINAL_CSS, XTERM_LIB]) {
  if (!existsSync(file)) throw new Error(`missing ${file} — run: npm run build:terminal`)
}

/** The view's own terminal options, transcribed so the control is identical but for the cursor. */
const BASELINE_OPTIONS =
  "{ cols: 80, rows: 24, scrollback: 10000, fontSize: 13, fontFamily: 'Cascadia Mono, Consolas, monospace', allowProposedApi: false, allowTransparency: false, windowsPty: { backend: 'conpty' }," +
  // The cursor colours are transcribed from the bundle's own `theme()`, so the
  // control reproduces the PRE-CHANGE appearance (an accent block) and not xterm's
  // white default. Without them the two pages would differ in ink as well as shape,
  // and "the block was the same accent" would be a claim about nothing.
  " theme: { cursor: '#63a8f8', cursorAccent: '#151517', background: '#151517', foreground: '#e6e6e6' } }"

/**
 * One page, one terminal.
 *
 * `mode` decides which code builds it:
 *
 * - `after` — the production bundle, through `createRegistry().view().mount()`.
 * - `before` — xterm's own defaults in the same DOM, which is the block cursor
 *   this change removes. Every non-cursor option is transcribed from the bundle's
 *   own `new Terminal({...})` so the two pages differ in the cursor and nothing
 *   else.
 *
 * `.dshTerminal` wraps the host because the view's `theme()` reads its computed
 * background — without it `theme()` returns early and no colours are applied. The
 * dark attribute is what makes that read resolve to the Mocha table, i.e. the theme
 * the accent cursor colour comes from.
 */
const page = (mode) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#151517}
  /* The surface the view reads: the app's own dark base. */
  .dshTerminal{display:flex;flex-direction:column;width:640px;height:320px;background:#151517;color:#e6e6e6;
    font:13px/1.2 'Cascadia Mono',Consolas,monospace}
  .dshTerminal__viewport{position:relative;flex:1 1 0;min-height:0;overflow:hidden}
  .dshTerminal__screen{position:absolute;inset:0;padding:5px 6px;box-sizing:border-box}
  .dshTerminal .xterm{height:100%}
</style>
<link rel="stylesheet" href="${pathToFileURL(TERMINAL_CSS).href}">
</head><body data-ds-dark-theme>
  <div class="dshTerminal" id="surfaceA">
    <div class="dshTerminal__viewport"><div class="dshTerminal__screen" id="hostA"></div></div>
  </div>
${mode === 'after' ? productionScript() : baselineScript()}
</body></html>`

/** The production path: the shipped bundle, mounted exactly as the plugin mounts it. */
function productionScript() {
  return `<script src="${pathToFileURL(BUNDLE).href}"></script>
<script>
  // ── the Tauri bridge, stubbed exactly as the interactions test stubs it ──
  const callLog = [];
  const VIEW_KEY = 'dsh-resource://desktop-terminal/probe';
  const info = { resourceKey: VIEW_KEY, terminalId: 't1', runId: 1, state: 'running', profileId: 'pwsh', cwd: 'C:\\\\a' };
  window.__DSH_TERMINAL_IDENTITY__ = { probe: true };
  window.__TAURI__ = { core: {
    Channel: class { constructor() { this.onmessage = null; } },
    invoke: async (name) => {
      callLog.push(name);
      if (name === 'terminal_list') return [];
      if (name === 'terminal_profiles') return [{ profileId: 'pwsh', name: 'PowerShell' }];
      if (name === 'terminal_open') return info;
      if (name === 'terminal_attach') return 'a1';
      if (name === 'terminal_control') return 1;
      return {};
    },
  } };

  const tabs = {}; tabs[VIEW_KEY] = { contentId: VIEW_KEY };
  const store = { getSnapshot: () => ({ bySession: { s: { layout: { tabs } } } }), subscribe: () => () => {} };
  const ctx = {
    slots: { entriesOfSlot: () => [{ store: { create() { throw Error('unused') } } }], resolveStore: () => store },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: ['s'], current: 's' }), subscribe: () => () => {} }, scope: () => ({}) },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [{ path: 'C:\\\\a', sessionIds: ['s'] }] }) } },
  };

  window.__probe = { mode: 'after', ready: false };
  try {
    const registry = window.DSHTerminal.createRegistry(ctx, null);
    const view = registry.view({ signal: {}, contentId: VIEW_KEY });
    view.mount(document.getElementById('hostA'));
    window.__probe = { mode: 'after', ready: true, created: true, calls: callLog };
  } catch (error) {
    window.__probe = { mode: 'after', ready: true, created: false, error: String((error && error.stack) || error), calls: callLog };
  }
</script>`
}

/** The control: xterm's defaults, i.e. the block cursor, in the same DOM. */
function baselineScript() {
  return `<script src="${pathToFileURL(XTERM_LIB).href}"></script>
<script>
  window.__probe = { mode: 'before', ready: false };
  try {
    const terminal = new Terminal(${BASELINE_OPTIONS});
    terminal.open(document.getElementById('hostA'));
    terminal.write('baseline');
    // Focused explicitly: the block is only painted while the terminal has focus,
    // and this page has no view to call focus() on its own.
    terminal.focus();
    window.__probe = { mode: 'before', ready: true, created: true, calls: [] };
  } catch (error) {
    window.__probe = { mode: 'before', ready: true, created: false, error: String((error && error.stack) || error), calls: [] };
  }
</script>`
}

/**
 * Read the cursor out of the page's one terminal.
 *
 * `box-shadow` is the measurement, not a stand-in for one: for a bar cursor xterm
 * draws nothing but `<cursorWidth>px 0 0 <colour> inset`, so the horizontal length
 * in the computed value IS the painted bar width. The span's own border box stays a
 * full cell wide in both styles, which is why the rect alone would report the same
 * number for a block and a bar and prove nothing.
 *
 * WRITTEN WITH String.raw BECAUSE OF THE REGEXES. This expression is inside a
 * template literal, where `\\d` and `\b` are escape sequences the OUTER string
 * consumes — so a `\b` silently becomes a backspace and the regex never matches.
 * `String.raw` removes the trap.
 */
const MEASURE = String.raw`(() => {
  const el = document.querySelector('#surfaceA .xterm-cursor');
  const rows = document.querySelector('#surfaceA .xterm-rows');
  const term = document.querySelector('#surfaceA .xterm');
  if (!el) return { probe: window.__probe, found: false, terminalMounted: Boolean(term) };

  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const shadow = cs.boxShadow;
  // xterm injects one length plus the colour and the inset keyword, but the ENGINE
  // re-serialises computed shadows - it zero-pads to four lengths and moves the
  // colour to the front - so the spread position cannot be assumed. Read every
  // length and keep the horizontal one, which is the painted width either way.
  const lengths = [...shadow.matchAll(/(-?[\d.]+)px/g)].map(m => Number(m[1]));
  const colour = /(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(shadow);

  // Which rules actually matched, asked of the engine: a computed value alone
  // cannot say whether a stylesheet lost a cascade or never matched at all.
  const matched = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = [...sheet.cssRules] } catch { continue }
    for (const rule of rules) {
      if (!rule.selectorText || !rule.style.boxShadow) continue;
      let hit = false;
      try { hit = el.matches(rule.selectorText) } catch { hit = false }
      if (hit) matched.push({ selector: rule.selectorText, shadow: rule.style.boxShadow });
    }
  }

  const cell = rows && rows.children[0] && rows.children[0].children[0]
    ? rows.children[0].children[0].getBoundingClientRect() : null;
  return {
    probe: window.__probe,
    found: true,
    terminalMounted: Boolean(term),
    termClasses: term ? term.className : null,
    style: ['bar', 'block', 'outline', 'underline'].find(n => el.classList.contains('xterm-cursor-' + n)) || 'none',
    classes: el.className,
    blink: el.classList.contains('xterm-cursor-blink'),
    boxShadow: shadow,
    lengths,
    paintedWidth: lengths.length >= 3 && lengths[1] === 0 ? Math.abs(lengths[0]) : null,
    insetColor: colour ? colour[1] : null,
    backgroundColor: cs.backgroundColor,
    cursorBox: { w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 },
    // The cell advance, read from the terminal's own character measurement rather
    // than from a rendered row: a row's first span is the joined prefix, so its box
    // is the whole word (measured at 60.8px for "baseline") and not one cell.
    cellWidth: (() => {
      const measure = document.querySelector('#surfaceA .xterm-char-measure-element');
      return measure ? Math.round((measure.getBoundingClientRect().width / 32) * 100) / 100 : null;
    })(),
    cellBoxWidth: cell ? Math.round(cell.width * 100) / 100 : null,
    fontFamily: rows ? getComputedStyle(rows).fontFamily : null,
    fontSize: rows ? getComputedStyle(rows).fontSize : null,
    matched,
  };
})()`

const dir = mkdtempSync(join(tmpdir(), 'dsh-cursorprobe-'))
const files = { before: join(dir, 'before.html'), after: join(dir, 'after.html') }
writeFileSync(files.before, page('before'), 'utf8')
writeFileSync(files.after, page('after'), 'utf8')

if (!existsSync(EDGE)) throw new Error(`Edge not found at ${EDGE}`)

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + join(dir, 'profile'),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=900,600',
    'file:///' + files.before.replace(/\\/g, '/'),
  ],
  { stdio: 'ignore', windowsHide: true },
)

/** Poll the CDP endpoint until the page target is up. */
async function target() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Edge did not expose a page target')
}

/** A CDP session over a raw WebSocket. */
async function session(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let next = 0
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return {
    send,
    close: () => ws.close(),
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluation failed')
      return r.result.value
    },
  }
}

/** Load one page and read its cursor. */
async function measure(cdp, file, label) {
  await cdp.send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') })
  // The view opens the terminal, themes it and focuses it asynchronously, and the
  // cursor is only drawn once the textarea has focus.
  await new Promise((r) => setTimeout(r, 1800))
  const value = await cdp.evaluate(MEASURE)
  if (!value.found) throw new Error(`${label}: no cursor was rendered (probe=${JSON.stringify(value.probe)})`)
  return value
}

const checks = []
const check = (name, ok, detail) => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  → ' + detail}`)
}

try {
  const t = await target()
  const cdp = await session(t.webSocketDebuggerUrl)
  const before = await measure(cdp, files.before, 'before')
  const after = await measure(cdp, files.after, 'after')
  cdp.close()

  console.log('=== BEFORE — xterm defaults, the block cursor ===')
  console.log(JSON.stringify(before, null, 1))
  console.log('\n=== AFTER — the shipped bundle ===')
  console.log(JSON.stringify(after, null, 1))

  const cell = after.cellWidth
  console.log(`\ncell advance ${cell}px  ·  bar ${after.paintedWidth}px  ·  block ${before.cursorBox.w}px`)

  console.log('\n--- the change ---')
  check('a cursor is rendered in both pages', before.found && after.found)
  check('the terminal mounted from the real view', after.terminalMounted === true)
  check('the shipped bundle built its view', after.probe?.created === true, after.probe?.error)
  check(
    'the view went through the real open path',
    ['terminal_open', 'terminal_attach'].every((c) => after.probe.calls.includes(c)),
    after.probe.calls.join(','),
  )

  check('BEFORE was the block cursor', before.style === 'block', before.style)
  check('AFTER is a bar', after.style === 'bar', after.style)
  check('AFTER does not fall back to the outline cursor', after.style !== 'outline')
  check('the blink default is unchanged', after.blink === false, String(after.blink))
  check(
    'the controls are the same shape of cursor box, so the two agree on the cell',
    before.cursorBox.w === after.cursorBox.w && before.cursorBox.h === after.cursorBox.h,
    `${before.cursorBox.w}x${before.cursorBox.h} vs ${after.cursorBox.w}x${after.cursorBox.h}`,
  )

  console.log('\n--- the width, which is what the request was about ---')
  check('the bar is 4 CSS px', after.paintedWidth === 4, String(after.paintedWidth))
  check(
    'the block filled its whole cell — the thing being half-ed',
    before.paintedWidth === null && before.backgroundColor !== 'rgba(0, 0, 0, 0)',
    `${before.backgroundColor} over a ${before.cursorBox.w}px cell`,
  )
  check(
    'the bar is thinner than the glyph cell it sits in',
    after.paintedWidth < cell,
    `${after.paintedWidth} < ${cell}`,
  )
  check(
    'the bar is at least a quarter of the cell, so it survives a HiDPI scale',
    after.paintedWidth >= cell / 4,
    `${after.paintedWidth} vs ${cell}/4 = ${Math.round((cell / 4) * 100) / 100}`,
  )
  check(
    'the bar is strictly narrower than the block it replaces',
    after.paintedWidth < before.cursorBox.w,
    `${after.paintedWidth} < ${before.cursorBox.w}`,
  )

  console.log('\n--- the ink is still the Codex accent ---')
  check(
    'the bar is painted in ChatGPT Blue 200',
    /rgb\(99,\s*168,\s*248\)/.test(after.insetColor || ''),
    after.insetColor,
  )
  check(
    'the block it replaces was the same accent',
    /rgb\(99,\s*168,\s*248\)/.test(before.backgroundColor || ''),
    before.backgroundColor,
  )

  console.log('\n--- one xterm, so the rule that matched is the rule that painted ---')
  const painters = after.matched.filter((r) => /cursor/.test(r.selector))
  console.log('matched cursor rules:', JSON.stringify(painters))
  check(
    'exactly one bar rule matched the element',
    painters.length === 1,
    `${painters.length} matched`,
  )
  check(
    'and it is the 4px accent rule',
    painters.length === 1 && /4px/.test(painters[0].shadow) && /99,\s*168,\s*248/.test(painters[0].shadow),
    painters[0]?.shadow,
  )

  console.log('\n--- the surface still came up ---')
  check('the app font resolved', /Cascadia/i.test(after.fontFamily || ''), after.fontFamily)
  check(
    'the two pages used the same font size, so the cells are comparable',
    before.fontSize === after.fontSize,
    `${before.fontSize} vs ${after.fontSize}`,
  )
  check(
    'and the same cell advance',
    before.cellWidth === after.cellWidth,
    `${before.cellWidth} vs ${after.cellWidth}`,
  )

  const failed = checks.filter(([, ok]) => !ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  edge.kill()
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the profile dir can stay locked briefly; harmless */
    }
  }, 500).unref?.()
}
