/**
 * Guards the 原版 (vanilla) switch — the title bar's 更多 → 切换成原版 item.
 *
 * ## What is actually at risk
 *
 * The switch spans four files that cannot import each other:
 *
 *   title-bar/client.js       offers the menu item and asks for a mode
 *   ui-client/client.js       persists it and owns `data-dsh-ui` on <html>
 *   ui-overlay/theme.css      gates sections 1–8 on that attribute
 *   ui-overlay/dom.js         withdraws the DOM half and cleans up its tags
 *
 * `dom.js` is a classic script injected into the page and `client.js` files are
 * hand-authored bundles, so none of them can be imported and exercised directly
 * by a test. The contract between them is therefore *names*: an attribute, two of
 * its values, and two event names. A typo in any one of them fails silently and
 * asymmetrically — the menu item toggles nothing, or the stylesheet keeps
 * applying while the DOM tier withdraws — which is exactly the class of bug a
 * reader cannot see and a user cannot diagnose.
 *
 * So this test asserts the contract as text, and separately proves the two things
 * that can be executed for real: the settings schema (rehydrated through the
 * genuine Schemastery constructor) and the CSS gate's structure.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** The four files the switch spans, by role. */
const FILES = {
  titleBar: join(here, 'title-bar', 'client.js'),
  appearance: join(here, 'ui-client', 'client.js'),
  host: join(here, 'ui-client', 'index.js'),
  overlay: join(here, 'desktop-ui.mjs'),
  css: join(here, 'ui-overlay', 'theme.css'),
  dom: join(here, 'ui-overlay', 'dom.js'),
}

/** The names every file must agree on. */
const MODE_ATTRIBUTE = 'data-dsh-ui'
const VANILLA = 'vanilla'
const DESKTOP = 'desktop'
const REQUEST_EVENT = 'dsh-desktop:set-ui-mode'
const CHANGE_EVENT = 'dsh-desktop:ui-mode'

/** Read one of {@link FILES}. */
const read = (key) => readFileSync(FILES[key], 'utf8')

/**
 * Locate the real Schemastery package the DSH installation ships.
 *
 * Skipped rather than failed when DSH is absent: like the Cordis test beside
 * this one, the assertion needs the genuine implementation to mean anything.
 *
 * @returns the module namespace, or null.
 */
function loadSchemastery() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const candidates = [
    join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(appData, '.dsh', 'profiles', 'node_modules'),
  ]
  for (const base of candidates) {
    const entry = join(base, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
    if (!existsSync(entry)) continue
    const require = createRequire(join(base, 'noop.js'))
    try {
      return require('@deepseek-ai/schemastery')
    } catch {
      /* try the next root */
    }
  }
  return null
}

// ── the attribute and its two values ─────────────────────────────────────────

test('every file in the switch agrees on the attribute and both mode names', () => {
  const writers = {
    'title-bar/client.js': read('titleBar'),
    'ui-client/client.js': read('appearance'),
    'desktop-ui.mjs': read('overlay'),
    'ui-overlay/dom.js': read('dom'),
  }

  for (const [name, source] of Object.entries(writers)) {
    assert.ok(
      source.includes(MODE_ATTRIBUTE),
      `${name} must name the mode attribute ${MODE_ATTRIBUTE}`,
    )
    assert.ok(
      source.includes(VANILLA),
      `${name} must know the ${VANILLA} mode name`,
    )
  }

  // The CSS gate is the one that cannot hold a string constant, so it is checked
  // separately: if it spells the attribute differently the overlay never turns
  // off, and nothing else in this test would notice.
  const css = read('css')
  assert.ok(
    css.includes(`[${MODE_ATTRIBUTE}='${VANILLA}']`),
    `theme.css must gate on [${MODE_ATTRIBUTE}='${VANILLA}']`,
  )
})

test('the two control events are spelled identically on both sides', () => {
  const titleBar = read('titleBar')
  const appearance = read('appearance')
  const dom = read('dom')

  // Both events are declared as constants in each file, so the test reads the
  // constants rather than searching for bare strings: that is what makes a
  // rename in one file fail here instead of silently at runtime.
  for (const [name, source] of [
    ['title-bar/client.js', titleBar],
    ['ui-client/client.js', appearance],
  ]) {
    assert.ok(source.includes(REQUEST_EVENT), `${name} must name the request event`)
    assert.ok(source.includes(CHANGE_EVENT), `${name} must name the change event`)
  }

  // The DOM tier has no constants to share — it is a classic script with no
  // module surface — so its listener is pinned to the literal name.
  assert.ok(
    dom.includes(`addEventListener('${CHANGE_EVENT}'`),
    `dom.js must listen for ${CHANGE_EVENT}`,
  )
})

test('the title bar offers the toggle and asks rather than writing', () => {
  const titleBar = read('titleBar')

  // The label the user sees, in both directions.
  assert.ok(titleBar.includes('切换成原版'), 'the item must read 切换成原版 in the new styles')
  assert.ok(titleBar.includes('切换新样式'), 'the item must read 切换新样式 in 原版')

  // It must not write the attribute itself: the appearance plugin owns the
  // persisted setting, and two writers is how the two drift apart.
  assert.ok(
    !new RegExp(`setAttribute\\(\\s*MODE_ATTRIBUTE`).test(titleBar),
    'the bar must not set the mode attribute directly; it requests a change',
  )
  assert.ok(titleBar.includes('requestUiMode'), 'the bar must request the mode change')
})

// ── the settings schema, executed ────────────────────────────────────────────

test('the appearance schema resolves both modes, defaults, and rejects on validate', async () => {
  const module = await import('./ui-client/index.js')

  assert.deepEqual(
    module.SettingsSchema({}),
    { animation: 'system', ui: 'desktop', titlebar: 'full', titlebarHover: 'on' },
    'defaults must apply to every field',
  )
  assert.deepEqual(
    module.SettingsSchema({ ui: 'vanilla' }),
    { animation: 'system', ui: 'vanilla', titlebar: 'full', titlebarHover: 'on' },
    'an explicit vanilla must survive with the other defaults applied',
  )

  // RESOLVE IS FORGIVING, VALIDATE IS STRICT, and the split is load-bearing.
  // `resolve()` runs this function at registration, over whatever the settings
  // document already holds; throwing there would fail `settings.register` and
  // take the whole settings describe down with it. So an unknown value degrades
  // to the default on the read path...
  assert.deepEqual(
    module.SettingsSchema({ ui: 'bogus' }),
    { animation: 'system', ui: 'desktop', titlebar: 'full', titlebarHover: 'on' },
    'an unknown mode must degrade to the default rather than failing registration',
  )
  assert.deepEqual(module.SettingsSchema({ ui: null }), {
    animation: 'system',
    ui: 'desktop',
    titlebar: 'full',
    titlebarHover: 'on',
  })
  assert.deepEqual(
    module.SettingsSchema({ titlebar: 'bogus', titlebarHover: 'maybe' }),
    { animation: 'system', ui: 'desktop', titlebar: 'full', titlebarHover: 'on' },
    'an unknown title-bar field must degrade the same way',
  )

  // ...while a WRITE is judged strictly, which is what the settings form uses.
  assert.equal(module.normalize({ ui: 'bogus' }), undefined, 'normalize must reject an unknown mode')
  assert.equal(module.normalize({ ui: null }), undefined, 'normalize must reject a null mode')
  assert.equal(
    module.normalize({ titlebar: 'bogus' }),
    undefined,
    'normalize must reject an unknown title-bar mode',
  )
  assert.equal(
    module.normalize({ titlebarHover: 'maybe' }),
    undefined,
    'normalize must reject an unknown hover preference',
  )

  const verdict = module.SettingsSchema['~standard'].validate({ ui: 'bogus' })
  assert.ok(verdict.issues, '~standard must report the rejection')
  assert.deepEqual(verdict.issues[0].path, ['ui'], 'the issue must name the ui field')
  assert.deepEqual(
    module.SettingsSchema['~standard'].validate({ titlebar: 'simple' }),
    { value: { animation: 'system', ui: 'desktop', titlebar: 'simple', titlebarHover: 'on' } },
    'an explicit simple mode must survive with the other defaults applied',
  )
  assert.deepEqual(
    module.SettingsSchema['~standard'].validate({ ui: 'vanilla' }),
    { value: { animation: 'system', ui: 'vanilla', titlebar: 'full', titlebarHover: 'on' } },
  )
})

test('the hand-written envelope rehydrates and validates like a compiled schema', async (t) => {
  const z = loadSchemastery()
  if (z === null) {
    t.skip('DSH installation not found; cannot load @deepseek-ai/schemastery')
    return
  }

  const module = await import('./ui-client/index.js')

  // The real constructor, over the transcribed envelope. `describe()` does this
  // for every registered namespace, so a malformed graph breaks the whole
  // settings UI rather than one field.
  const Schema = z.default ?? z
  const rehydrated = new Schema(module.SCHEMA_ENVELOPE)

  assert.deepEqual(rehydrated({}), {
    animation: 'system',
    ui: 'desktop',
    titlebar: 'full',
    titlebarHover: 'on',
  })
  assert.deepEqual(rehydrated({ animation: 'off', ui: 'vanilla', titlebar: 'simple' }), {
    animation: 'off',
    ui: 'vanilla',
    titlebar: 'simple',
    titlebarHover: 'on',
  })

  // The font-size override is optional in the same sense: an absent field is
  // dropped rather than defaulted (no override is the documented state), and a
  // present one must be one of the out-of-bounds sizes the browser half can
  // apply itself. The in-range sizes 12..17 never appear here — the theme
  // runtime owns those, and writing one to this document would be a second
  // owner for one value.
  assert.deepEqual(rehydrated({ animation: 'on', fontSizeOverride: 10 }), {
    animation: 'on',
    ui: 'desktop',
    titlebar: 'full',
    titlebarHover: 'on',
    fontSizeOverride: 10,
  })
  assert.throws(() => rehydrated({ fontSizeOverride: 15 }), /fontSizeOverride/)

  // Invalid values must be rejected by BOTH implementations. The envelope is
  // what the settings form validates against, while the callable schema is what
  // the host resolves with — and the two must disagree in exactly one place
  // (resolve forgiving, validate strict), never about which values are legal.
  assert.throws(() => rehydrated({ ui: 'bogus' }), /ui/)
  assert.throws(() => rehydrated({ animation: 'nope' }), /animation/)
  assert.throws(() => rehydrated({ titlebar: 'bogus' }), /titlebar/)
  assert.throws(() => rehydrated({ titlebarHover: 'maybe' }), /titlebarHover/)
  assert.equal(module.normalize({ ui: 'bogus' }), undefined)
  assert.equal(module.normalize({ animation: 'nope' }), undefined)
  assert.equal(module.normalize({ titlebar: 'bogus' }), undefined)
  assert.equal(module.normalize({ titlebarHover: 'maybe' }), undefined)
  assert.equal(module.normalize({ fontSizeOverride: 15 }), undefined)
  assert.equal(module.normalize({ fontSizeOverride: '10' }), undefined)
  // `null` reads as "no override" in both implementations — the envelope passes
  // it through, so the callable schema must accept it too, or the two would
  // disagree about which values are legal.
  assert.deepEqual(module.normalize({ animation: 'on', fontSizeOverride: null }), {
    animation: 'on',
    ui: 'desktop',
    titlebar: 'full',
    titlebarHover: 'on',
  })

  assert.equal(rehydrated({ backgroundTransparency: 50 }).backgroundTransparency, 50)
  assert.equal(rehydrated({ backgroundNavigationSurfaceTransparency: 60 }).backgroundNavigationSurfaceTransparency, 60)
  assert.equal(rehydrated({ backgroundNavigation: false }).backgroundNavigation, false)
  assert.equal(rehydrated({ backgroundLeft: false }).backgroundLeft, false)
  assert.throws(() => rehydrated({ backgroundTransparency: 101 }), /backgroundTransparency/)
  assert.throws(() => rehydrated({ backgroundNavigationSurfaceTransparency: 101 }), /backgroundNavigationSurfaceTransparency/)
  assert.throws(() => rehydrated({ backgroundNavigation: 'false' }), /backgroundNavigation/)

  for (const composerMaterial of ['glass', 'frosted', 'transparent', 'opaque']) {
    const value = { composerMaterial }
    assert.deepEqual(rehydrated(value), module.normalize(value))
    assert.equal(module.SettingsSchema(value).composerMaterial, composerMaterial)
  }
  assert.throws(() => rehydrated({ composerMaterial: 'unknown' }), /composerMaterial/)
  assert.equal(module.normalize({ composerMaterial: 'unknown' }), undefined)
  assert.deepEqual(module.SettingsSchema['~standard'].validate({ composerMaterial: 'unknown' }).issues[0].path, ['composerMaterial'])
  for (const reasoningControl of ['select', 'slider']) {
    assert.deepEqual(rehydrated({ reasoningControl }), module.normalize({ reasoningControl }))
  }
  assert.throws(() => rehydrated({ reasoningControl: 'high' }), /reasoningControl/)
  assert.equal(module.normalize({ reasoningControl: 'high' }), undefined)
  assert.deepEqual(module.SettingsSchema['~standard'].validate({ reasoningControl: 'high' }).issues[0].path, ['reasoningControl'])
  for (const colorScheme of ['default', 'blue', 'teal', 'moss', 'violet', 'amber', 'rose']) {
    assert.deepEqual(rehydrated({ colorScheme }), module.normalize({ colorScheme }))
  }
  for (const colorScheme of ['unknown', 2]) {
    assert.throws(() => rehydrated({ colorScheme }), /colorScheme/)
    assert.deepEqual(module.SettingsSchema['~standard'].validate({ colorScheme }).issues[0].path, ['colorScheme'])
  }
  for (const dialogMaterial of ['glass', 'frosted', 'transparent', 'opaque']) {
    const value = { dialogMaterial, composerMaterial: 'opaque' }
    assert.deepEqual(rehydrated(value), module.normalize(value))
    assert.equal(module.SettingsSchema(value).dialogMaterial, dialogMaterial)
  }
  assert.throws(() => rehydrated({ dialogMaterial: 'unknown' }), /dialogMaterial/)
  assert.equal(module.normalize({ dialogMaterial: 'unknown' }), undefined)
  assert.deepEqual(module.SettingsSchema['~standard'].validate({ dialogMaterial: 'unknown' }).issues[0].path, ['dialogMaterial'])
  for (const field of ['composerTransparency', 'composerFrostedIntensity', 'composerGlassIntensity', 'dialogTransparency', 'dialogFrostedIntensity', 'dialogGlassIntensity']) {
    for (const level of [0, 25.5, 50, 100]) {
      const value = { [field]: level }
      assert.deepEqual(rehydrated(value), module.normalize(value))
      assert.equal(module.SettingsSchema(value)[field], level)
    }
    for (const level of [-1, 101, Infinity, '50']) {
      assert.throws(() => rehydrated({ [field]: level }), new RegExp(field))
      assert.equal(module.normalize({ [field]: level }), undefined)
      assert.deepEqual(module.SettingsSchema['~standard'].validate({ [field]: level }).issues[0].path, [field])
    }
    assert.equal(module.normalize({ [field]: NaN }), undefined)
    assert.equal(module.normalize({})[field], undefined, 'old settings remain unchanged')
  }

  // And every field the module normalizes must exist in the envelope, or the
  // settings form would render a field the host cannot resolve.
  const fields = Object.keys(module.SCHEMA_ENVELOPE.refs[module.SCHEMA_ENVELOPE.uid].dict)
  assert.deepEqual(fields.sort(), [
    'animation',
    'backgroundBlur', 'backgroundChat', 'backgroundChatSurfaceTransparency', 'backgroundChatTransparency', 'backgroundImage',
    'backgroundLeft', 'backgroundLeftSurfaceTransparency', 'backgroundLeftTransparency', 'backgroundNavigation', 'backgroundNavigationSurfaceTransparency', 'backgroundRight', 'backgroundRightSurfaceTransparency', 'backgroundRightTransparency',
    'backgroundTitlebar', 'backgroundTitlebarSurfaceTransparency', 'backgroundTitlebarTransparency', 'backgroundTransparency',
    'colorScheme',
    'composerFrostedIntensity', 'composerGlassIntensity', 'composerMaterial', 'composerTransparency',
    'dialogFrostedIntensity', 'dialogGlassIntensity', 'dialogMaterial', 'dialogTransparency',
    'fontSizeOverride',
    'reasoningControl',
    'titlebar',
    'titlebarHover',
    'ui',
  ])
})

// ── the CSS gate, structurally ───────────────────────────────────────────────

test('theme.css gates the overlay rules but never the title bar', () => {
  const css = read('css')

  // The bar must stay live: the window is decorations(false), so without it
  // there is no window control and no way back to the new styles.
  const barStart = css.indexOf('9. desktop title bar')
  assert.ok(barStart > 0, 'the section 9 banner must exist')

  const before = css.slice(0, barStart)
  const after = css.slice(barStart)

  const gate = `html:not([${MODE_ATTRIBUTE}='${VANILLA}'])`
  const gatedBefore = before.split(gate).length - 1
  const gatedAfter = after.split(gate).length - 1

  assert.ok(gatedBefore > 50, `sections 1–8 must be gated (found ${gatedBefore})`)
  assert.equal(gatedAfter, 0, 'section 9 must never be gated, or 原版 traps the user')

  // The rules that reserve the bar's space and style the bar must still match in
  // 原版 — asserted by their selectors, since "ungated" is only meaningful for the
  // rules that actually lay the window out. The container is the one that matters
  // now; the frame anchors below it are a fallback.
  assert.ok(
    after.includes('html body #root {'),
    'the container must stay ungated so the bar keeps its space in 原版',
  )
  assert.ok(
    after.includes('html body [data-rightbar-collapsed]'),
    'and so must the fallback frame anchor',
  )

  // A gated `@keyframes` would be meaningless, and a stray gate inside a
  // declaration would break the rule it sits in. Neither should exist.
  assert.ok(!/@keyframes[^{]*\n?[^{]*\{?[^}]*\n\s*html:not\(/.test(after))
})

test('the CSS gate raises specificity, so it cannot lose to the app stylesheet', () => {
  const css = read('css')

  // WHY THIS IS A REAL RISK. The overlay is injected in <head>, but the app
  // injects its own palette at RUNTIME — later in source order. With equal
  // specificity the app wins and the overlay is silently ignored, which is why
  // section 1 uses `html body` rather than `body`. The gate adds an attribute
  // selector to that compound, so it must be a strict superset, never a
  // replacement: a rule gated down to bare `html` would lose exactly the fight
  // the comment warns about.
  const gated = css.match(/^html:not\(\[data-dsh-ui='vanilla'\]\)\s*body\b/gm) ?? []
  assert.ok(gated.length > 20, `expected the gate to sit before body (found ${gated.length})`)

  // No rule may be gated without also selecting `body` where it previously did.
  const bareGatedHtml = css.match(/^html:not\(\[data-dsh-ui='vanilla'\]\)\s*\{/gm) ?? []
  assert.equal(bareGatedHtml.length, 0, 'a gated rule must not drop its body selector')
})

test('the ungrouped plus-button removal targets only the direct-child button', () => {
  const css = read('css')

  // THE MECHANISM. The bucket's new-session button is a dead affordance — the
  // app's own `onCreate` guards `workspaceId !== void 0` and does nothing — so
  // section 7b hides it. The selector must stay NARROW: the row's "…" menu
  // button (a real workspace's) sits nested inside the Menu primitive's wrapper
  // span, so only the direct-child combinator names the "+" without matching
  // path data or a locale-dependent aria-label. Searching for the combinator
  // here is the assertion: drop the `>` and the selector this test finds no
  // longer exists, which fails loudly instead of hiding the wrong button.
  const at = css.indexOf("[data-dsh-desktop='ungrouped'] [class*='_rowActions'] > button {")
  assert.ok(at > 0, 'the removal rule must exist and key on the ungrouped tag')

  const rule = css.slice(at, css.indexOf('}', at))
  assert.ok(
    /display:\s*none/.test(rule),
    'the button must leave layout, hover, tab order, and the accessibility tree',
  )

  // Gated, like the rest of section 7b: 原版 must keep the app's own row.
  const selector = css.slice(css.lastIndexOf('*/', at) + 2, at)
  assert.ok(
    /html:not\(\[data-dsh-ui='vanilla'\]\)/.test(selector),
    'the removal must be gated, or 原版 loses the "+" too',
  )
})

// ── the container is the mechanism; the frame anchors are a fallback ─────────

test('the frame anchors are kept as a fallback, not as the mechanism', () => {
  const css = read('css')
  const dom = read('dom')

  // WHY THEY STILL EXIST. The container rule on `#root` is what reserves the bar's
  // space now. These anchors only matter if that rule stops matching — a future DSH
  // that mounts somewhere else, or a page where `#root` is absent — so they are a
  // fallback rather than dead code.
  //
  // THE BUG THEY WERE ORIGINALLY WRITTEN FOR is worth keeping in view, because it
  // explains why there are three. The rule first keyed on `[data-rightbar-collapsed]`
  // alone:
  //
  //     "data-rightbar-collapsed": cols.rightbar === 0 || void 0
  //
  // and React OMITS an attribute whose value is `void 0` — so the frame carried it
  // only while the right panel was COLLAPSED. Expanding the panel dropped the
  // frame's padding and every column slid up under the opaque bar.
  assert.ok(
    css.includes('html body :has(> [data-shell-overlay])'),
    'the frame must still be found by its own overlay layer',
  )
  assert.ok(
    css.includes('html body [data-rightbar-collapsed]'),
    'and by the original conditional anchor, as a last resort',
  )

  // The DOM tier must still tag the frame, or the tagged fallback is dead code.
  assert.ok(
    dom.includes("setAttribute(CHROME_ATTRIBUTE, 'frame')"),
    'dom.js must tag the frame',
  )

  // It must derive the frame from the overlay layer — written as the literal `true`
  // — and not from the conditional attribute.
  const decorate = dom.slice(dom.indexOf('function decorateFrame'), dom.indexOf('function pass'))
  assert.ok(
    decorate.includes('[data-shell-overlay]'),
    'decorateFrame must find the frame via its overlay layer',
  )
  assert.ok(
    !decorate.includes('data-rightbar-collapsed'),
    'decorateFrame must not key on the conditional rightbar attribute',
  )

  // And the frame must NOT be padded while the container is doing the job: both
  // offsets at once would apply the bar's height twice. The neutraliser wins on
  // specificity (it adds #root to the same compound), not on order.
  assert.ok(
    css.includes('html body #root :has(> [data-shell-overlay])'),
    'the frame padding must be neutralised inside the container',
  )
  assert.ok(
    css.includes('html body #root [data-rightbar-collapsed]'),
    'and so must the conditional anchor',
  )
})

test('each frame fallback is its own rule, so an unparsed selector cannot kill them all', () => {
  const css = read('css')

  // A selector the engine cannot parse invalidates the ENTIRE rule it appears in.
  // Combined into one selector list, a browser without `:has()` would discard the
  // whole thing — including the fallbacks written for it.
  for (const anchor of ['[data-rightbar-collapsed]', ':has(> [data-shell-overlay])']) {
    const at = css.indexOf(`html body ${anchor}`)
    assert.ok(at > 0, `expected a rule for html body ${anchor}`)
    // The characters between this selector and its own `{` must not contain a
    // comma, which would mean it shares a rule with another anchor.
    const open = css.indexOf('{', at)
    const between = css.slice(at, open)
    assert.ok(
      !between.includes(','),
      `html body ${anchor} must stand alone, not be comma-joined to another anchor`,
    )
  }

  // The container itself must be its own rule too, and must not be comma-joined to
  // a fallback: if `:has()` invalidated the container rule, 原版 would lose the
  // offset entirely.
  const containerAt = css.indexOf('html body #root {')
  assert.ok(containerAt > 0, 'the container must be its own rule')
  assert.ok(
    !css.slice(containerAt, css.indexOf('{', containerAt)).includes(','),
    'the container must stand alone',
  )
})

// ── the DOM tier cleans up ───────────────────────────────────────────────────

test('the DOM tier withdraws every attribute it adds, and stops tagging', () => {
  const dom = read('dom')

  // Every attribute the overlay writes must appear in the cleanup list, or 原版
  // leaves a project modification on the page.
  for (const attribute of ['data-dsh-desktop', 'data-dsh-relocated', 'data-dsh-danger']) {
    assert.ok(dom.includes(attribute), `dom.js must know ${attribute}`)
  }

  const clear = dom.slice(dom.indexOf('function clearDecorations'), dom.indexOf('function markReady'))
  for (const attribute of ['data-dsh-desktop', 'data-dsh-relocated', 'data-dsh-danger']) {
    assert.ok(
      clear.includes(`removeAttribute('${attribute}')`),
      `clearDecorations must remove ${attribute}`,
    )
  }

  // The MutationObserver is the one path that tags nodes BETWEEN passes, so it
  // must stand down too: otherwise a re-render re-adds a tag moments after
  // cleanup removed it.
  const observer = dom.slice(dom.indexOf('function watchRelocatedRows'), dom.indexOf('function pass'))
  assert.ok(
    observer.includes('isVanilla()'),
    'the MutationObserver must skip tagging in 原版',
  )

  // The right-click takeover suppresses the native menu, which is itself a
  // modification, so it must return early rather than preventDefault.
  const handler = dom.slice(dom.indexOf('function onContextMenu'), dom.indexOf('function closeOpenMenu'))
  const guardAt = handler.indexOf('isVanilla()')
  const preventAt = handler.indexOf('preventDefault')
  assert.ok(guardAt >= 0 && preventAt > guardAt, 'the right-click guard must precede preventDefault')
})

// ── the sidebar's header, and the control that replaces it ───────────────────

test('the sidebar header is hidden in the overlay and restored in 原版', () => {
  const css = read('css')
  const dom = read('dom')

  // THE REQUEST THIS RULE IMPLEMENTS. The sidebar's own header holds the app mark,
  // the wordmark, and the 收起侧边栏 button. In this window the bar directly above
  // already carries the mark, so the row is redundant — and it is removed, which is
  // also what takes the button out of the sidebar.
  //
  // The rule is keyed on the CSS module's LOCAL name (`hHd-Xa_logoRow`), because the
  // hash prefix is regenerated on every DSH build while the local name is not — the
  // same reasoning `_sidebarCol` and `_projectRow` already follow elsewhere in this
  // project.
  const at = css.indexOf("html:not([data-dsh-ui='vanilla']) body [class*='_sidebarCol'] [class*='_logoRow']")
  assert.ok(at > 0, 'the sidebar header removal rule must exist')
  const selector = css.slice(at, css.indexOf('{', at))
  const rule = css.slice(at, css.indexOf('}', at))
  assert.ok(/display:\s*none/.test(rule), 'the row must leave layout, not merely be hidden')

  // Scoped under the LEFT COLUMN. A bare `[class*='_logoRow']` would match any
  // package that happens to use the same local name.
  assert.ok(
    selector.includes("[class*='_sidebarCol']"),
    'the rule must be scoped to the sidebar column, not left as a bare fragment',
  )

  // GATED, like everything in sections 1–8: 原版 is the unmodified frontend, so the
  // row — and with it the app's own collapse button — comes back there. The bar's
  // control stays ungated (section 9), so the two coexist rather than the sidebar
  // becoming inoperable in a mode whose bar still draws the control.
  assert.ok(
    selector.includes("html:not([data-dsh-ui='vanilla'])"),
    'the removal must be gated, or 原版 loses the app’s own sidebar header',
  )

  // The row is the app's, so React owns it: the overlay hides it and never removes
  // the node. This is the same reconciliation rule the ungrouped bucket's "+" and
  // its folder glyph follow, and it is asserted the same way — the DOM tier must
  // not be deleting the app's header.
  assert.ok(
    !/_logoRow'\]'\)/.test(dom) && !/removeChild[\s\S]{0,60}_logoRow/.test(dom),
    'the DOM tier must not delete the app’s node; the stylesheet hides it',
  )

  // NOTE what is deliberately NOT asserted: that the removal is achieved by hiding
  // the row's button alone. Hiding the whole row is the point — the mark and the
  // wordmark in it are the duplication being removed — so the rule is asserted on
  // the ROW, and the button leaves with it.
})

test('the bar’s sidebar control survives 原版', () => {
  const css = read('css')

  // Section 9 is ungated by design: the window is `decorations(false)`, so the bar
  // exists in both modes and must keep working in both. That now matters more than
  // it did — the bar carries the sidebar's collapse control, so gating this rule
  // would leave 原版 with a bar that names a control it does not draw.
  const at = css.indexOf('.dshTb__mark {')
  assert.ok(at > 0, 'the bar’s mark control must be styled')
  const rule = css.slice(at, css.indexOf('}', at))
  assert.ok(!rule.includes('data-dsh-ui'), 'the mark control must hold in 原版 too')

  // And the hover reveal that makes it readable is ungated for the same reason.
  const hoverAt = css.indexOf('.dshTb__mark:hover .dshTb__markPanel')
  assert.ok(hoverAt > 0, 'the hover reveal must exist')
  assert.ok(
    !css.slice(hoverAt, css.indexOf('}', hoverAt)).includes('data-dsh-ui'),
    'and must hold in 原版, or the control looks inert there',
  )
})

test('the mark reveals the panel glyph with an animated cross-fade', () => {
  const css = read('css')
  const titleBar = read('titleBar')

  // THE MECHANISM, AND WHY IT IS THE APP'S OWN. The sidebar toggle in the app's
  // collapsed rail shows the mark and swaps it for the panel glyph while the
  // pointer is over it (`_collapsed _toggle:hover _railMark`/`_panelIcon`). The
  // bar's control reproduces that idiom, so a user who has seen the rail already
  // knows what the mark does.
  //
  // THE SWAP IS A CROSS-FADE, NOT A `display` FLIP, and this is the assertion that
  // keeps it one: a `display: none` glyph cannot be transitioned — opacity is not
  // animatable while the element is out of the tree — so the two glyphs must STACK
  // and the hover state must move `opacity`. Reverting either to `display` would
  // silently turn the animation back into a flicker, which is exactly the class of
  // regression this test exists for.
  for (const [selector, verdict] of [
    ['.dshTb__mark:hover .dshTb__markLogo', 0],
    ['.dshTb__mark:hover .dshTb__markPanel', 1],
  ]) {
    const at = css.indexOf(selector)
    assert.ok(at > 0, `the hover rule ${selector} must exist`)
    const rule = css.slice(at, css.indexOf('}', at))
    assert.ok(
      new RegExp(`opacity:\\s*${verdict}`).test(rule),
      `${selector} must resolve to opacity: ${verdict}`,
    )
    assert.ok(
      !/display:/.test(rule),
      `${selector} must not flip display, which would make the swap un-animatable`,
    )
  }

  // The transition itself, on both glyphs, so the change interpolates in either
  // direction rather than animating only on the way in.
  const glyphAt = css.indexOf('.dshTb__markLogo,\n.dshTb__markPanel {')
  assert.ok(glyphAt > 0, 'the two glyphs must share a rule')
  const glyphRule = css.slice(glyphAt, css.indexOf('}', glyphAt))
  assert.ok(
    /transition:\s*opacity\s+\d+ms/.test(glyphRule),
    'both glyphs must transition opacity, or the swap snaps one way',
  )

  // They must STACK in one grid cell: without that, the two glyphs would sit side
  // by side and the box would double in width on hover.
  assert.ok(/grid-area:\s*1\s*\/\s*1/.test(glyphRule), 'the glyphs must stack in one cell')
  const markRule = css.slice(css.indexOf('.dshTb__mark {'), css.indexOf('}', css.indexOf('.dshTb__mark {')))
  assert.ok(/display:\s*inline-grid/.test(markRule), 'the mark must be the grid that stacks them')

  // Both glyphs must be in the TREE from the start, and the stylesheet must be what
  // chooses between them. A swap driven by React state would depend on a render
  // landing before the pointer left again; rendering both is also what keeps the
  // control usable for a keyboard user, who never hovers.
  assert.ok(
    titleBar.includes("className: 'dshTb__markLogo'") && titleBar.includes("className: 'dshTb__markPanel'"),
    'both glyphs must be rendered, not swapped in by the component',
  )

  // The panel glyph is the app's own icon — the same one its toggle uses — taken
  // from the primitives module like every other icon in the bar. The bar
  // resolves each icon across DSH's naming generations (0.2 renamed the icon
  // exports), so the assertion checks the resolver call.
  assert.ok(
    titleBar.includes("iconOrMissing('IconPanelLeftOutline16', 'IconPanelLeftOutlineRegular')"),
    'the panel glyph must be the app’s own panel icon, not a lookalike',
  )

  // The keyboard gets the same reveal, or a tabbing user is looking at a control
  // that never says what it is.
  assert.ok(
    css.includes('.dshTb__mark:focus-visible .dshTb__markPanel'),
    'keyboard focus must reveal the panel glyph too',
  )
})

test('the bar drives the app’s layout service rather than clicking a hidden button', () => {
  const titleBar = read('titleBar')

  // THE CONTRACT THE RULE ABOVE CREATES. The sidebar's button is hidden, so the
  // bar's control must reach the same action: `ctx.layout.toggleSidebar()`, which
  // is what `ui-sidebar`'s own `injectProps` calls. Clicking the hidden node would
  // work today and break the moment the app renames a class or moves the button —
  // and the node is `display: none`, so it is not even a stable handle.
  assert.ok(
    /var inject = \[[^\]]*'layout'[^\]]*\]/.test(titleBar),
    'the bar must declare the layout service, or the call is gated off at runtime',
  )
  assert.ok(
    /ctx\.layout/.test(titleBar) && /layout\.toggleSidebar\(\)/.test(titleBar),
    'the action must call the layout service’s toggleSidebar',
  )

  // It must NOT synthesize a click on the app's button.
  assert.ok(
    !/\.click\(\)[\s\S]{0,80}sidebar/i.test(titleBar) && !/sidebar[\s\S]{0,80}\.click\(\)/i.test(titleBar),
    'the bar must not click the app’s hidden collapse button',
  )

  // Guarded like every other cross-boundary call in this file: a build whose layout
  // service does not answer the method must leave the bar inert, never throw.
  const at = titleBar.indexOf('function toggleSidebar()')
  assert.ok(at > 0, 'toggleSidebar must exist')
  const body = titleBar.slice(at, titleBar.indexOf('\n      }', at))
  assert.ok(
    body.includes("typeof layout.toggleSidebar !== 'function'"),
    'the call must be guarded: a missing method must not throw during a click',
  )
  assert.ok(body.includes('catch'), 'and a throwing service must be contained')
})

test('the composer’s tool buttons and the 外观 controls animate their hover', () => {
  const css = read('css')
  const appearance = read('appearance')

  // THE HOVERS THIS COVERS, and why each needs a rule of its own rather than
  // riding section 6's blanket `body button` transition:
  //
  //   1. the composer's "+" and paperclip — plain buttons, but the app writes
  //      their hover as `_add:hover:not(:disabled)` at class level, so the pair is
  //      named by the row they live in (`_tools`, unique to the conversation
  //      package) rather than by `_add` alone, which two other packages also use;
  //   2. the 外观 section's option buttons and font-size select — rendered by THIS
  //      project's plugin with INLINE styles, which beat any non-flagged
  //      stylesheet rule. That is why the plugin writes class names of its own,
  //      and why those names are asserted here rather than assumed.
  const composerAt = css.indexOf("body [class*='_tools'] [class*='_add'] {")
  assert.ok(composerAt > 0, 'the composer tool buttons must have their own transition rule')
  const composerRule = css.slice(composerAt, css.indexOf('}', composerAt))
  assert.ok(
    /transition:[\s\S]*background-color/.test(composerRule),
    'the composer buttons must interpolate their background, which is the hover feedback',
  )
  // The composer's "+" and paperclip are BACKGROUND-ONLY. They used to scale to
  // 1.08 on hover; that is removed, so `transform` must not appear in either the
  // base rule's transition list or the hover rule. The desktop theme supplies
  // the hover fill; these checks preserve its interpolation and disabled guard.
  assert.ok(
    !/transform/.test(composerRule),
    'the composer buttons must not transform: their hover is a background change only',
  )
  const composerHoverAt = css.indexOf(
    "body [class*='_tools'] [class*='_add']:hover:not(:disabled)",
  )
  assert.ok(composerHoverAt > 0, 'the composer hover rule must exist')
  const composerHoverRule = css.slice(composerHoverAt, css.indexOf('}', composerHoverAt))
  assert.ok(
    !/transform/.test(composerHoverRule) && !/scale\(/.test(composerHoverRule),
    'the composer buttons must not scale or translate on hover',
  )

  // Scoped to the composer's own row. `_add` appears in two other packages, so the
  // bare fragment would restyle buttons this project never looked at.
  assert.ok(
    css.slice(composerAt, css.indexOf('{', composerAt)).includes("[class*='_tools']"),
    'the composer rule must be scoped to the tools row, not left as a bare `_add`',
  )

  // The 外观 section's own controls. The plugin must WRITE the classes the
  // stylesheet keys on — a rule with no matching class name is dead text.
  for (const [cls, where] of [
    ['dshAppearance__option', 'the option buttons'],
    ['dshAppearance__selector', 'the font-size selector'],
  ]) {
    assert.ok(appearance.includes(cls), `the plugin must write ${cls} on ${where}`)
    assert.ok(css.includes(`.${cls}`), `theme.css must style .${cls}, or the hook is dead`)
  }
  assert.ok(appearance.includes('dshAppearance'), 'the section must carry its own scope class')

  // The plugin styles the controls inline, and an inline declaration outranks any
  // non-flagged rule — so the stylesheet's hover fill must be flagged, or it
  // would lose the cascade and the control would show no hover feedback at all.
  const optionHoverAt = css.indexOf('.dshAppearance__option:hover')
  assert.ok(optionHoverAt > 0, 'the option hover rule must exist')
  const optionHoverRule = css.slice(optionHoverAt, css.indexOf('}', optionHoverAt))
  assert.ok(
    /!important/.test(optionHoverRule),
    'the option hover fill must be flagged to beat the plugin’s inline styles',
  )

  // The option buttons interpolate, and the SELECTED one keeps its own fill on
  // hover: losing the selection cue exactly when the pointer is over it is what
  // makes a segmented control unreadable.
  const optionAt = css.indexOf('.dshAppearance__option {')
  assert.ok(optionAt > 0, 'the option buttons must have a transition rule')
  assert.ok(
    /transition:/.test(css.slice(optionAt, css.indexOf('}', optionAt))),
    'and it must be a transition, not a static style',
  )
  assert.ok(
    optionHoverRule.includes(":not([aria-pressed='true'])"),
    'hover must exclude the selected option so its fill stays unchanged',
  )

  // The 外观 option buttons are BACKGROUND-ONLY TOO. They used to rise 1px on
  // hover; the rise is removed along with the composer's scale, so neither
  // `transform` nor `translate` may survive in the transition list or the hover
  // rule. Asserted in both places on purpose: a leftover entry in the transition
  // list is dead today but is exactly what lets the motion be "restored" by
  // re-adding a single declaration, which is the regression this guards.
  const optionTransition = css.slice(optionAt, css.indexOf('}', optionAt))
  assert.ok(
    !/transform/.test(optionTransition),
    'the option buttons must not list transform: their hover is a fill change only',
  )
  assert.ok(
    !/transform/.test(optionHoverRule) && !/translate/.test(optionHoverRule),
    'the option buttons must not move on hover',
  )
  assert.ok(
    !/scale\(/.test(optionHoverRule),
    'the option buttons must not scale on hover',
  )
  assert.ok(
    /background/.test(optionHoverRule),
    'the option hover must still change the background, which is the feedback',
  )
})

test('the font-size selector wears 通用设置’s own selector and opens its menu', () => {
  const appearance = read('appearance')
  const css = read('css')

  // THE CONTROL THIS GUARDS. The control used to be a compact rounded rectangle
  // (`border-radius: 12px`, a 0.5px border, `padding: 8px 12px`), which read as a
  // form field dropped into a settings section, and then a native `<select>` in
  // the app's pill shape — right look, wrong control: WebView2 matches
  // `:focus-visible` on a select even for a plain mouse click (the thick ring
  // every click drew), and the popup was the engine's list rather than the app's
  // menu. It is now the app's own selector outright: a pill `<button>` wrapped by
  // the `Menu` primitive, the pair 通用设置's rows render. The numbers below are
  // not invented: they are the rule that appears verbatim in
  // `dsh-client-ui-permission-presets`, `-locale`, `-theme` and `-chat` —
  //
  //   background:var(--dsw-alias-bg-module-platform);height:36px;border:none;
  //   border-radius:18px;padding:0 14px;font-size:14px;line-height:22px
  //
  // — which is what makes it the app's idiom rather than one row's private
  // styling. The terminal's shell picker asserts the same set for the same reason
  // (see `sidebar-terminal-render.test.mjs`).
  const at = appearance.indexOf("className: 'dshAppearance__selector'")
  assert.ok(at > 0, 'the plugin must still write the selector’s class, or theme.css has no hook')
  // Bounded at `var pill = h(`, which is what follows the shared style object: the
  // object itself closes with a `}` that a naive slice would stop at, and the keys
  // of interest sit inside it. The search starts at the ROW's own definition — the
  // style object is declared before the pill that wears it, so the class name is
  // not a usable origin.
  const rowAt = appearance.indexOf('function FontSizeRow(')
  assert.ok(rowAt > 0, 'the row component must exist to slice')
  const styleAt = appearance.indexOf('var pillStyle = {', rowAt)
  assert.ok(styleAt > rowAt, 'the selector must carry a shared inline style object')
  const style = appearance.slice(styleAt, appearance.indexOf('var pill = h(', styleAt))

  for (const [needle, why] of [
    ["height: '36px'", 'the app’s selector is 36px tall'],
    ["borderRadius: '18px'", 'and fully rounded: 36 / 2'],
    ["border: 'none'", 'the app’s selector has no border, unlike an input'],
    ["background: 'var(--dsw-alias-bg-module-platform)'", 'and sits on the module-platform fill'],
    ["fontSize: '14px'", 'at the app’s selector type size'],
    ["lineHeight: '22px'", 'with the matching line box'],
  ]) {
    assert.ok(style.includes(needle), `the pill must declare ${needle} — ${why}`)
  }

  // It must NOT keep the old form-field look, or the two styles fight: a 12px
  // radius inside an 18px pill and a hairline border on a control the app draws
  // borderless would both read as a mistake.
  assert.ok(
    !/borderRadius: '12px'/.test(style),
    'the old 12px form-field radius must be gone, not layered under the pill',
  )
  assert.ok(
    !/border: '0\.5px/.test(style),
    'the old hairline border must be gone: the app’s selector is borderless',
  )

  // `appearance: none` is for the DEGRADED path — the native `<select>` a page
  // without the primitives module falls back to — where the engine would
  // otherwise draw its own arrow and bevel INSIDE the pill, on top of the chevron
  // background image that stands in for the app's own.
  assert.ok(
    /appearance: 'none'/.test(style),
    'the native control chrome must be removed, or the engine’s arrow sits over the chevron',
  )
  assert.ok(
    /backgroundImage:/.test(style) && /backgroundPosition: 'right 14px center'/.test(style),
    'the chevron must be drawn back in as a background image, at the app’s own inset',
  )

  // THE ROW IS THE APP'S SETTING-CELL, not a stacked field. 通用设置 lays a
  // settings row out as one horizontal flex — title and note in a left text
  // column, the value selector on the right, a hairline under the row — and this
  // row must do the same, where it used to stack the selector under the text and
  // read as a form field between rows that keep their control to the right. The
  // text column carries `flex: 1` + `minWidth: 0`, which is what keeps the pill
  // intrinsic-width and right-placed (the old column layout needed an
  // `align-self` patch for the same job; that patch must not come back, because
  // in a row flex `flex-start` would pin the pill to the text column's baseline
  // rather than centre it).
  const rowStart = appearance.indexOf('return h(', rowAt)
  const rowLabel = appearance.indexOf("'字号大小'", rowStart)
  assert.ok(rowStart > rowAt && rowLabel > rowStart, 'the row must still be the font-size row to slice')
  const rowStyle = appearance.slice(rowStart, rowLabel)
  assert.ok(
    /alignItems: 'center'/.test(rowStyle),
    'the row must lay the selector beside the text, centred like a Setting-Cell',
  )
  assert.ok(
    /flex: 1, flexDirection: 'column', gap: '2px', minWidth: 0/.test(rowStyle),
    'the text column must take the remaining width without shoving the pill',
  )
  assert.ok(
    !/alignSelf: 'flex-start'/.test(style),
    'the column-era anti-stretch patch must be gone: the row flex centres the pill',
  )

  // THE POPUP IS THE APP'S MENU, not the engine's native list. The closed pill is
  // a `<button>` (which is what quiets the click ring: a select matches
  // `:focus-visible` on every click, a button only from the keyboard), the Menu
  // wraps it as its anchor, the current size rides `selectedId` so the Menu's own
  // check marks it, and the panel is portalled like every other dropdown.
  assert.ok(
    /h\(Menu, \{/.test(appearance),
    'the popup must be the Menu primitive, or the menu is still the engine’s own',
  )
  assert.ok(
    /selectedId: String\(value\)/.test(appearance) && /anchor: pill,/.test(appearance),
    'the current size must be the Menu’s selection, marked on the anchored pill',
  )
  assert.ok(
    /portal: true,/.test(appearance) && /align: 'start',/.test(appearance),
    'portalled and dropped from the pill’s left edge, like the app’s own selectors',
  )

  // THE FALLBACK SURVIVES. A page whose module table lacks the primitives seed
  // must still get a working control — the native `<select>` this used to be,
  // same pill, same values.
  assert.ok(
    appearance.includes("value: String(value),") && appearance.includes("props.onChange(Number(event.target.value))"),
    'the degraded path must still be the native select offering the same sizes',
  )

  // The hover must set `background-color`, never the `background` shorthand: a
  // shorthand resets every longhand it does not name, so it would erase the
  // inline chevron image the moment the pointer crossed the pill.
  const hoverAt = css.indexOf('.dshAppearance__selector:hover')
  assert.ok(hoverAt > 0, 'the selector hover rule must exist')
  const hoverRule = css.slice(hoverAt, css.indexOf('}', hoverAt))
  assert.ok(
    /background-color:/.test(hoverRule),
    'the selector hover must set background-color, so the chevron survives',
  )
  assert.ok(
    !/[^-]background:\s/.test(hoverRule.replace(/background-color:/g, '')),
    'the selector hover must not use the background shorthand, which would drop the chevron',
  )
  assert.ok(
    !/transform/.test(hoverRule) && !/translate/.test(hoverRule),
    'the selector is background-only like the option buttons',
  )
})

test('every new animation stands down with the animation preference', () => {
  const css = read('css')

  // THE CONTRACT THIS OVERLAY ALREADY HAS, extended to the animations added beside
  // it. The appearance setting offers 跟随系统 / 开启 / 关闭, and reduced motion is
  // the OS's own version of the same request — so each new animation must appear in
  // BOTH gates, for the same reason the ones before it do:
  //
  //   `:not([...='on'])` under the media query   — the OS asked, and the user did
  //                                                not override it
  //   `[...='off']` without a media query        — the user asked, whatever the OS
  //                                                reports
  //
  // A missing entry is SILENT: the animation simply keeps running for a user who
  // turned animation off, which is the one failure this setting exists to prevent.
  //
  // The slice runs to the END of the file, not to the section 7 banner. The mark's
  // cross-fade is declared in section 9 — far below the reduced-motion and
  // explicit-off blocks, because the bar is the window's chrome and its rules live
  // with the bar — so a slice bounded at section 7 would report a correct rule as
  // missing. That is exactly what the first version of this test did.
  const explicitOff = css.slice(
    css.indexOf("html:not([data-dsh-ui='vanilla'])[data-dsh-desktop-animation='off'] body button"),
  )
  assert.ok(explicitOff.length > 0, 'the explicit-off gate must exist')

  for (const [name, fragment] of [
    ['the mark’s cross-fade', '.dshTb__markLogo'],
    ['the composer’s tool buttons', "[class*='_tools'] [class*='_add']"],
    ['the 外观 option buttons', '.dshAppearance__option'],
    ['the 外观 font-size selector', '.dshAppearance__selector'],
    ['the collapse animation', "[class*='_cardOpen'] [class*='_body']"],
  ]) {
    assert.ok(
      explicitOff.includes(fragment),
      `${name} must be dropped by an explicit animation off`,
    )
  }

  // Under reduced motion, the section 6 and 6c rules stand down too. The mark is
  // NOT in that block, and that is deliberate: its transition is declared in
  // section 9, which is ungated in the mode direction because the bar is the
  // window's chrome and exists in 原版 as well — the `animation='off'` rule above
  // is what stops it there.
  const mediaAt = css.indexOf('@media (prefers-reduced-motion: reduce)')
  const mediaBlock = css.slice(mediaAt, css.indexOf("\n}\n", mediaAt))
  for (const fragment of [
    "[class*='_tools'] [class*='_add']",
    '.dshAppearance__option',
    '.dshAppearance__selector',
    "[class*='_cardOpen'] [class*='_body']",
  ]) {
    assert.ok(
      mediaBlock.includes(fragment),
      `${fragment} must be dropped under reduced motion unless animation is explicitly on`,
    )
  }
})

test('the title bar is fixed on the body plane, above every app overlay', () => {
  const css = read('css')

  // The bar is portalled to `document.body` rather than left in the frame's
  // overlay layer, which is a stacking context at z-index 20 — anything inside it
  // loses to the app's body-portalled dialogs (1000) and onboarding mask (1100).
  // A bar under a dialog's mask is dimmed and unclickable exactly when a dialog is
  // open, which is when the window controls matter most.
  const bar = css.slice(css.indexOf('.dshTb {'))
  const rule = bar.slice(0, bar.indexOf('}'))

  assert.ok(rule.includes('position: fixed'), 'the bar must be fixed, not absolute in the frame')
  const zIndex = /z-index:\s*(\d+)/.exec(rule)
  assert.ok(zIndex, 'the bar must declare a z-index')
  assert.ok(
    Number(zIndex[1]) > 1100,
    `the bar (z-index ${zIndex[1]}) must sit above the app's highest overlay (1100)`,
  )
  assert.ok(
    Number(zIndex[1]) < 2147483647,
    'but not at the maximum: a value that wins by a mile also wins against surfaces that belong on top',
  )

  // And the client half must actually portal there, or the z-index applies inside
  // the very stacking context it was meant to escape.
  const client = read('titleBar')
  assert.ok(
    client.includes('createPortal'),
    'the bar must be portalled to the body, which is what makes the z-index meaningful',
  )
})

test('menus outrank the bar, so no menu item is ever painted under it', () => {
  const css = read('css')

  // THE MEASURED BUG THIS GUARDS. Every menu in the app — the row menus, the
  // composer's pickers, the settings dropdowns, and the bar's own four menus — is
  // portalled to `document.body` and carries the app's `_portal_…{z-index:1100}`.
  // The bar is 1200, so a menu loses to it. That is not theoretical: the overlay's
  // own right-click placement clamps a menu to 8px from the viewport top, so a
  // right-click on a row near the top of the sidebar puts the menu's FIRST ITEM
  // inside the bar's 44px strip. Verified live at exactly that geometry: the
  // menu's top edge hit-tests to `dshBoot__spacer` — the bar — leaving 重命名
  // unclickable until the pointer passed y=44.
  // The model picker's outer group owns the stacking context; raising only its
  // inner menu still leaves the search field behind the title bar.
  const rule = /html body \[role='menu'\],\s*\nhtml body \[data-menu-material\]\[role='group'\],\s*\nhtml body \[data-dockkit-tab-menu\] \{\s*\n\s*z-index:\s*(\d+);/
  const match = rule.exec(css)
  assert.ok(match, 'the menu z-index rule must cover menus, model picker surfaces and dock menus')

  const menuZ = Number(match[1])

  // It must beat the bar, which is the whole point.
  const barZ = Number(/\.dshTb \{[\s\S]*?z-index:\s*(\d+)/.exec(css)[1])
  assert.ok(
    menuZ > barZ,
    `a menu (${menuZ}) must sit above the bar (${barZ}), or its first item is unreachable`,
  )

  // But not at the maximum, for the reason the bar's own comment gives: a value
  // that wins by a mile also wins against whatever legitimately belongs on top.
  assert.ok(menuZ < 2147483647, 'the menu layer must not be the maximum z-index')

  // The dock's tab menu is not a `[role=menu]` primitive and ships `z-index:70` —
  // below even the app's hover cards and tooltips (100). It has to be named
  // explicitly, or the lowest surface in the interface stays the lowest.
  assert.ok(
    css.includes("[data-dockkit-tab-menu]"),
    'the dock tab menu must be covered, since it is not a [role=menu]',
  )

  // UNGATED, like the rest of section 9. 原版 shows the unmodified frontend, but it
  // does not remove the window's title bar — so a menu painted under that bar is
  // the window failing to show its own UI, not an appearance preference.
  const at = css.indexOf("html body [role='menu'],")
  const gatedRule = css.slice(at, css.indexOf('}', at))
  assert.ok(
    !gatedRule.includes('data-dsh-ui'),
    'the menu layer must not be gated, or 原版 puts menu items back under the bar',
  )
})

test('menu elevation follows the dark palette without changing the app-wide tokens', () => {
  const css = read('css')
  // Menu redesigns can change the drop strength. The regression to guard is a
  // white glow or a global palette override leaking into unrelated surfaces.
  const dark = css.match(/html:not\(\[data-dsh-ui='vanilla'\]\) body\[data-ds-dark-theme\]\s*\{[^{}]*--dsh-menu-shadow:\s*([^;]+);[^{}]*\}/)
  assert.ok(dark, 'the dark menu elevation must stay gated on theme and overlay mode')
  assert.ok(/rgb\(0 0 0 \/ /.test(dark[1]), 'the drop is black in the dark palette')
  assert.ok(!/255|#fff|white/i.test(dark[1]), 'dark elevation must not become a white glow')
  assert.ok(
    !/--dsw-elevation-stroke:\s*color-mix/.test(css),
    'menu styling must not retint the app-wide elevation tokens',
  )
  assert.ok(
    !/--dsw-alias-border-l[1-4]:\s*color-mix/.test(css),
    'menu styling must not retint borders and focus outlines elsewhere',
  )
})

test('the title bar reserves its space with a #root CONTAINER, in both modes', () => {
  const css = read('css')
  const dom = read('dom')

  // THE DESIGN. The bar's strip is reserved by making #root a fixed box below the
  // bar, so everything the frontend renders — including what it portals out of
  // itself — begins below the bar, from one declaration that needs no JavaScript.
  //
  // This replaced a `padding-top` on the layout frame, which pushed the app's
  // COLUMNS down but could not reach a dialog: a `position: fixed` layer resolves
  // against the viewport and never saw the frame's padding, which is why each one
  // needed its own JavaScript correction and why 原版 — whose purpose is to strip
  // those corrections — lost all of them.
  assert.ok(css.includes('html body #root {'), 'the container rule must exist')
  const at = css.indexOf('html body #root {')
  const rule = css.slice(at, css.indexOf('}', at))

  assert.ok(/position:\s*fixed/.test(rule), 'the container must be fixed')
  assert.ok(
    /inset:\s*var\(--dsh-desktop-titlebar-height/.test(rule),
    'the container must start at the bar height',
  )

  // `height: auto` is load-bearing, not a default. The app ships
  // `html,body,#root{height:100%}`, and for a fixed box with BOTH `top` and `bottom`
  // set AND a specified height, the `bottom` inset is ignored — so `height:100%`
  // would make the container 840px tall from y=44 and overflow by one bar.
  assert.ok(
    /height:\s*auto/.test(rule),
    'the container must reset height, or it overflows the window by one bar',
  )

  // No transform HERE. A transformed container becomes the containing block for the
  // app's coordinate-positioned popups, which render as ordinary children INSIDE
  // #root and take their left/top from getBoundingClientRect() in real viewport
  // space. Measured with a fixture of that shape: container at y=44 + transform
  // displaced it by exactly +44. The transform is scoped to the layers that need it
  // instead (see the rule below).
  assert.ok(
    !/transform/.test(rule),
    'the container must NOT be a containing block, or every tooltip shifts by the bar height',
  )

  // Ungated: this is the window's layout, not the overlay's appearance.
  assert.ok(!rule.includes('data-dsh-ui'), 'the container must not be gated on the UI mode')
})

test('the layer offset is tagged as chrome, so it survives 原版', () => {
  const css = read('css')
  const dom = read('dom')

  // The reported bug. A full-screen layer must be pushed below the bar, and the tag
  // that identifies it used to be `data-dsh-desktop='dialog'` — which 原版 exists to
  // strip. So switching to 原版 put the settings panel's header back under the bar
  // (measured live: panelTop 24 against 46).
  //
  // The rule is therefore keyed on a separate attribute family that
  // `clearDecorations` deliberately does not touch: appearance tags are removed in
  // 原版, LAYOUT tags are not, because the bar exists in both modes.
  assert.ok(
    css.includes("html body [data-dsh-chrome='layer']"),
    'theme.css must style the layer tag from the chrome family',
  )
  assert.ok(
    dom.includes("setAttribute(CHROME_ATTRIBUTE, CHROME_LAYER)"),
    'dom.js must apply that tag',
  )
  assert.ok(
    dom.includes("var CHROME_ATTRIBUTE = 'data-dsh-chrome'"),
    'the chrome attribute must be a named constant',
  )

  // And `clearDecorations` must NOT remove it. This is the whole fix, so it is
  // asserted against the function body rather than trusted to inspection.
  const clear = dom.slice(dom.indexOf('function clearDecorations'), dom.indexOf('function markReady'))
  assert.ok(
    !clear.includes('CHROME_ATTRIBUTE'),
    'clearDecorations must not strip the layout tag, or 原版 loses the offset again',
  )
  assert.ok(
    clear.includes("removeAttribute('data-dsh-desktop')"),
    'but it must still strip the appearance tags',
  )

  // The vanilla branch of `pass` must keep applying the layout tag. Skipping it was
  // the bug: 原版 returned before the tagging ran.
  const pass = dom.slice(dom.indexOf('function pass'), dom.indexOf('function decorateComposerPresent'))
  const vanillaBranch = pass.slice(pass.indexOf('isVanilla()'), pass.indexOf('markFullSurfaceLayers(true)'))
  assert.ok(
    vanillaBranch.length > 0 && vanillaBranch.length < 900,
    'the vanilla branch must call markFullSurfaceLayers, not return before it',
  )

  // THE SAME BUG IN THE OTHER TAGGING PATH, and this one survived a first pass of
  // checking because the tag merely PERSISTED from desktop mode. It does not if the
  // page loads in 原版, or if the dialog is opened after switching: the observer
  // returned on `isVanilla()` at its very first line, before the frame callback that
  // does the tagging, so a layer appearing later was never tagged. Measured from a
  // genuine 原版 start: panelTop 24, no tag.
  //
  // Asserted as ORDERING within the observer: the layout call must come before any
  // vanilla guard, since a guard placed first is exactly the bug.
  const observerAt = dom.indexOf('function watchRelocatedRows')
  const observerEnd = dom.indexOf('function decorateFrame')
  const observer = dom.slice(observerAt, observerEnd > observerAt ? observerEnd : observerAt + 2000)
  const tagAt = observer.indexOf('markFullSurfaceLayers(false, records)')
  const guardAt = observer.indexOf('isVanilla()')
  assert.ok(tagAt > 0, 'the observer must tag full-surface layers')
  assert.ok(
    guardAt > 0 && tagAt < guardAt,
    'the observer must tag layers BEFORE any vanilla guard, or 原版 never tags them',
  )

  // `top` rather than `padding-top`: the layer centres its content, so moving the top
  // edge shrinks the box it centres within AND stops its mask from covering the bar.
  const at = css.indexOf("html body [data-dsh-chrome='layer']")
  const rule = css.slice(at, css.indexOf('}', at))
  assert.ok(
    /top:\s*var\(--dsh-desktop-titlebar-height/.test(rule),
    'the layer must move its top edge',
  )
  assert.ok(!/padding/.test(rule), 'and must not use padding for this')
  assert.ok(
    !/top:[^;]*!important/.test(rule),
    'the layer rule does not need !important; its specificity already wins',
  )
  assert.ok(!rule.includes('data-dsh-ui'), 'the layer rule must not be gated on the UI mode')

  // NO blanket transform on every layer. The app renders ordinary tooltips inside
  // dialogs (the Agent presets section wraps a description in a Tooltip), and the
  // bubble takes left/top from getBoundingClientRect() in real viewport space.
  // Measured inside the settings layer: transformed -> y=544, untransformed -> y=500.
  assert.ok(
    !/transform/.test(rule),
    'the layer rule must not transform every layer, or tooltips inside dialogs shift',
  )

  // The transform is scoped by :has() to the one layer shape that needs it — a layer
  // holding its own inline-fixed child, which is the image lightbox's close button.
  assert.ok(
    css.includes("[data-dsh-chrome='layer']:has(> [style*='position: fixed'])"),
    'the containing-block transform must be scoped to a layer with a fixed child',
  )
})

test('viewport layers inside the app use a scoped titlebar offset', () => {
  const css = read('css')

  // Native layer selectors can combine a class and an attribute. An id scope
  // wins over those rules even when their inset declaration is loaded later.
  const scopedLayer = css.indexOf("html body #root [data-dsh-chrome='layer']")
  assert.ok(scopedLayer > 0, 'the layer offset must exist one scope deeper, under #root')
  const scopedLayerRule = css.slice(scopedLayer, css.indexOf('}', scopedLayer))
  assert.ok(
    /top:\s*var\(--dsh-desktop-titlebar-height/.test(scopedLayerRule),
    'the scoped layer rule must move the top edge like the original',
  )

  assert.ok(!/padding|!important/.test(scopedLayerRule))
  assert.ok(!scopedLayerRule.includes('data-dsh-ui'), 'window chrome also applies in 原版')
})

test('the dialog layer is identified by inset, not by parent or size', () => {
  const dom = read('dom')

  // THE REGRESSION. The first implementation scanned `document.body.children` and
  // tested `getBoundingClientRect()`. The settings overlay is rendered INSIDE
  // `#root`, so it was never tagged and its header sat under the bar — measured
  // live at 20px hidden. The rule is now the layer's own inset, which holds
  // wherever the layer lives.
  const test = dom.slice(dom.indexOf('function isFullSurfaceLayer'), dom.indexOf('function markFullSurfaceLayers'))
  assert.ok(test.includes('position'), 'the test must require fixed positioning')
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.ok(
      new RegExp(`style\\.${side} === '0px'`).test(test),
      `the test must require ${side} to be 0px`,
    )
  }
  assert.ok(
    !test.includes('getBoundingClientRect'),
    'the test must not depend on measured size: it forces layout and misses short boxes',
  )
  assert.ok(
    !test.includes('parentElement'),
    'the test must not depend on the parent, which is what missed the settings overlay',
  )
})

// ── the mode reaches the page before first paint ─────────────────────────────

test('the host publishes the mode ahead of the stylesheet it gates', () => {
  const overlay = read('overlay')

  // A page opened in 原版 must never paint the overlay first: the stylesheet is
  // in <head>, so the attribute has to be set by a head script pushed BEFORE the
  // style row. Ordering in this function is the whole mechanism.
  const modePush = overlay.indexOf("kind: 'script', placement: 'head'")
  const stylePush = overlay.indexOf("kind: 'style'")
  assert.ok(modePush > 0, 'the mode script row must exist')
  assert.ok(stylePush > 0, 'the style row must exist')
  assert.ok(modePush < stylePush, 'the mode script must be pushed before the stylesheet')

  // It reads the same namespace and field the appearance plugin registers. A
  // mismatch here means the pre-paint read always falls back to the default, and
  // 原版 flashes the overlay on every load.
  assert.ok(overlay.includes("'desktop-appearance'"), 'the host must read the appearance namespace')
  assert.ok(overlay.includes("= 'ui'"), 'the host must read the ui field')

  // And it must fail closed to the desktop overlay, not to vanilla.
  assert.ok(/DEFAULT_UI_MODE|return DESKTOP_MODE|DESKTOP_MODE\b/.test(overlay))
})
