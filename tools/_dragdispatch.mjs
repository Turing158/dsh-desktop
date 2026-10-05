/**
 * TEMPORARY: dispatch a real drag into the live page over CDP, and read back what
 * the page made of it.
 *
 * ## Why not a synthetic DragEvent
 *
 * `new DragEvent('drop')` cannot carry files. `DataTransfer.items` is read-only and
 * `DataTransfer.files` is always empty for a constructed one, so DSH's own guard
 * discards it before doing anything:

 *     const dt = event.dataTransfer;
 *     if (dt === null || !dt.types.includes("Files")) return null;   // synthetic dies here
 *
 * That tests the page's listener wiring and nothing else — and the wiring is not
 * what is in question.
 *
 * ## What this does instead
 *
 * `Input.dispatchDragEvent` hands the drag to the **browser's own drag controller**,
 * the same component a real OS drag is routed through, with a `DragData` that names
 * real files. The page then sees a `DataTransfer` whose `types` contains `Files` and
 * whose `files` are populated — measured, not assumed; the read-out prints both, so a
 * run where the payload came through empty is visible as such rather than being
 * mistaken for a pass.
 *
 * ## What it can and cannot prove
 *
 * It answers "does a drag that reaches Chromium become a DOM drag event in this
 * page", which is exactly the question `SetAllowExternalDrop(false)` decides. It does
 * **not** exercise the Windows OLE registration that precedes Chromium — that half is
 * read from the sources instead (see `tools/_externaldrop.ps1` for the attempt at a
 * full OLE drag, and the README for why it is not the instrument that settled this).
 *
 * Usage:
 *
 *   node tools/_dragdispatch.mjs            # dispatch, then report
 *   node tools/_dragdispatch.mjs --settle   # report only (after a manual drag)
 *
 * `CDP_PORT` overrides the port.
 */

const PORT = process.env.CDP_PORT ?? '9222'
const settleOnly = process.argv.includes('--settle')

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error(`no page target on port ${PORT}`)
  process.exit(3)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Arm the page-side recorder.
 *
 * Installed in the **capture** phase so it sees an event even if the app stops its
 * propagation, and inert: it calls nothing and prevents nothing.
 */
const ARM = `
(() => {
  const TYPES = ['dragenter', 'dragover', 'dragleave', 'drop'];
  if (!window.__dshDropWatch) {
    const state = { counts: {}, last: {}, seen: [] };
    const record = (type) => (event) => {
      state.counts[type] = (state.counts[type] || 0) + 1;
      const dt = event.dataTransfer;
      state.last[type] = {
        types: dt ? Array.from(dt.types) : null,
        fileCount: dt && dt.files ? dt.files.length : null,
        fileName: dt && dt.files && dt.files.length ? dt.files[0].name : null,
        fileSize: dt && dt.files && dt.files.length ? dt.files[0].size : null,
        dropEffect: dt ? dt.dropEffect : null,
        defaultPrevented: event.defaultPrevented,
      };
      state.seen.push(type);
    };
    for (const type of TYPES) document.addEventListener(type, record(type), true);
    state.reset = () => { state.counts = {}; state.last = {}; state.seen = []; };
    window.__dshDropWatch = state;
  }
  window.__dshDropWatch.reset();
  // Where to aim: the middle of the app's own page, clear of the title bar.
  const r = document.body.getBoundingClientRect();
  return { armed: true, x: Math.round(r.width / 2), y: Math.round(r.height / 2) + 40 };
})()
`

/** What the page ended up with, after the drag. */
const READ = `
(() => {
  const state = window.__dshDropWatch;
  const text = (el) => (el && el.textContent ? el.textContent.trim() : null);

  // The drop overlay is found by its accessibility role — DropOverlay renders
  // role="status" on the mask — not by its CSS-module hash, which every DSH build
  // regenerates. It is rendered only while a drag is over the page, so a *present*
  // overlay after the drop means the enter/leave accounting never reset.
  const overlay = document.querySelector('[role="status"]');

  // Composer attachments: the rail's class is a per-build hash too, so the cards are
  // found through the labels the app itself renders.
  const rail = document.querySelector('[class*=_rail]');
  const cards = rail ? Array.from(rail.children).map((c) => (text(c) || '').slice(0, 40)) : [];

  return {
    counts: state ? state.counts : null,
    sequence: state ? state.seen : null,
    last: state ? state.last : null,
    overlayAfter: overlay ? { present: true, text: (text(overlay) || '').slice(0, 60) } : { present: false },
    composer: { railPresent: Boolean(rail), cards },
  };
})()
`

/**
 * Watch the overlay *during* the drag, in the page, so the interval where it is
 * supposed to be visible can be checked at all. A read-out taken after the drop
 * cannot see it — the overlay is unmounted by design when the drag leaves.
 *
 * IT HAS TO RESTART ON EVERY RUN, and the first version did not: it returned the
 * existing stop-function when one was already installed, so a second run in the same
 * page reported the *previous* run's samples and looked identical whether or not the
 * overlay had appeared. A stale pass is worse than no measurement, so the watcher is
 * stopped and replaced rather than reused.
 */
const WATCH_OVERLAY = `
(() => {
  if (typeof window.__dshOverlayStop === 'function') window.__dshOverlayStop();
  const samples = [];
  let wasPresent = false;
  const timer = setInterval(() => {
    const el = document.querySelector('[role="status"]');
    const present = el !== null;
    if (present) {
      samples.push({ at: Date.now(), text: (el.textContent || '').trim().slice(0, 60) });
      wasPresent = true;
    }
  }, 20);
  window.__dshOverlayStop = () => {
    clearInterval(timer);
    window.__dshOverlayResult = {
      samples: samples.length,
      appeared: wasPresent,
      first: samples[0] ?? null,
    };
    return window.__dshOverlayResult;
  };
  return { watching: true };
})()
`

const REPORT = `
(() => {
  // Stopping is what captures the result; on a page where arming failed this is
  // null rather than a stale object from an earlier run.
  const overlay = typeof window.__dshOverlayStop === 'function'
    ? window.__dshOverlayStop()
    : null;
  const state = window.__dshDropWatch;
  const text = (el) => (el && el.textContent ? el.textContent.trim() : null);
  const rail = document.querySelector('[class*=_rail]');
  return {
    counts: state ? state.counts : null,
    sequence: state ? state.seen : null,
    last: state ? state.last : null,
    overlayDuringDrag: overlay,
    composer: {
      railPresent: Boolean(rail),
      cards: rail ? Array.from(rail.children).map((c) => (text(c) || '').slice(0, 40)) : [],
    },
  };
})()
`

try {
  if (!settleOnly) {
    const armed = await evaluate(ARM)
    await evaluate(WATCH_OVERLAY)
    console.log(`aim        (${armed.x},${armed.y})`)

    // A real file, given by the caller, so the upload can actually complete. A path
    // that does not exist still exercises the drag (the page reads the name and size
    // off `dataTransfer.files`) but the upload then fails, which is a *different*
    // result and must not be confused with the drag not arriving.
    const files = process.env.DRAG_FILES
      ? process.env.DRAG_FILES.split(';').filter(Boolean)
      : ['C:\\\\Users\\\\TURING~1\\\\AppData\\\\Local\\\\Temp\\\\dsh-drag-probe.txt']
    console.log(`files      ${files.join(', ')}`)

    const data = {
      items: [],
      files,
      // The bitmask the OS would set for a copy-capable drag.
      dragOperationsMask: 1 | 2,
    }

    // Enter, then move, then release — in that order, so the page's enter/over
    // handling runs before the drop, exactly as a real drag drives it.
    await send('Input.dispatchDragEvent', { type: 'dragEnter', x: armed.x - 60, y: armed.y - 60, data })
    await sleep(120)
    await send('Input.dispatchDragEvent', { type: 'dragOver', x: armed.x, y: armed.y, data })
    await sleep(120)
    await send('Input.dispatchDragEvent', { type: 'dragOver', x: armed.x + 4, y: armed.y + 4, data })
    await sleep(120)
    await send('Input.dispatchDragEvent', { type: 'drop', x: armed.x, y: armed.y, data })
    await sleep(600)
  }

  console.log(JSON.stringify(await evaluate(REPORT), null, 1))
} finally {
  socket.close()
}
