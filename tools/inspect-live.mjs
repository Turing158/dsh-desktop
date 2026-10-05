/**
 * Measure the live app's layout invariants over CDP.
 *
 * ## Why this exists
 *
 * The title bar is chrome that floats over a page it does not own, and the app
 * underneath positions its own surfaces with `position: fixed`, `inset`, and
 * JavaScript-computed coordinates. That makes a whole class of bug invisible to
 * every other test in this repository:
 *
 *   - `theme.css` and `dom.js` are injected into a page no unit test renders;
 *   - the failures are *geometric* - a panel 20px too high, a menu 44px from its
 *     anchor - and a DOM stub has no layout engine to be wrong about;
 *   - the app's own stylesheets are injected at runtime, so whether a rule wins is
 *     a question about the live cascade.
 *
 * That is not hypothetical. This instrument is the only thing that found, in order:
 * the dialog scan looking at the wrong parent (the settings overlay is inside
 * `#root`), an `!important` added on a guess and measured to be unnecessary, a
 * blanket transform that displaced tooltips rendered inside dialogs, and a tag that
 * vanilla mode stripped so the offset vanished there.
 *
 * So this script attaches to a running app and reports what is actually on screen.
 * It asserts nothing: it prints measurements, and the README records which values
 * are correct and why. Read it as an instrument, not a test.
 *
 * ## Running it
 *
 * The webview must expose a debugger, which WebView2 only does when asked:
 *
 * ```powershell
 * $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
 * .\src-tauri\target\debug\deepseek-harness-desktop.exe
 * ```
 *
 * Then, in another shell:
 *
 * ```powershell
 * node tools/inspect-live.mjs
 * ```
 *
 * `CDP_PORT` overrides the port. Uses Node's global `WebSocket` (22+), so it needs
 * no dependency.
 */

const PORT = process.env.CDP_PORT ?? '9222'

/** The page this app serves its own UI and the DSH GUI from. */
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error(
    `no page target on port ${PORT}. Is the app running with\n` +
      `  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT} ?`,
  )
  process.exit(3)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

/** Send one CDP command and await its result. */
function send(method, params) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const slot = pending.get(message.id)
  if (!slot) return
  pending.delete(message.id)
  if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
  else slot.resolve(message.result)
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
  }
  return result.result.value
}

/**
 * The probe.
 *
 * Written as one self-contained async expression so it can drive the app through
 * several states - idle, settings open, a dropdown inside it, and the app's own
 * Modal - and report the geometry of each. Every number here maps to a specific
 * claim in the README's title-bar section.
 */
const probe = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = 44;
  const report = {};

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const bar = document.querySelector('.dshTb');
  report.bar = bar
    ? { parent: bar.parentElement.tagName, box: box(bar), zIndex: getComputedStyle(bar).zIndex }
    : { present: false };

  /**
   * Close whatever dialog or menu is open, so each step starts from a known state.
   *
   * Without this the steps interfere: the settings trigger is a TOGGLE, so a step
   * that assumed it was closed would instead close it, and the next step would
   * report the wrong surface under the right label. That happened - the modal step
   * reported the settings overlay.
   */
  const reset = async () => {
    for (let i = 0; i < 3; i += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
    }
    const closeButton = document.querySelector("[role=dialog] button");
    if (closeButton) closeButton.click();
    await sleep(250);
    const trigger = document.querySelector('button[aria-haspopup="dialog"]');
    if (trigger && document.querySelector('[class*=VOzbGW_overlay]')) {
      trigger.click();
      await sleep(400);
    }
    await sleep(150);
    return { settingsOpen: !!document.querySelector('[class*=VOzbGW_overlay]') };
  };

  // The container is the mechanism that reserves the bar's strip; the frame padding
  // below it is only a fallback, and is neutralised inside the container.
  const root = document.getElementById('root');
  const rootBox = root ? box(root) : null;
  const frame = document.querySelector("[data-dsh-chrome='frame']") || document.querySelector('[class*=_frame]');
  report.container = root
    ? {
        box: rootBox,
        position: getComputedStyle(root).position,
        height: getComputedStyle(root).height,
        // A fixed box with top AND bottom set but a specified height ignores the
        // bottom inset, which is how a missing height:auto overflows by one bar.
        overflowsWindow: rootBox.top + rootBox.h > window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      }
    : null;
  report.frame = frame
    ? {
        paddingTop: getComputedStyle(frame).paddingTop,
        sidebarTop: box(frame.querySelector('[class*=_sidebarCol]')).top,
      }
    : null;

  /**
   * Fixed or absolutely-positioned elements whose box reaches into the bar's strip.
   * The bar itself is excluded; anything here painted ABOVE the bar would be a
   * genuine occlusion.
   */
  const stripIntruders = () => {
    const found = [];
    for (const el of document.querySelectorAll('body *')) {
      if (bar && bar.contains(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.top < H && r.bottom > 0) {
        found.push({ cls: String(el.className).slice(0, 32) || el.tagName, top: Math.round(r.top), z: cs.zIndex });
      }
    }
    return found;
  };
  report.idleStripIntruders = stripIntruders();

  // 1. The settings dialog - the surface the occlusion bug was reported on.
  await reset();
  const trigger = document.querySelector('button[aria-haspopup="dialog"]');
  if (trigger) {
    trigger.click();
    await sleep(800);
    const tagged = document.querySelector("[class*=VOzbGW_overlay]");
    if (tagged) {
      const panel = tagged.querySelector('[role=dialog]');
      // The panel's own header row. These are what the user saw cut off, so they are
      // measured directly rather than inferred from the panel's box. The title is not
      // an h2 element - the settings shell puts it in a nav cell - so the close
      // button is the reliable anchor.
      const close = panel ? panel.querySelector('button') : null;
      report.settings = {
        // Which layer was found, so the numbers below are self-describing: a selector
        // that quietly matched a different surface would otherwise look like a pass.
        cls: String(tagged.className).slice(0, 32),
        chromeTag: tagged.getAttribute('data-dsh-chrome'),
        overlayTag: tagged.getAttribute('data-dsh-desktop'),
        computedTop: getComputedStyle(tagged).top,
        transform: getComputedStyle(tagged).transform,
        panelTop: panel ? box(panel).top : null,
        panelClearsBar: panel ? box(panel).top >= H : null,
        closeTop: close ? box(close).top : null,
        closeClearsBar: close ? box(close).top >= H : null,
      };

      // 2. A dropdown inside the dialog. Menus are positioned from REAL viewport
      //    coordinates, so a containing-block change would displace them from their
      //    anchor - the failure mode the rules had to avoid.
      const combo = tagged.querySelector('[aria-haspopup]');
      if (combo) {
        const anchor = box(combo);
        combo.click();
        await sleep(500);
        const menu = document.querySelector('[role="menu"]');
        if (menu) {
          const m = box(menu);
          report.dialogMenu = {
            gapBelowAnchor: m.top - (anchor.top + anchor.h),
            anchored: Math.abs(m.top - (anchor.top + anchor.h)) < 12,
            chromeTag: menu.getAttribute('data-dsh-chrome'),
          };
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(300);
        } else {
          report.dialogMenu = { opened: false };
        }
      }
    } else {
      report.settings = { opened: false };
    }
  }

  // 3. The app's own Modal primitive, reached through the title bar's 项目 menu, so
  //    both dialog code paths are covered. Reset first: the settings trigger is a
  //    toggle, and a panel left open here is what an earlier version of this script
  //    mislabelled as the modal.
  report.stateBeforeModal = await reset();
  const projectItem = [...document.querySelectorAll('.dshTb__item')].find((b) => b.textContent.trim() === '项目');
  if (projectItem) {
    projectItem.click();
    await sleep(400);
    const del = [...document.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent.includes('删除项目'));
    if (del) {
      del.click();
      await sleep(700);
      // The app's Modal root is the only chrome-tagged layer whose class is not the
      // settings overlay's.
      const modal = [...document.querySelectorAll("[data-dsh-chrome='layer']")].find(
        (el) => !el.className.includes('VOzbGW'),
      );
      if (modal) {
        const dialog = modal.querySelector('[role=dialog]');
        report.modalDialog = {
          cls: String(modal.className).slice(0, 32),
          parentIsBody: modal.parentElement === document.body,
          dialogTop: dialog ? box(dialog).top : null,
          clearsBar: dialog ? box(dialog).top >= H : null,
        };
      } else {
        report.modalDialog = {
          opened: false,
          taggedLayers: [...document.querySelectorAll("[data-dsh-chrome='layer']")].map((e) =>
            String(e.className).slice(0, 30),
          ),
        };
      }
      await reset();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      report.modalDialog = { itemFound: false };
    }
  }

  await sleep(400);
  report.finalStripIntruders = stripIntruders();
  report.ok = true;
  return report;
})()
`

try {
  const report = await evaluate(probe)
  console.log(JSON.stringify(report, null, 1))
} finally {
  socket.close()
}
