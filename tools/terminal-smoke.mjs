/**
 * Drives the right column's 终端 entry in a REAL DSH page over CDP.
 *
 * ## Why this instrument exists
 *
 * The plugin's two promises are about the LIVE column, and neither is decidable
 * from the source alone:
 *
 *   1. **The entry is drawn by the app's own guide**, once, after the existing
 *      options — which depends on the shipped guide reading the registry this
 *      plugin contributes to.
 *   2. **The terminal lands in the tab the entry was picked from**, and a SECOND
 *      pick opens a second terminal rather than jumping to the first — which
 *      depends on the layout store's real dedup rule for pages, the reason the
 *      body adopts an address of its own.
 *
 * Both are read off the DOM the app actually painted.
 *
 * ## Running it
 *
 * The webview must expose a debugger, and the app must be a throwaway instance:
 *
 * ```powershell
 * $env:DSH_HOME = '<temp>\\dsh-home'
 * $env:DSH_DESKTOP_SMOKE_DIR = '<temp>'
 * $env:DSH_DESKTOP_WEBVIEW_RESTORE = '1'
 * $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9338'
 * .\src-tauri\target\debug\deepseek-harness-desktop.exe
 * ```
 *
 * Then `CDP_PORT=9338 node tools/terminal-smoke.mjs`.
 *
 * Uses Node's global WebSocket (22+), so it needs no dependency.
 */

const PORT = process.env.CDP_PORT ?? '9338'

/**
 * Which page to drive.
 *
 * On the WEBVIEW the DSH page is the only real target, so the first page wins. In
 * a browser there is also the browser's own chrome (an Edge profile that has just
 * been created opens a sync prompt), and attaching to THAT would report a column
 * that "never mounted" while the page under test sat in the next target. So a
 * matcher is honoured when one is given.
 */
const MATCH = process.env.CDP_MATCH ?? ''

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
const page = pages.find((t) => t.url.includes(MATCH)) ?? pages[0]
if (!page) {
  console.error(`no page target on port ${PORT}`)
  process.exit(3)
}
console.error(`[terminal-smoke] attached to ${page.url}`)

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
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
  }
  return result.result.value
}

/**
 * The probe: every step the acceptance list names, in the page's own terms.
 *
 * Written as one self-contained async expression so it drives the column through
 * the states in order — guide, one terminal, a second guide, two terminals — and
 * reports what the DOM held at each.
 */
const probe = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = { steps: [], errors: [] };

  const tabs = () =>
    [...document.querySelectorAll('[data-dockkit-tab]')].map((el) => ({
      id: el.getAttribute('data-dockkit-tab'),
      title: (el.querySelector('[data-dockkit-tab-title]') || el).textContent.trim(),
      // The strip marks the active tab with aria-selected (and tabIndex: 0).
      // There is no data-dockkit-tab-active attribute — reading one reports
      // every tab as inactive, which looks like a pass and proves nothing.
      active: el.getAttribute('aria-selected') === 'true',
    }));

  /** Click a tab the way a pointer does, and let the strip settle. */
  const selectTab = async (title) => {
    const el = [...document.querySelectorAll('[data-dockkit-tab]')]
      .find((tab) => (tab.querySelector('[data-dockkit-tab-title]') || tab).textContent.trim() === title);
    if (!el) return false;
    el.click();
    await sleep(600);
    return true;
  };

  /** What the column is showing in its body right now. */
  const bodyState = () => ({
    terminals: terminals().length,
    unavailable: document.querySelectorAll('[data-sidebar-right-unavailable]').length,
    text: (document.querySelector('[data-sidebar-right-panel]')?.innerText || '')
      .replace(/\\s+/g, ' ')
      .slice(0, 160),
  });

  const guideEntries = () =>
    [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map((el) => ({
      kind: el.getAttribute('data-sidebar-right-guide-entry'),
      title: el.textContent.trim(),
    }));

  const terminals = () =>
    [...document.querySelectorAll('.dshTerminal')].map((el) => ({
      text: el.textContent.replace(/\\s+/g, ' ').trim(),
      status: el.querySelector('[data-dsh-terminal-status]')?.textContent.trim() ?? null,
      content: el.querySelector('[data-dsh-terminal-content]')?.getAttribute('data-dsh-terminal-content') ?? null,
      inputs: el.querySelectorAll('input, textarea, form, [contenteditable=true]').length,
    }));

  const step = (name, extra) => report.steps.push({ name, ...extra });

  /**
   * Put a guide on screen, whichever way this column currently allows.
   *
   * TWO THINGS MAKE THIS NON-OBVIOUS, both measured:
   *
   *   1. The strip's "+" control is rendered only while canAddTab holds — and the
   *      column defines that as "this pane holds NO guide". So once a guide exists,
   *      the button is gone, and clicking it can never be the way back to one.
   *   2. A docked pane mounts only its ACTIVE tab's body, so a guide that exists but
   *      is not selected has no DOM at all: the guide selector reads 0 while the
   *      guide is sitting right there in the strip.
   *
   * Together those mean "no guide on screen" and "no guide in the pane" are
   * different states, and only the second one is served by "+". So an existing
   * guide TAB is activated when there is one, and "+" is the fallback.
   *
   * @returns whether a guide body is on screen.
   */
  const ensureGuide = async () => {
    const onScreen = () => document.querySelectorAll('[data-sidebar-right-guide]').length > 0;
    const guideTab = () =>
      [...document.querySelectorAll('[data-dockkit-tab]')].find((el) =>
        ['开始', 'Start'].includes((el.querySelector('[data-dockkit-tab-title]') || el).textContent.trim()),
      );
    for (let i = 0; i < 6 && !onScreen(); i += 1) {
      const tab = guideTab();
      if (tab) tab.click();
      else document.querySelector('[data-dockkit-add-tab]')?.click();
      await sleep(700);
    }
    return onScreen();
  };

  /** The 终端 capsule on the guide page, or null. */
  const terminalCapsule = () =>
    [...document.querySelectorAll('[data-sidebar-right-guide-entry]')]
      .find((el) => el.getAttribute('data-sidebar-right-guide-entry') === 'desktop-terminal') ?? null;

  /**
   * Clear the first-run API-key prompt, which covers the window until it is
   * answered. 稍后配置 is its "decide later" button; a page already past it has
   * no such button and this is then a no-op.
   */
  const dismissOnboarding = async () => {
    const later = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '稍后配置');
    if (!later) return false;
    later.click();
    await sleep(800);
    return true;
  };

  try {
    step('onboarding', { dismissed: await dismissOnboarding() });

    // ── open the column ──────────────────────────────────────────────────────
    const panel = document.querySelector('[data-sidebar-right-panel]');
    if (!panel) { report.errors.push('the right column never mounted'); return report; }
    if (panel.getAttribute('data-sidebar-right-open') === null) {
      document.querySelector('[data-sidebar-right-expand]')?.click();
      await sleep(600);
    }
    step('column-open', { open: panel.getAttribute('data-sidebar-right-open') !== null });

    // ── the guide, and the entry on it ───────────────────────────────────────
    await ensureGuide();
    const first = guideEntries();
    step('guide', { count: first.length, entries: first });

    const terminalEntry = terminalCapsule();
    step('entry', { matches: terminalEntry ? 1 : 0, title: terminalEntry?.textContent.trim() ?? null });

    // ── the entry matches the capsules beside it ────────────────────────────
    //
    // MEASURED, NOT ASSUMED, because "the app draws it" is the claim and the app is
    // the only thing that can settle it. The capsule is the same button element with
    // the same class, so the things that could still differ are the ones the entry
    // itself controls: the GLYPH's box, and the capsule's height (which depends on
    // whether a description is shown — the guide drops descriptions past four
    // entries, so a guide over that limit draws a shorter capsule for everyone).
    const capsules = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map((el) => {
      const box = el.getBoundingClientRect();
      const svg = el.querySelector('svg');
      const svgBox = svg ? svg.getBoundingClientRect() : null;
      return {
        kind: el.getAttribute('data-sidebar-right-guide-entry'),
        tag: el.tagName,
        height: Math.round(box.height),
        width: Math.round(box.width),
        radius: getComputedStyle(el).borderRadius,
        fontSize: getComputedStyle(el).fontSize,
        padding: getComputedStyle(el).padding,
        glyph: svgBox ? [Math.round(svgBox.width), Math.round(svgBox.height)] : null,
        glyphViewBox: svg ? svg.getAttribute('viewBox') : null,
        glyphStroke: svg ? getComputedStyle(svg).stroke : null,
      };
    });
    const shapeOf = (capsule) => (capsule ? JSON.stringify([capsule.height, capsule.width, capsule.radius, capsule.fontSize, capsule.padding]) : null);
    step('entry-styling', {
      capsules,
      sameCapsuleShape: new Set(capsules.map(shapeOf)).size === 1,
      sameGlyphBox: new Set(capsules.map((c) => JSON.stringify(c.glyph))).size === 1,
      glyphsPresent: capsules.every((c) => c.glyph !== null),
    });

    // ── the FIRST pick: it must take the guide's own slot ────────────────────
    const before = tabs();
    const guideIndex = before.findIndex((tab) => tab.title === '开始' || tab.title === 'Start');
    terminalEntry?.click();
    await sleep(700);
    const afterFirst = tabs();
    step('first-pick', {
      before,
      after: afterFirst,
      count: afterFirst.length,
      guideIndex,
      landedAtGuideIndex: afterFirst[guideIndex]?.title ?? null,
      terminals: terminals(),
    });

    // ── a second guide, then a SECOND pick ──────────────────────────────────
    await ensureGuide();
    const withGuide = tabs();
    const second = terminalCapsule();
    second?.click();
    await sleep(700);
    const afterSecond = tabs();
    step('second-pick', {
      withGuide,
      after: afterSecond,
      count: afterSecond.length,
      terminalTabs: afterSecond.filter((tab) => tab.title === '终端').length,
      terminals: terminals().length,
    });

    // ── 原版 withdraws the entry ────────────────────────────────────────────
    //
    // A GUIDE IS PUT BACK FOR THIS, and that is the whole point of the step. The two
    // terminals replaced the guides they were picked from, so reading "the entries
    // on screen" after them reports an empty list for the wrong reason — no guide
    // exists to draw any entry — which would pass while proving nothing.
    await ensureGuide();
    const desktopEntries = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')]
      .map((el) => el.getAttribute('data-sidebar-right-guide-entry'));
    step('desktop-guide', { entries: desktopEntries });

    document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode', { detail: { mode: 'vanilla' } }));
    await sleep(700);
    // The guide is REPLACED, not re-rendered in place, when its entries change —
    // so the tab still on screen can be a stale one. Put a guide back and read again.
    await ensureGuide();
    const vanillaEntries = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')]
      .map((el) => el.getAttribute('data-sidebar-right-guide-entry'));
    step('vanilla', {
      mode: document.documentElement.getAttribute('data-dsh-ui'),
      // Read from the DOM the app painted, not from the registry: the question is
      // what the user can SEE on the guide page.
      entriesOnScreen: vanillaEntries,
      terminalEntryOnScreen: vanillaEntries.filter((kind) => kind === 'desktop-terminal').length,
      terminalsOnScreen: terminals().length,
      tabTitles: tabs().map((tab) => tab.title),
    });

    document.dispatchEvent(new CustomEvent('dsh-desktop:set-ui-mode', { detail: { mode: 'desktop' } }));
    await sleep(700);
    document.querySelector('[data-dockkit-add-tab]')?.click();
    await sleep(700);
    const backEntries = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')]
      .map((el) => el.getAttribute('data-sidebar-right-guide-entry'));
    step('back-to-desktop', {
      mode: document.documentElement.getAttribute('data-dsh-ui'),
      entries: backEntries,
      terminalEntries: backEntries.filter((kind) => kind === 'desktop-terminal').length,
      terminalsOnScreen: terminals().length,
    });

    // ── a terminal SURVIVES the round trip ──────────────────────────────────
    //
    // The tab record is the session store's, not this plugin's, so 原版 cannot take
    // it away — and that makes the return path worth measuring rather than assuming:
    // if the body did not come back on re-registration, the tab would render the
    // column's "nothing can view this" notice, which is a real user-visible outcome
    // and not an acceptable one.
    const survived = await selectTab('终端');
    step('terminal-after-round-trip', {
      selected: survived,
      ...bodyState(),
      tabIds: tabs().map((tab) => tab.id + (tab.active ? '*' : '')),
    });

    // Console errors are the one signal a DOM read cannot carry: a failed
    // registration would surface as a broken boot, and a plugin bug as a slot error.
    report.slotErrors = [...document.querySelectorAll('[data-slot-error]')].map((el) => el.outerHTML.slice(0, 200));

    // ── the panel: collapse and expand, close and reopen ────────────────────
    //
    // Geometry, not just presence: the failure this surface could cause is a
    // Layout that spills out of its pane or pushes the conversation, and a
    // screenshot is not a measurement.
    const overflow = () => {
      const panel = document.querySelector('[data-sidebar-right-panel]');
      const surface = document.querySelector('.dshTerminal');
      if (!panel || !surface) return null;
      const p = panel.getBoundingClientRect();
      const s = surface.getBoundingClientRect();
      const chat = document.querySelector('[data-conversation-scroll]');
      return {
        surfaceSpillsPanel: s.right > p.right + 1 || s.bottom > p.bottom + 1 || s.left < p.left - 1,
        surfaceSize: [Math.round(s.width), Math.round(s.height)],
        panelSize: [Math.round(p.width), Math.round(p.height)],
        docScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
        chatVisible: chat ? chat.getBoundingClientRect().width > 0 : null,
        viewport: [window.innerWidth, window.innerHeight],
      };
    };
    step('geometry-wide', { ...overflow() });

    // Collapse the column, then bring it back.
    //
    // THE TOGGLE IS THE ONLY RELIABLE CONTROL, and that is measured, not assumed:
    // data-sidebar-right-toggle is the panel's own collapse/expand button and is
    // present in BOTH states, while data-sidebar-right-expand lives in the
    // conversation header's corner and is absent in this window (a probe found 0 of
    // them in every state, with the toggle at 1 throughout). So the toggle is
    // pressed and the resulting state is read back, rather than assuming which
    // direction one press moves it.
    const openNow = () => {
      const el = document.querySelector('[data-sidebar-right-panel]');
      return el ? el.getAttribute('data-sidebar-right-open') !== null : null;
    };
    const pressToggle = async () => {
      document.querySelector('[data-sidebar-right-toggle]')?.click();
      await sleep(800);
      return openNow();
    };

    const wasOpen = openNow();
    if (wasOpen === true) {
      const collapsedTo = await pressToggle();
      step('collapsed', { wasOpen, open: collapsedTo, terminalsStillMounted: terminals().length });
      const expandedTo = await pressToggle();
      step('re-expanded', { open: expandedTo, ...bodyState() });
    } else {
      // Already collapsed by an earlier step: expand, then run the pair properly.
      const expandedFirst = await pressToggle();
      step('collapsed', { wasOpen: false, open: expandedFirst, note: 'expanded first, then collapsed' });
      const collapsedTo = await pressToggle();
      step('re-expanded', { open: collapsedTo, ...bodyState() });
    }

    // ── close the terminal's tab, then open a fresh one from the guide ─────
    const closeButton = [...document.querySelectorAll('[data-dockkit-tab]')]
      .filter((el) => (el.querySelector('[data-dockkit-tab-title]') || el).textContent.trim() === '终端')
      .map((el) => el.querySelector('[data-dockkit-tab-close]'))
      .find(Boolean);
    const beforeClose = tabs().length;
    closeButton?.click();
    await sleep(800);
    const afterClose = tabs().length;

    // Re-open a guide (the column may hold none) and pick the entry again.
    await ensureGuide();
    const offeredAgain = terminalCapsule();
    offeredAgain?.click();
    await sleep(800);
    step('close-and-reopen', {
      beforeClose,
      afterClose,
      afterReopen: tabs().length,
      entriesOfferedAgain: offeredAgain ? 1 : 0,
      ...bodyState(),
    });

    // ── keyboard activation ────────────────────────────────────────────────
    //
    // Driven as REAL key events over CDP (Input.dispatchKeyEvent), not synthetic
    // KeyboardEvents: a synthetic keydown never triggers a focused button's default
    // activation, so dispatching one and then calling click() would test click()
    // twice and prove nothing about the keyboard.
    await ensureGuide();
    const entryForKeys = terminalCapsule();
    window.__DSH_SMOKE_ENTRY__ = entryForKeys ?? null
    report.keyboardEntry = entryForKeys
      ? { tag: entryForKeys.tagName, type: entryForKeys.getAttribute('type') }
      : null;

    // ── a NARROW column, in both palettes ─────────────────────────────────
    //
    // The surface must survive the column's own width changing under it, and the
    // state must not depend on colour alone. The dark palette is keyed on the
    // body's data-ds-dark-theme attribute, which the theme plugin owns, so it is
    // toggled here by attribute exactly as the app does.
    //
    // The keyboard step above left a GUIDE selected, and a docked pane mounts only
    // its active tab's body — so a terminal tab is selected first, or these two
    // steps would measure an absent surface and report nulls that read like a
    // failure of the styling rather than of the setup.
    await selectTab('终端');
    const panelForWidth = document.querySelector('[data-sidebar-right-panel]');
    const widthBefore = panelForWidth ? panelForWidth.getBoundingClientRect().width : null;
    step('geometry-before-narrow', { width: widthBefore === null ? null : Math.round(widthBefore) });
    if (panelForWidth) panelForWidth.style.width = '220px';
    await sleep(500);
    step('geometry-narrow', { ...overflow() });
    if (panelForWidth) panelForWidth.style.removeProperty('width');
    await sleep(400);

    const palette = [];
    for (const dark of [false, true]) {
      if (dark) document.body.setAttribute('data-ds-dark-theme', '')
      else document.body.removeAttribute('data-ds-dark-theme')
      await sleep(400)
      const surface = document.querySelector('.dshTerminal')
      // The live surface carries a message row only when something went wrong, so
      // every read here is guarded: the status line is the always-present signal.
      const message = surface?.querySelector('.dshTerminal__message') ?? null
      palette.push({
        dark,
        status: surface?.querySelector('[data-dsh-terminal-status]')?.textContent.trim() ?? null,
        // The state must be readable as TEXT; a colour-only signal would still pass
        // a computed-style check while being invisible to a colour-blind reader.
        message: message?.textContent.trim() ?? null,
        ink: message ? getComputedStyle(message).color : null,
        fills: surface ? getComputedStyle(surface).backgroundColor : null,
      })
    }
    step('palettes', { palette });
    document.body.removeAttribute('data-ds-dark-theme')

    report.ok = true;
  } catch (error) {
    report.errors.push(String(error && error.stack ? error.stack : error));
  }
  return report;
})()
`

/**
 * Reload the page and wait for the app to mount again.
 *
 * WHY EVERY RUN STARTS HERE. The probe changes state that outlives it — terminals
 * opened, guides replaced, tabs closed — and a second run against the leftovers
 * measures the leftovers, not the plugin. Measured: run 1 reported two terminals at
 * the second pick, run 2 reported two terminals BEFORE any pick. A reload is the
 * only reset that costs nothing to trust.
 *
 * @returns whether the column came back.
 */
async function resetPage() {
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: false })
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const ready = await evaluate(
        `Boolean(document.querySelector('[data-sidebar-right-panel]') && document.getElementById('root'))`,
      )
      if (ready) return true
    } catch {
      // The execution context is replaced during a navigation; keep polling.
    }
  }
  return false
}

/** The one-time first-run prompt, which covers the window until it is answered. */
async function dismissOnboardingFromOutside() {
  try {
    return await evaluate(`(() => {
      const later = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '稍后配置');
      if (!later) return false;
      later.click();
      return true;
    })()`)
  } catch {
    return false
  }
}

try {
  const reloaded = await resetPage()
  await new Promise((r) => setTimeout(r, 1500))
  const dismissed = await dismissOnboardingFromOutside()

  const report = await evaluate(probe)
  report.reset = { reloaded, onboardingDismissed: dismissed }

  /**
   * The keyboard step, driven over CDP because it cannot be driven from inside.
   *
   * `Input.dispatchKeyEvent` is the browser's own input pipeline, so the Enter that
   * arrives is the Enter a keyboard sends: the button receives focus, presses, and
   * activates through its DEFAULT action. A synthetic `KeyboardEvent` dispatched in
   * the page never triggers that default, so an in-page version of this step could
   * only ever have tested `click()` a second time.
   *
   * THE ENTRY IS FOUND HERE, not carried out of the probe. Everything the probe does
   * after the guide (collapse, close, narrow, palettes) can unmount a guide, and a
   * node captured before that is detached by the time the key arrives — measured: the
   * handle existed, `focus()` did nothing, and `activeElement` stayed on `<body>`.
   */
  try {
    /** Put a guide on screen and hand back a LIVE 终端 capsule. */
    const findEntry = () =>
      evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const onScreen = () => document.querySelectorAll('[data-sidebar-right-guide]').length > 0;
        const guideTab = () => [...document.querySelectorAll('[data-dockkit-tab]')]
          .find((el) => ['开始', 'Start'].includes((el.querySelector('[data-dockkit-tab-title]') || el).textContent.trim()));
        for (let i = 0; i < 6 && !onScreen(); i += 1) {
          const tab = guideTab();
          if (tab) tab.click(); else document.querySelector('[data-dockkit-add-tab]')?.click();
          await sleep(700);
        }
        const el = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')]
          .find((n) => n.getAttribute('data-sidebar-right-guide-entry') === 'desktop-terminal');
        if (!el) return null;
        el.focus();
        return {
          focused: document.activeElement === el,
          connected: el.isConnected,
          tabs: document.querySelectorAll('[data-dockkit-tab]').length,
        };
      })()`)

    const entry = await findEntry()

    if (entry && entry.focused && entry.connected) {
      /**
       * One real key press through the browser's own input pipeline.
       *
       * BOTH key-event forms are issued, because they are not interchangeable and the
       * difference was measured rather than guessed: `rawKeyDown` (the pre-character
       * event) and `keyDown` (carrying text). Enter activates the capsule under EITHER
       * form — verified twice, each replacing the guide tab with a 终端 tab. Space
       * activates under NEITHER, which is this button's real behaviour in this browser
       * and is recorded as such rather than papered over: a `<button>` activates on
       * Space through the browser's own key handling, and the app's capsule is an
       * ordinary `<button type="button">`, so there is nothing here for the plugin to
       * fix — its entry is the app's control, activated by the app's own browser.
       */
      const press = async (keyName, code, vk) => {
        const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
        const text = keyName === 'Enter' ? '\r' : keyName === 'Space' ? ' ' : undefined
        for (const type of ['rawKeyDown', 'keyDown']) {
          if (type === 'rawKeyDown') await send('Input.dispatchKeyEvent', { type, ...base })
          else await send('Input.dispatchKeyEvent', { type, text, unmodifiedText: text, ...base })
        }
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
        await new Promise((r) => setTimeout(r, 900))
        return evaluate(`(() => ({
          tabs: document.querySelectorAll('[data-dockkit-tab]').length,
          titles: [...document.querySelectorAll('[data-dockkit-tab]')]
            .map((el) => (el.querySelector('[data-dockkit-tab-title]') || el).textContent.trim()),
          terminals: document.querySelectorAll('.dshTerminal').length,
          unavailable: document.querySelectorAll('[data-sidebar-right-unavailable]').length,
        }))()`)
      }

      const titlesBefore = await evaluate(`[...document.querySelectorAll('[data-dockkit-tab]')]
        .map((el) => (el.querySelector('[data-dockkit-tab-title]') || el).textContent.trim())`)
      const tabsBefore = entry.tabs
      const afterEnter = await press('Enter', 'Enter', 13)

      // Space is the button's OTHER activation key. It is pressed on a fresh guide
      // when Enter already consumed the one that was focused.
      let afterSpace = null
      if (afterEnter.tabs === tabsBefore && afterEnter.terminals === 0) {
        const refocused = await findEntry()
        if (refocused && refocused.focused) {
          const spaceBefore = await evaluate(`[...document.querySelectorAll('[data-dockkit-tab]')]
            .map((el) => (el.querySelector('[data-dockkit-tab-title]') || el).textContent.trim())`)
          afterSpace = { titlesBefore: spaceBefore, before: refocused.tabs, ...(await press('Space', 'Space', 32)) }
        }
      }

      report.steps.push({
        name: 'keyboard-activation',
        focusedByScript: entry.focused,
        tabsBefore,
        titlesBefore,
        afterEnter,
        afterSpace,
      })
    } else {
      report.steps.push({ name: 'keyboard-activation', reached: false, detail: entry })
    }
  } catch (error) {
    report.steps.push({ name: 'keyboard-activation', error: String(error).slice(0, 200) })
  }

  console.log(JSON.stringify(report, null, 1))
} finally {
  socket.close()
}
