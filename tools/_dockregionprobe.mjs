/**
 * Measures the bottom panel's REGION rules in a real engine.
 *
 * ## Why a browser and not a test
 *
 * These checks need computed browser geometry: the panel must reserve space below
 * the conversation and fit between the sidebar and the window's right edge.
 * Shared terminal styles once left it at width:100% despite its left inset,
 * clipping both terminal output and the right-hand controls beyond the window.
 *
 * ## What is modelled, and what is transcribed
 *
 * The frame, its three columns, the overlay layer and the docked right panel are
 * transcribed from the live app's own markup and inline styles (read out of
 * `dsh-client-ui-layout`'s AppFrame and `dsh-client-ui-sidebar-right`'s
 * SidebarPanel), then styled with the REAL rules copied out of
 * `dsh-plugin/ui-overlay/theme.css` and `dsh-plugin/sidebar-terminal/terminal.css`
 * — loaded completely in production order, including the shared terminal rules.
 * A real xterm instance verifies that its screen fits after sidebar-width changes.
 *
 * What it therefore proves: the ENGINE's resolution of this stylesheet against
 * this structure. What it does not prove: that DSH's shipped markup is still shaped
 * this way. That half is asserted separately by `tools/check-menus.mjs`-style
 * source reads and by `inspect-live.mjs` against the running app.
 *
 * Run: node tools/_dockregionprobe.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9371

/** Load the complete styles in production order, including shared terminal rules. */
function regionCss() {
  const theme = readFileSync(join(root, 'dsh-plugin/ui-overlay/theme.css'), 'utf8')
  const terminal = readFileSync(join(root, 'dsh-plugin/sidebar-terminal/terminal.css'), 'utf8')
  const xterm = readFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')
  // Filtering for Dock selectors omitted .dshTerminal's width:100%, masking the
  // overflow in the real page. Keep the cascade and media queries intact.
  return [xterm, terminal, theme].join('\n')
}

/**
 * A page shaped like the live frame.
 *
 * The class names carry the app's real readable suffixes with a fake hash prefix,
 * exactly as the built page presents them, so the `[class*=…]` selectors match the
 * way they do in the app. The right panel is `position:absolute` inside its column
 * with the app's own `data-sidebar-right-panel` attribute, because "does padding on
 * the column move it" is the question, and an absolutely positioned box resolves
 * its insets against the containing block's PADDING box.
 *
 * THE TWO VARIABLES ARE SET THE WAY THE COMPONENT SETS THEM, and they belong in the
 * page rather than in the stylesheet under test: they are what
 * `createDockComponent`'s layout effects publish (`--dsh-terminal-dock-height` from
 * the panel's state, `--dsh-terminal-dock-left` from a measurement of the left
 * column). Writing them here is what makes the stylesheet's resolution — not the
 * component's publication — the thing being measured.
 */
const PAGE = (css) => `<!doctype html><html data-dsh-ui="desktop"><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#111;color:#eee;font:13px system-ui}
  /* Published by the dock component; see the note above. */
  html{--dsh-terminal-dock-height:240px;--dsh-terminal-dock-left:280px}
  #root{position:fixed;inset:44px 0 0 0;height:auto}
  .zz_frame{background:#111;height:100%;display:grid;position:relative;overflow:hidden;
    grid-template-rows:100%;grid-template-columns:280px minmax(0,1fr) 340px}
  .zz_sidebarCol{background:#1b1b1d;border-right:.5px solid #333;min-width:0;overflow:hidden}
  .zz_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}
  .zz_rightbarCol{min-width:0;position:relative;overflow:visible}
  .zz_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}
  .zz_overlayLayer>*{pointer-events:auto}
  .P3OORG_panel{z-index:10;background:#18181a;visibility:visible;flex-direction:column;
    display:flex;position:absolute;top:0;bottom:0;right:0;width:340px}
  .probe-side{height:100%;display:flex;align-items:flex-end;padding:6px}
  .probe-center{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
  .probe-scroll{flex:1 1 auto;overflow:auto;padding:6px}
  .probe-composer{flex:none;height:56px;background:#2a2a2e;display:flex;align-items:center;padding:0 8px}
  .probe-panel-body{flex:auto;min-height:0;display:flex;align-items:flex-end;padding:6px}
${css}
</style></head><body><div id="root"><div class="zz_frame" style="grid-template-columns:280px minmax(0,1fr) 340px">
  <div class="zz_sidebarCol"><div class="probe-side">SIDEBAR-BOTTOM</div></div>
  <div class="zz_centerCol"><div class="probe-center">
    <div class="probe-scroll">CENTER</div><div class="probe-composer">COMPOSER</div>
  </div></div>
  <div class="zz_rightbarCol"><div class="P3OORG_panel" data-sidebar-right-panel="push" data-sidebar-right-open>
    <div class="P3OORG_panelBody"><div class="probe-panel-body">PANEL-BOTTOM</div></div>
  </div></div>
  <div class="zz_overlayLayer" data-shell-overlay><section class="dshTerminalDock dshTerminal" data-dsh-terminal-dock style="height:240px">
    <div class="dshTerminalDock__bar"><div class="dshTerminalDock__tabs"><div class="dshTerminalDock__tab" data-active="true"><button class="dshTerminalDock__label">终端 1</button></div></div>
    <button class="dshTerminalDock__add">+</button>
    <span class="dshTerminal__actions"><button class="dshTerminal__shell">PowerShell</button><button class="dshTerminal__more">...</button><button class="dshTerminal__collapse">⌄</button></span></div>
    <div class="dshTerminal__viewport"><div class="dshTerminal__screen"></div></div>
  </section></div>
</div></div>
<script src="${pathToFileURL(join(root, 'node_modules/@xterm/xterm/lib/xterm.js')).href}"></script>
<script src="${pathToFileURL(join(root, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')).href}"></script>
<script>
  const terminal = new Terminal({ fontSize: 13, fontFamily: 'Consolas, monospace' });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  const screen = document.querySelector('.dshTerminal__screen');
  terminal.open(screen);
  new ResizeObserver(() => {
    if (!screen.getBoundingClientRect().width) return;
    fit.fit();
    terminal.clear();
    terminal.write('\\r' + '.'.repeat(Math.max(0, terminal.cols - 7)) + '[RIGHT]');
  }).observe(screen);
</script></body></html>`

/**
 * Read every box the region rules decide, from the live layout.
 *
 * Reported as ABSOLUTE coordinates so the numbers can be compared across the
 * sidebar's width: the panel's left edge against the sidebar's right edge is the
 * whole claim, and both are read from the same frame.
 */
const MEASURE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) };
  };
  const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
  return {
    sidebar: box('.zz_sidebarCol'),
    center: box('.zz_centerCol'),
    composer: box('.probe-composer'),
    rightPanel: box('.P3OORG_panel'),
    panelBody: box('.probe-panel-body'),
    dock: box('[data-dsh-terminal-dock]'),
    actions: box('.dshTerminal__actions'),
    terminal: box('.xterm-screen'),
    centerBoxSizing: cs('.zz_centerCol', 'boxSizing'),
    centerPaddingBottom: cs('.zz_centerCol', 'paddingBottom'),
    sidebarPaddingBottom: cs('.zz_sidebarCol', 'paddingBottom'),
    rightPanelBottom: cs('.P3OORG_panel', 'bottom'),
    frameHeight: document.querySelector('.zz_frame').getBoundingClientRect().height,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  };
})()`

const dir = mkdtempSync(join(tmpdir(), 'dsh-dockregion-'))
const file = join(dir, 'region.html')
writeFileSync(file, PAGE(regionCss()), 'utf8')

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + join(dir, 'profile'),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,840',
    'file:///' + file.replace(/\\/g, '/'),
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

/** One CDP evaluate over a raw WebSocket. */
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
  await new Promise((r) => setTimeout(r, 600))

  // ── the panel's height is what it reserves, and it starts at the sidebar's edge
  const withPanel = (await evaluate(t.webSocketDebuggerUrl, MEASURE)).result.value
  console.log('\nwith a 240px panel:', JSON.stringify(withPanel, null, 1))

  console.log('\n--- the region excludes the left column ---')
  check(
    'the panel starts where the left column ends',
    withPanel.dock.left === withPanel.sidebar.right,
    `dock.left=${withPanel.dock.left} sidebar.right=${withPanel.sidebar.right}`,
  )
  check(
    'the panel reaches the window edge',
    withPanel.dock.right === withPanel.innerWidth,
    `right=${withPanel.dock.right} innerWidth=${withPanel.innerWidth}`,
  )
  check('the panel is the height it asked for', withPanel.dock.h === 240, `h=${withPanel.dock.h}`)
  check('the right-hand controls stay inside the window', withPanel.actions.right <= withPanel.innerWidth)
  check('the terminal screen stays inside the window', withPanel.terminal.right <= withPanel.innerWidth)

  // ── the sidebar keeps its FULL height: it is not shortened by the panel
  console.log('\n--- the left column is not shortened ---')
  check(
    'the left column reaches the bottom of the frame',
    withPanel.sidebar.bottom === withPanel.dock.bottom,
    `sidebar.bottom=${withPanel.sidebar.bottom} dock.bottom=${withPanel.dock.bottom}`,
  )
  check('the left column is not padded', withPanel.sidebarPaddingBottom === '0px', withPanel.sidebarPaddingBottom)

  // ── the center column concedes exactly the panel's height
  console.log('\n--- the center concedes exactly the panel row ---')
  // NOT a `box-sizing` assertion: the declaration is deliberately absent, and the
  // falsification section below is what justifies that. See the note on the rule.
  check('the center column gets the panel height as padding', withPanel.centerPaddingBottom === '240px', withPanel.centerPaddingBottom)
  check(
    'the composer ends exactly at the panel top',
    withPanel.composer.bottom === withPanel.dock.top,
    `composer.bottom=${withPanel.composer.bottom} dock.top=${withPanel.dock.top}`,
  )
  check(
    'the center column still fills the frame (no overflow)',
    withPanel.center.top === 44 && withPanel.center.bottom === withPanel.innerHeight,
    `[${withPanel.center.top}, ${withPanel.center.bottom}] of ${withPanel.innerHeight}`,
  )

  // ── the docked right panel stops above the bottom panel
  console.log('\n--- the right column concedes too ---')
  check(
    'the docked right panel stops at the panel top',
    withPanel.rightPanel.bottom === withPanel.dock.top,
    `rightPanel.bottom=${withPanel.rightPanel.bottom} dock.top=${withPanel.dock.top}`,
  )
  check(
    'the right panel is offset by the published height',
    withPanel.rightPanelBottom === '240px',
    `bottom=${withPanel.rightPanelBottom}`,
  )

  // ── the control case: close the panel and everything returns
  console.log('\n--- closed: no space is reserved ---')
  await evaluate(t.webSocketDebuggerUrl, `(() => {
    document.documentElement.style.setProperty('--dsh-terminal-dock-left','0px');
    document.documentElement.style.setProperty('--dsh-terminal-dock-height','0px');
    document.querySelector('[data-dsh-terminal-dock]').style.display='none';
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  const closed = (await evaluate(t.webSocketDebuggerUrl, MEASURE)).result.value
  console.log('closed:', JSON.stringify({ center: closed.center, composer: closed.composer, rightPanel: closed.rightPanel, sidebar: closed.sidebar }))
  check('the composer returns to the frame bottom', closed.composer.bottom === closed.innerHeight, `composer.bottom=${closed.composer.bottom}`)
  check('the right panel returns to the frame bottom', closed.rightPanel.bottom === closed.innerHeight, `rightPanel.bottom=${closed.rightPanel.bottom}`)
  check('the sidebar is unchanged by closing', closed.sidebar.bottom === closed.innerHeight, `sidebar.bottom=${closed.sidebar.bottom}`)

  // ── a dragged-wider sidebar moves the panel's edge with it
  console.log('\n--- the sidebar widths the app solves ---')
  for (const width of [56, 264, 420]) {
    // The panel is shown again first: the closing step above hid it, and a
    // `display:none` element measures as all zeros, which would read as "the panel
    // is at 0" — a pass-shaped number for a question this loop is not asking.
    //
    // WRAPPED IN AN IIFE, and that is not style. `Runtime.evaluate` shares one
    // global scope across calls, so a top-level `const` here is re-declared on the
    // second iteration and throws — leaving the frame at the PREVIOUS width while
    // the loop quietly reported the new one. The first run of this probe did exactly
    // that for two of the three widths.
    await evaluate(
      t.webSocketDebuggerUrl,
      `(() => {
       document.querySelector('[data-dsh-terminal-dock]').style.display='';
       document.querySelector('.zz_frame').style.gridTemplateColumns='${width}px minmax(0,1fr) 340px';
       document.documentElement.style.setProperty('--dsh-terminal-dock-left','${width}px');
       document.documentElement.style.setProperty('--dsh-terminal-dock-height','240px');
      })()`,
    )
    await new Promise((r) => setTimeout(r, 200))
    const row = (await evaluate(t.webSocketDebuggerUrl, MEASURE)).result.value
    check(
      `the panel starts at the ${width}px column's edge`,
      row.dock.left === row.sidebar.right && row.sidebar.right === width,
      `dock.left=${row.dock.left} sidebar.right=${row.sidebar.right}`,
    )
    check(
      `the composer still clears the panel at ${width}px`,
      row.composer.bottom === row.dock.top,
      `composer.bottom=${row.composer.bottom} dock.top=${row.dock.top}`,
    )
    check(`the panel uses only the remaining width at ${width}px`, row.dock.w === row.innerWidth - width && row.dock.right === row.innerWidth, `width=${row.dock.w} right=${row.dock.right}`)
    check(`the right-hand controls remain visible at ${width}px`, row.actions.right <= row.innerWidth && row.actions.left >= row.dock.left)
    check(`xterm fits the remaining width at ${width}px`, row.terminal.right <= row.innerWidth && row.terminal.left >= row.dock.left)
  }

  // ── IS `box-sizing` LOAD-BEARING? Measured, by removing it.
  //
  // This check exists because the first version of this rule DID declare
  // `box-sizing: border-box` with a comment calling it essential. Measuring the
  // forced-`content-box` case disproved that: a stretched grid item's specified
  // height stays `auto`, so `box-sizing` cannot apply to it, and the padding
  // resolves inside the 704px cell either way. The declaration and the claim were
  // both removed. The check is kept as the evidence for that decision, and as the
  // instrument that would catch it if the frame's row sizing ever changed to a
  // SPECIFIED height, where `box-sizing` would start to matter.
  console.log('\n--- forcing content-box, to test the box-sizing claim ---')
  await evaluate(t.webSocketDebuggerUrl, `(() => {
    const d = document.querySelector('[data-dsh-terminal-dock]');
    d.style.display = '';
    document.querySelector('.zz_frame').style.gridTemplateColumns = '280px minmax(0,1fr) 340px';
    document.documentElement.style.setProperty('--dsh-terminal-dock-left', '280px');
    document.documentElement.style.setProperty('--dsh-terminal-dock-height', '240px');
    const style = document.createElement('style');
    style.textContent = "html:not([data-dsh-ui='vanilla']) body [class*='_centerCol'] { box-sizing: content-box !important }";
    document.head.append(style);
  })()`)
  await new Promise((r) => setTimeout(r, 250))
  const noBorderBox = (await evaluate(t.webSocketDebuggerUrl, MEASURE)).result.value
  console.log(
    'forced content-box:',
    JSON.stringify({ center: noBorderBox.center, composer: noBorderBox.composer, dockTop: noBorderBox.dock.top, boxSizing: noBorderBox.centerBoxSizing }),
  )
  check(
    'the forced content-box actually applied',
    noBorderBox.centerBoxSizing === 'content-box',
    noBorderBox.centerBoxSizing,
  )
  check(
    'padding alone lifts the composer, so box-sizing is NOT needed',
    noBorderBox.composer.bottom === noBorderBox.dock.top,
    `composer.bottom=${noBorderBox.composer.bottom} dock.top=${noBorderBox.dock.top}`,
  )
  check(
    'and the column still does not overflow the frame',
    noBorderBox.center.bottom === noBorderBox.innerHeight,
    `center.bottom=${noBorderBox.center.bottom} window=${noBorderBox.innerHeight}`,
  )

  const failed = checks.filter(([, ok]) => !ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  edge.kill()
}
