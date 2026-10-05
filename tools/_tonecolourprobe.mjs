/**
 * Measures the terminal state dot in a real engine, for every tone, on both surfaces.
 *
 * ## Why a browser and not a test
 *
 * "The dot turns red when the terminal is unwell" is a claim about a COLOUR that a
 * stylesheet resolves, and the value that matters is the computed one. The rule is
 * `[data-dsh-terminal-tone='bad'] .dshTerminal__dot { background: … }`, and whether
 * it wins depends on the cascade, on a CSS custom property the app defines at
 * runtime, and — for the bottom panel — on a `:is()` GATE that only matches while
 * the dock is visible or the overlay is on. A text assertion can confirm the rule
 * was written; only the engine can confirm the dot is red.
 *
 * The two surfaces do NOT share the rule, and that is the specific thing worth
 * measuring: the sidebar keys off `.dshTerminal__status`, the panel off
 * `.dshTerminalDock__label`. A typo in either leaves one of them silently toneless.
 *
 * The markup below is transcribed from `runtime.mjs`'s `createBody` and `dock.mjs`'s
 * tab row, and the stylesheets are the REAL files in production order (xterm's own,
 * `terminal.css`, then the overlay's `theme.css`, which is what the app actually
 * loads). The app's own state tokens are supplied as literals because they are
 * defined by the app's runtime theme plugin, not by this project — the stylesheet
 * carries them as `var(…, <literal>)` fallbacks precisely so the dot is right
 * without the overlay, which is what the `原版` column below checks.
 *
 * Run: node tools/_tonecolourprobe.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9391

const files = {
  xterm: join(root, 'node_modules/@xterm/xterm/css/xterm.css'),
  terminal: join(root, 'dsh-plugin/sidebar-terminal/terminal.css'),
  theme: join(root, 'dsh-plugin/ui-overlay/theme.css'),
}
for (const file of Object.values(files)) {
  if (!existsSync(file)) throw new Error(`missing ${file}`)
}

/**
 * The app's state tokens, as its own theme plugin defines them.
 *
 * WHITE-LISTED, not copied wholesale: these are the only custom properties the dot
 * rules read. Supplying them lets the probe ask "does selecting a tone change the
 * colour" without also pretending to be the app's full palette.
 */
const TOKENS = `
  --dsw-alias-label-tertiary: #8b9099;
  --dsw-alias-state-success-primary: #2f9e63;
  --dsw-alias-state-warn-primary: #c8871f;
  --dsw-alias-state-error-primary: #d64545;
  --dsw-alias-label-primary: #252830;
  --dsw-alias-label-secondary: #4a4f57;
  --dsw-alias-border-l3: #ddd;
  --dsw-alias-bg-base: #fff;
  --dsw-alias-bg-layer-1: #fff;
  --dsw-alias-bg-module-platform: rgba(127,127,127,.12);
  --dsw-alias-interactive-bg-hover: rgba(65,118,230,.08);
`

/** One status span per tone, on each surface, in the real DOM shape. */
const dot = (tone) =>
  `<span class="dshTerminal__dot" data-tone="${tone}" aria-hidden="true"></span>`

const PAGE = (css) => `<!doctype html><html data-dsh-ui="desktop" data-dsh-terminal-dock-visible><head><meta charset="utf-8"><style>
  html { ${TOKENS} }
  body { margin:0; background:#fff; font:13px system-ui }
  /* Laid out with the real rules; this only stops the two surfaces overlapping. */
  .row { display:flex; gap:16px; padding:8px; align-items:center }
</style>
<style>${css}</style></head><body>

  <!-- The right sidebar's surface: .dshTerminal__status carries the tone. -->
  <div class="row" id="sidebar">
    ${['ok', 'busy', 'bad', 'idle'].map((tone) => `<span class="dshTerminal__status" data-dsh-terminal-status="x" data-dsh-terminal-tone="${tone}">${dot(tone)}</span>`).join('')}
  </div>

  <!-- The bottom panel's surface: the TAB LABEL carries the tone. -->
  <section class="dshTerminalDock dshTerminal" data-dsh-terminal-dock>
    <div class="row" id="dock">
      ${['ok', 'busy', 'bad', 'idle'].map((tone) => `<button class="dshTerminalDock__label" data-dsh-terminal-tone="${tone}" role="tab">${dot(tone)}<span class="dshTerminalDock__title">终端 1</span></button>`).join('')}
    </div>
  </section>

</body></html>`

/**
 * Read every dot's computed background.
 *
 * `backgroundColor` is the painted fill — these rules set `background`, and a dot is a
 * 6px circle with no border or image, so the computed background colour IS the dot.
 */
const MEASURE = String.raw`(() => {
  const read = (rootSelector, toneAttr) => {
    const out = {};
    for (const tone of ['ok', 'busy', 'bad', 'idle']) {
      const el = document.querySelector(rootSelector + ' [' + toneAttr + '="' + tone + '"] .dshTerminal__dot');
      out[tone] = el ? getComputedStyle(el).backgroundColor : null;
    }
    return out;
  };
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
  };
  // The gate: the dock's tone rules only match while this is present on <html>.
  const html = document.documentElement;
  return {
    sidebar: read('#sidebar', 'data-dsh-terminal-tone'),
    dock: read('#dock', 'data-dsh-terminal-tone'),
    dotBox: box('#sidebar .dshTerminal__dot'),
    dockDotBox: box('#dock .dshTerminal__dot'),
    gateAttribute: html.getAttribute('data-dsh-terminal-dock-visible'),
    uiMode: html.getAttribute('data-dsh-ui'),
  };
})()`

/**
 * Flip to 原版 with the dock NOT explicitly revealed, which is the only state in
 * which the panel's tone rules stop matching.
 *
 * BOTH changes are needed, and getting that wrong is what the first version of this
 * probe did: the gate is
 *
 *     html:is(:not([data-dsh-ui='vanilla']), [data-dsh-terminal-dock-visible]) …
 *
 * — an `:is()` of TWO branches, so clearing the dock attribute alone still matches
 * through the desktop branch and nothing changes. The probe reported the panel rule
 * as ungated, which was a false finding about correct CSS. Both branches have to
 * fail before the rule really is off.
 */
const TOGGLE_GATE = String.raw`(() => {
  document.documentElement.setAttribute('data-dsh-ui', 'vanilla');
  document.documentElement.removeAttribute('data-dsh-terminal-dock-visible');
  return true;
})()`

const css = ['xterm', 'terminal', 'theme']
  .map((key) => readFileSync(files[key], 'utf8'))
  .join('\n')

const dir = mkdtempSync(join(tmpdir(), 'dsh-tonecolour-'))
const file = join(dir, 'tone.html')
writeFileSync(file, PAGE(css), 'utf8')

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
    '--window-size=900,400',
    'file:///' + file.replace(/\\/g, '/'),
  ],
  { stdio: 'ignore', windowsHide: true },
)

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

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const result = await new Promise((res, rej) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === 1) res(msg.result)
    }
    ws.onerror = rej
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  ws.close()
  return result
}

const checks = []
const check = (name, ok, detail) => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  → ' + detail}`)
}

try {
  const t = await target()
  await new Promise((r) => setTimeout(r, 700))
  const m = (await evaluate(t.webSocketDebuggerUrl, MEASURE)).result.value
  console.log(JSON.stringify(m, null, 1))

  const GREEN = 'rgb(47, 158, 99)'
  const AMBER = 'rgb(200, 135, 31)'
  const RED = 'rgb(214, 69, 69)'

  for (const [surface, tone] of [['sidebar', 'sidebar'], ['dock', 'panel']]) {
    console.log(`\n--- the ${tone} dot ---`)
    const table = m[surface]
    check(`${tone}: ok is green`, table.ok === GREEN, table.ok)
    check(`${tone}: busy is amber`, table.busy === AMBER, table.busy)
    check(`${tone}: bad is RED — the warning the user asked for`, table.bad === RED, table.bad)
    check(`${tone}: idle is the neutral ink, not a warning`, table.idle === 'rgb(139, 144, 153)', table.idle)
    check(
      `${tone}: the four tones are four different colours`,
      new Set([table.ok, table.busy, table.bad, table.idle]).size === 4,
      JSON.stringify(Object.values(table)),
    )
    check(
      `${tone}: the warning is distinguishable from "working on it"`,
      table.bad !== table.busy,
      `bad=${table.bad} busy=${table.busy}`,
    )
  }

  console.log('\n--- the dot is a real 6px circle on both surfaces ---')
  check('sidebar dot is 6x6', m.dotBox?.w === 6 && m.dotBox?.h === 6, JSON.stringify(m.dotBox))
  check('panel dot is 6x6', m.dockDotBox?.w === 6 && m.dockDotBox?.h === 6, JSON.stringify(m.dockDotBox))

  console.log('\n--- the tones really come from the gated rules (so the reading is not vacuous) ---')
  await evaluate(t.webSocketDebuggerUrl, TOGGLE_GATE)
  await new Promise((r) => setTimeout(r, 200))
  const ungated = (await evaluate(t.webSocketDebuggerUrl, MEASURE)).result.value
  console.log('in 原版 with the dock hidden:', JSON.stringify({ sidebar: ungated.sidebar, dock: ungated.dock }))
  check(
    'in 原版 with the dock hidden the panel loses its tones',
    ungated.dock.bad !== RED,
    `bad=${ungated.dock.bad}`,
  )
  check(
    'the sidebar is ungated and keeps its tones in 原版',
    ungated.sidebar.bad === RED,
    `bad=${ungated.sidebar.bad}`,
  )
  check(
    'so the panel tones are the gated theme.css rules, not the ungated fallback',
    ungated.dock.idle === 'rgb(139, 144, 153)',
    `idle=${ungated.dock.idle} (the ungated base rule)`,
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
