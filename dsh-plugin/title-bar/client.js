/**
 * Custom title bar for the dsh desktop app.
 *
 * The native caption is removed (the window is created with
 * `decorations(false)`), so this bar replaces it: the app mark, four menus
 * (编辑 / 会话 / 项目 / 更多), and the window controls.
 *
 * The mark is also the sidebar's collapse control — the sidebar's own header,
 * which held both the mark and its 收起侧边栏 button, is hidden by the overlay's
 * stylesheet, so this bar carries the one control that replaces it. Hovering the
 * mark swaps it for the app's panel glyph and clicking it toggles the sidebar
 * through `ctx.layout`. See {@link TitleBar}'s `brand` for the reasoning.
 *
 * ## Why this is not compiled
 *
 * A **hand-authored client bundle**, like the appearance plugin. The bundler
 * such files normally come from exists to compile TypeScript and JSX; writing the
 * shape directly keeps a bundler out of the desktop app's toolchain. So there is
 * no JSX (components use `React.createElement`, aliased `h`) and no TypeScript.
 *
 * ## Where it renders
 *
 * It is registered into the `shell.overlay` slot — a frame-wide floating layer
 * above every column and outside their scroll containers, and a slot where
 * registering a fresh `id` is additive rather than a replacement, unlike `root`.
 *
 * **But it is not rendered inside it.** The component portals its output to
 * `document.body`, because a bar that lives in the frame loses two fights it
 * cannot win from there:
 *
 *   1. **Stacking.** The frame's overlay layer sits at `z-index: 20`, and the
 *      app portals every dialog and mask to `document.body` at 1000–1100. A bar
 *      inside the frame is therefore *under* a dialog's mask, which dims and
 *      blocks the window controls exactly when a dialog is open. Portalled to
 *      the body at a chrome-level z-index, the bar stays above them.
 *
 *   2. **`inert`.** The app's onboarding overlay sets `#root.inert = true` while
 *      it is shown. Anything inside `#root` then becomes non-interactive — so a
 *      bar there would be visible but dead, with no way to close the window.
 *      `document.body` is outside it.
 *
 * Both reasons point the same way, and the bar is styled for it: see section 9
 * of `theme.css`, where it is `position: fixed`.
 *
 * The slot registration is still required — the portal has to be rendered by
 * something, and `shell.overlay` is the frame-wide seat that makes the bar's
 * lifetime the frame's.
 *
 * ## How the menus work
 *
 * They reuse the app's own `Menu` primitive rather than a bespoke popup, so
 * keyboard handling, focus management, and the borderless styling from
 * `theme.css` all apply unchanged. `Menu` positions itself from
 * `anchor.getBoundingClientRect()`; passing `getAnchorRect` returns the trigger's
 * rect directly, which anchors each menu under its own button.
 *
 * ## What the actions call
 *
 * Real services, not synthesized clicks: `uiWorkspace` for session operations and
 * `workspaces` for project ones. That is what the sidebar's own row menus do
 * underneath. Two exceptions, both deliberate:
 *
 *   - **Rename** opens a dialog here rather than the app's, because the sidebar's
 *     rename dialog is internal `useState` with no way to trigger it externally.
 *     It calls the same `rename` methods the sidebar's dialog does.
 *   - **Settings** uses the shell store published by `sidebar.settings`. Older
 *     releases without that store use the original accessible trigger button.
 */

window.__ModuleLoader__.load({
  id: '@dsh-desktop/title-bar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    
  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
  const useLocale = React => window.__DSH_I18N__?.use(React)
var React = require('react')
    // `createPortal`, so the bar can be rendered into the overlay slot and
    // *placed* on `document.body` — see the module header for why both are
    // needed. A platform seed word, so it needs no manifest entry.
    var reactDom = require('react-dom')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** `createElement` shorthand; no JSX is available in a hand-built bundle. */
    var h = React.createElement

    /**
     * Read one icon from the primitives module across its naming generations.
     *
     * WHY THE SECOND NAME. DSH 0.2 renamed every icon export from a size suffix
     * (`IconXxxOutline16` / `-20` / `-14`) to a stroke-weight one
     * (`IconXxxOutlineRegular` / `-Medium`), keeping the same artwork behind a
     * `size` prop. A name read straight off the module is therefore `undefined`
     * on one generation or the other, and an undefined element type is not a
     * degraded bar but a React crash (#130) — which the slot system then swallows
     * into `data-slot-error`, leaving the injected boot bar in place forever.
     * That exact failure shipped: the bar vanished after a dsh update and the
     * boot bar never retired.
     *
     * Each icon lists its names oldest-first, so a 0.1 page and a 0.2 page resolve
     * the same artwork through different exports. When no generation matches — a
     * future rename — the resolver returns `undefined` and {@link iconOrMissing}
     * substitutes {@link MissingIcon}: a neutral glyph that reads as a placeholder
     * rather than a crash, the same degrade-to-something the other desktop
     * plugins apply to the primitives they read.
     *
     * @param names - the candidate export names, in preference order.
     * @returns the icon component, or `undefined` when none resolves.
     */
    function iconOf() {
      for (var i = 0; i < arguments.length; i += 1) {
        var candidate = primitives ? primitives[arguments[i]] : undefined
        // A component is a function or (forwardRef, memo) an object; anything
        // else is a re-export accident and is skipped like a miss.
        if (typeof candidate === 'function' || (candidate && typeof candidate === 'object')) {
          return candidate
        }
      }
      return undefined
    }

    /** Resolve one icon or fall back to {@link MissingIcon}. */
    function iconOrMissing() {
      return iconOf.apply(null, arguments) || MissingIcon
    }

    /** Icons taken from the app, so the bar matches its visual language. */
    var IconArchive = iconOrMissing('IconArchiveOutline20', 'IconArchiveOutlineRegular')
    var IconBranch = iconOrMissing('IconBranchOutline16', 'IconBranchOutlineRegular')
    var IconCopy = iconOrMissing('IconCopyOutline16', 'IconCopyOutlineRegular')
    var IconDownload = iconOrMissing('IconDownloadOutline16', 'IconDownloadOutlineRegular')
    var IconEdit = iconOrMissing('IconEditOutline16', 'IconEditOutlineRegular')
    // The folder glyph the sidebar uses on a workspace row, so "open in Explorer"
    // reads as a directory action rather than as a generic link.
    var IconFolderOpen = iconOrMissing('IconFolderOpenOutline16', 'IconFolderOpenOutlineRegular')
    // The link glyph, for the one action that produces a link rather than
    // acting on a directory: 复制深度链接 in the 会话 menu.
    var IconLink = iconOrMissing('IconLinkOutline16', 'IconLinkOutlineRegular')
    var IconNewChat = iconOrMissing('IconNewChatOutline16', 'IconNewChatOutlineRegular')
    // The app's own sidebar glyph — the one its collapsed rail shows in place of
    // the mark when the pointer is over the toggle. Taken from the primitives
    // module like every other icon here, so the control that replaces the
    // sidebar's own collapse button is drawn with the same artwork that button
    // uses, and the two are recognisably one control.
    var IconPanelLeft = iconOrMissing('IconPanelLeftOutline16', 'IconPanelLeftOutlineRegular')
    var IconQuestion = iconOrMissing('IconQuestionOutline14', 'IconQuestionOutlineRegular')
    var IconSettings = iconOrMissing('IconSettingsOutline16', 'IconSettingsOutlineRegular')
    var IconTrash = iconOrMissing('IconTrashOutline16', 'IconTrashOutlineRegular')

    /**
     * The two glyphs for the style switch, both drawn here for the same reason as
     * the window controls: the app ships no "restore" or "palette" icon.
     *
     * They are deliberately plain — one is a boxed brush, the other a refresh
     * arrow over a boxed square — so the item reads as "swap the look" in either
     * direction rather than as a settings entry.
     */
    function IconRestore() {
      return h(
        Glyph,
        null,
        h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.4 }),
        h('path', { d: 'M8 5.6v4.8M5.6 8h4.8' }),
      )
    }

    function IconStyles() {
      return h(
        Glyph,
        null,
        h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.4 }),
        h('path', { d: 'M4.9 11.1c2.6-1 3.4-3.6 6.2-6.2' }),
        h('circle', { cx: 5.9, cy: 10.1, r: 1.1 }),
      )
    }

    /**
     * The title-bar mode switch's glyph: a captioned window.
     *
     * A boxed rect with a strip line across its top — the same boxed motif
     * {@link IconRestore} and {@link IconStyles} use — so the two chrome switches
     * read as one family. The strip line is what the switch is about: the bar
     * itself, reduced to its caption.
     *
     * @returns the icon element.
     */
    function IconTitlebar() {
      return h(
        Glyph,
        null,
        h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.4 }),
        h('path', { d: 'M4.5 6.4h7' }),
        h('circle', { cx: 5.1, cy: 4.5, r: 0.1, strokeWidth: 0.8 }),
        h('circle', { cx: 6.9, cy: 4.5, r: 0.1, strokeWidth: 0.8 }),
      )
    }

    /**
     * The icon-hover switch's glyph: a pointer inside its highlight.
     *
     * A boxed rect carrying a small pointer arrow, again on the boxed motif: the
     * box is a button, the arrow is the pointer over it, and together they name
     * the feedback this switch turns on and off.
     *
     * @returns the icon element.
     */
    function IconHover() {
      return h(
        Glyph,
        null,
        h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.4 }),
        h('path', { d: 'M6 5.6l4.2 2.1-1.9.7-.7 2z' }),
      )
    }

    /**
     * The stand-in when an app icon resolves under no known name.
     *
     * A deliberately anonymous filled dot in the app's own 16px outline grid: it
     * reads as a glyph slot the host could not name rather than as broken layout,
     * and it keeps the element tree valid — which is the whole point. An
     * `undefined` component in this bar's tree is not a degraded item but React
     * error #130, the crash that stranded the boot bar once already; see
     * {@link iconOf}.
     *
     * @returns the icon element.
     */
    function MissingIcon() {
      return h(Glyph, null, h('circle', { cx: 8, cy: 8, r: 2.4, fill: 'currentColor', stroke: 'none' }))
    }

    var Menu = primitives.Menu
    var Modal = primitives.Modal
    var Input = primitives.Input
    var Button = primitives.Button

    /**
     * Required client services.
     *
     * `uiWorkspace` carries session navigation and forking; `sessions` and
     * `workspaces` are the controllers their inject faces delegate to. Injecting
     * the controllers directly is what makes project rename and delete possible —
     * `uiWorkspace` itself has no rename or delete for projects.
     *
     * `layout` is the third controller, and it is here for ONE call:
     * `toggleSidebar()`. It is the same service the sidebar's own collapse button
     * calls (`ui-sidebar`'s `injectProps`), so the title bar's control is not a
     * lookalike that clicks the app's button — it drives the app's own panel
     * state, which is what the appearance overlay then hides the trigger of.
     */
    var inject = ['slots', 'uiWorkspace', 'sessions', 'workspaces', 'layout', 'theme']

    /**
     * The `<html>` attribute carrying the live UI mode.
     *
     * Written by the appearance plugin (`ui-client/client.js`), which owns the
     * persisted setting, and read here so the 更多 menu can name the mode the
     * other one will switch TO. Also seeded before first paint by the host half
     * of the overlay (`desktop-ui.mjs`).
     */
    var MODE_ATTRIBUTE = 'data-dsh-ui'

    /** The mode meaning "the unmodified frontend". */
    var VANILLA = 'vanilla'

    /** The mode meaning "apply this app's overlay". */
    var DESKTOP = 'desktop'

    /**
     * Event asking the appearance plugin to switch modes. Detail: `{ mode }`.
     *
     * The bar does not write the attribute itself. Persisting the choice needs
     * the settings scope, which the appearance plugin owns, and two writers for
     * one setting is how a setting starts disagreeing with itself. So the bar
     * asks and the owner applies — and because the owner announces the result,
     * this menu's label follows from the same single source.
     */
    var MODE_REQUEST_EVENT = 'dsh-desktop:set-ui-mode'

    /** Event announcing an applied mode. Detail: `{ mode }`. */
    var MODE_CHANGE_EVENT = 'dsh-desktop:ui-mode'

    /**
     * Event reporting a failed directory launch to the page. Detail:
     * `{ message, error }`.
     *
     * The overlay (`ui-overlay/dom.js`) listens for this and renders the message
     * as a small toast, so a refused launch — a directory that was moved, a
     * launcher that is gone — is visible instead of a menu that closes for
     * nothing. Keep the name in sync with `REPORT_EVENT` there; the overlay
     * installs at most one listener, so this can be dispatched on every failure.
     */
    var REPORT_EVENT = 'dsh-desktop:report'

    /**
     * Announced once this bar is on screen, so the boot bar can retire.
     *
     * The boot bar (`title-bar/boot.js`) is injected by the Rust host as a
     * document-created script and covers the interval before DSH has mounted —
     * the app's onboarding page and DSH's own "Loading plugins…" splash. It
     * cannot know when this one takes over, and the two must not both be visible:
     * they occupy the same strip. So this announces, and the boot bar removes
     * itself. Keep the name in sync with `READY_EVENT` in `boot.js`.
     */
    var TITLEBAR_READY_EVENT = 'dsh-desktop:titlebar-ready'

    /**
     * The durable half of {@link TITLEBAR_READY_EVENT}.
     *
     * An event only reaches a listener that was already installed, so a boot bar
     * that mounted *after* this one announced would never hear it and would sit
     * on top of the real bar forever. The attribute is the state that outlives
     * the moment, and `boot.js` checks it both when it mounts and when it is
     * announced to.
     *
     * Deliberately not `data-dsh-desktop`: `ui-overlay/dom.js` removes every
     * attribute in that family when the page switches to 原版, and this marker
     * describes this app's chrome rather than its appearance — it has to survive
     * that switch either way, or a reload in 原版 would resurrect the boot bar.
     */
    var TITLEBAR_READY_ATTRIBUTE = 'data-dsh-titlebar'

    /**
     * Read the UI mode currently in effect.
     *
     * Falls back to `desktop`, which is both the schema's default and what an
     * absent attribute means to the stylesheet's gate.
     *
     * @returns `desktop` or `vanilla`.
     */
    function readUiMode() {
      return document.documentElement.getAttribute(MODE_ATTRIBUTE) === VANILLA ? VANILLA : DESKTOP
    }

    /** App-owned chrome state, seeded by the host before the client mounts. */
    var TITLEBAR_MODE_ATTRIBUTE = 'data-dsh-titlebar-mode'

    /** The title-bar mode meaning "the full bar: 编辑 · 会话 · 项目 · 更多". */
    var TITLEBAR_FULL = 'full'

    /** Compact chrome is reserved for application lifecycle transitions. */
    var TITLEBAR_SIMPLE = 'simple'

    /** Event announcing an applied title-bar mode. Detail: `{ mode }`. */
    var TITLEBAR_MODE_CHANGE_EVENT = 'dsh-desktop:titlebar-mode'

    /**
     * The `<html>` attribute carrying the live icon-hover preference.
     *
     * Absent and `on` mean the same thing — hover feedback shows — so a page the
     * host did not seed behaves as before. `off` still draws the bar exactly as
     * above; only the pointer-following reactions (trigger and window-control
     * highlight, the mark's glyph swap) stop answering, which is what the
     * stylesheet gates. This is controlled by the app, not a user preference.
     */
    var TITLEBAR_HOVER_ATTRIBUTE = 'data-dsh-titlebar-hover'

    /** Event announcing an applied icon-hover preference. Detail: `{ hover }`. */
    var TITLEBAR_HOVER_CHANGE_EVENT = 'dsh-desktop:titlebar-hover'

    /**
     * Read the title-bar mode currently in effect.
     *
     * Falls back to the full bar once the client is ready.
     *
     * @returns `full` or `simple`.
     */
    function readTitlebarMode() {
      return document.documentElement.getAttribute(TITLEBAR_MODE_ATTRIBUTE) === TITLEBAR_SIMPLE
        ? TITLEBAR_SIMPLE
        : TITLEBAR_FULL
    }

    /**
     * Read the icon-hover preference currently in effect.
     *
     * @returns `on` or `off`.
     */
    function readTitlebarHover() {
      return document.documentElement.getAttribute(TITLEBAR_HOVER_ATTRIBUTE) === 'off' ? 'off' : 'on'
    }



    /**
     * Whether this bar is rendering the remote page.
     *
     * The 远程控制 page — the one a phone browser opens over the LAN — is
     * marked `data-dsh-browser` by the injected `browser-compat.js` before any
     * client bundle runs. That page gets a reduced bar: the four menus act on
     * desktop affordances (window drag, host clipboard, Explorer launches) that
     * a phone has no use for, so there the bar carries only the mark and the
     * theme switch. The desktop window is untouched.
     *
     * Read per render rather than cached at factory time: the attribute is set
     * in `<head>`, so either order would work, but the document is the thing
     * actually being styled and there is no reason to freeze a copy of it.
     *
     * @returns whether the page is a plain browser.
     */
    function isRemotePage() {
      return document.documentElement.getAttribute('data-dsh-browser') !== null
    }

    /**
     * Ask the appearance plugin to switch modes.
     *
     * Fire-and-forget by design: the request cannot fail in a way the bar could
     * act on — an absent listener means the appearance plugin is not loaded, and
     * there is then no setting to persist and no stylesheet gate to move either.
     *
     * @param mode - `desktop` or `vanilla`.
     */
    function requestUiMode(mode) {
      try {
        document.dispatchEvent(new CustomEvent(MODE_REQUEST_EVENT, { detail: { mode: mode } }))
      } catch (error) {
        // Nothing to report to: the bar has no logger of its own here, and the
        // menu simply stays on the mode it was already showing.
      }
    }

    /**
     * Bar height, in pixels.
     *
     * Taller than a native caption (which is ~32px at this DPI) because the bar
     * carries a logo, a text menu, and the window buttons. The stylesheet reads
     * the same number from a custom property, so the app content is offset by
     * exactly this much.
     */
    var BAR_HEIGHT = 44

    /**
     * The DeepSeek mark, inline rather than loaded from a file.
     *
     * A plugin asset would need a served URL and a second network request before
     * first paint, which would show as a gap in the bar. The path is the shipped
     * logo, and `currentColor` lets the stylesheet tint it per palette.
     */
    var LOGO_PATH =
      'M48.8354 10.0479C48.3232 9.792 48.1025 10.2798 47.8032 10.5278C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C36.4668 10.0156 35.9702 9.3198 35.356 7.7275C35.2456 7.3999 35.1353 7.064 34.7651 7.0078C34.3633 6.9438 34.2056 7.2876 34.0479 7.5757C32.6143 10.2559 33.3311 15.8721 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C31.8657 19.2559 29.6758 15.3599 25.8467 12.5518C23.8618 10.584 26.1069 8.9678 26.627 8.7759C27.1704 8.5757 26.8159 7.8877 25.0591 7.896C22.9873 7.9038 20.5688 9.0879 18.7095 9.584C11.9102 8.272 6.4272 10.9521 3.8433 14.7681C-1.521 22.688 1.7085 33.5039 8.0737 38.8799C14.3047 44.1357 23.5229 45.9199 31.1016 39.4561C33.4102 40.624 36.5454 40.5439 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C39.397 30.4639 41.7524 25.1279 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C46.7559 18.9038 49.0005 15.5039 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C7.6011 33.8559 4.4976 27.0156 4.1978 21.3677C4.1582 20.5757 4.3867 20.2959 5.1587 20.1519C12.9189 18.688 19.0161 24.248 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398Z'

    /** The app mark, tinted by the stylesheet. */
    function Logo() {
      return h(
        'svg',
        {
          className: 'dshTb__logo',
          viewBox: '0 0 50 50',
          width: 20,
          height: 20,
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', { d: LOGO_PATH, fill: 'currentColor' }),
      )
    }

    /**
     * The window-control glyphs, drawn here rather than taken from the app.
     *
     * The app ships no minimize/maximize/restore icons — it never needed them,
     * because the OS caption provided them. These follow its 16px grid and 1.2px
     * stroke so they sit correctly beside the shipped icons.
     */
    function Glyph(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        props.children,
      )
    }

    function MinimizeIcon() {
      return h(Glyph, null, h('path', { d: 'M3.5 8h9' }))
    }

    function MaximizeIcon() {
      return h(Glyph, null, h('rect', { x: 3.75, y: 3.75, width: 8.5, height: 8.5, rx: 1.5 }))
    }

    /** Shown while maximized: the "restore down" double square. */
    function RestoreIcon() {
      return h(
        Glyph,
        null,
        h('rect', { x: 3.5, y: 5.5, width: 7, height: 7, rx: 1.4 }),
        h('path', { d: 'M5.75 5.5V4.9A1.4 1.4 0 0 1 7.15 3.5h3.5A1.4 1.4 0 0 1 12.05 4.9v3.5a1.4 1.4 0 0 1-1.4 1.4h-.6' }),
      )
    }

    function CloseIcon() {
      return h(Glyph, null, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }

    /** Theme actions in the title bar's 16px outline style. */
    function SunIcon() {
      return h(
        Glyph,
        null,
        h('circle', { cx: 8, cy: 8, r: 3 }),
        h('path', { d: 'M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1' }),
      )
    }

    function MoonIcon() {
      return h(Glyph, null, h('path', { d: 'M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z' }))
    }

    function SystemThemeIcon() {
      return h(Glyph, null,
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 9, rx: 1.5 }),
        h('path', { d: 'M8 11.5v2M5 13.5h6' }),
      )
    }

    /**
     * Cut, drawn as scissors because the app has no cut/paste glyphs.
     *
     * @returns the icon element.
     */
    function CutIcon() {
      return h(
        Glyph,
        null,
        h('circle', { cx: 4.6, cy: 11.4, r: 1.9 }),
        h('circle', { cx: 11.4, cy: 11.4, r: 1.9 }),
        h('path', { d: 'M5.9 10.1L12 3M10.1 10.1L4 3' }),
      )
    }

    /**
     * Paste, drawn as a clipboard, for the same reason as {@link CutIcon}.
     *
     * @returns the icon element.
     */
    function PasteIcon() {
      return h(
        Glyph,
        null,
        h('rect', { x: 4, y: 3.25, width: 8, height: 10.5, rx: 1.6 }),
        h('path', { d: 'M6.4 3.25V2.6h3.2v.65' }),
      )
    }

    /**
     * Report a failed action without breaking the bar.
     *
     * These actions cross the host boundary, and a rejected remote call must not
     * leave the UI stuck in a pending state — so every call site routes its
     * failure here rather than letting a rejection escape.
     *
     * @param ctx - the client context, for the logger.
     * @param what - a short description of the attempted action.
     * @param error - the rejection reason.
     */
    function reportFailure(ctx, what, error) {
      var detail = error instanceof Error ? error.message : String(error)
      try {
        ctx.logger?.warn?.('desktop title bar: could not ' + what + ': ' + detail)
      } catch {
        // A logger that throws must not turn a handled failure into an unhandled one.
      }
    }

    /**
     * Report a failed directory launch, to the log AND to the page.
     *
     * The log line is for diagnostics; the dispatch is for the user. The overlay
     * listens for {@link REPORT_EVENT} and renders the message as a small
     * self-dismissing toast — one renderer shared by both halves of the feature,
     * so a launch that refuses (a directory that was moved, a launcher that is
     * gone) is a visible sentence rather than a menu that closes for nothing.
     *
     * The dispatch is fire-and-forget and fully guarded: in a plain browser there
     * is no listener and the event dies on the document, which is the correct
     * degradation — the log line still happened.
     *
     * @param ctx - the client context, for the logger.
     * @param path - the directory the launch was attempted on.
     * @param reason - the route's message, a status code, or the error itself.
     */
    function reportLaunchFailure(ctx, path, reason) {
      var detail = reason instanceof Error ? reason.message : String(reason || '')
      reportFailure(ctx, 'open ' + path, reason)
      try {
        document.dispatchEvent(
          new CustomEvent(REPORT_EVENT, {
            detail: { message: t('打开 ') + path + t(' 失败') + (detail ? '：' + detail : ''), error: reason },
          }),
        )
      } catch {
        // No CustomEvent, no listener, no problem: the log still carries it.
      }
    }

    /**
     * Invoke a host command from the title bar.
     *
     * `__TAURI__` is injected by the desktop shell. The guard matters because this
     * bundle also loads in a plain browser during the app's own development, where
     * there is no shell and the bar should degrade to inert buttons rather than
     * throwing on first paint.
     *
     * @param command - the Rust command name.
     * @param args - its arguments.
     * @returns the command result, or `undefined` when no shell is present.
     */
    function invokeHost(command, args) {
      var api = globalThis.__TAURI__
      if (!api || !api.core || typeof api.core.invoke !== 'function') return Promise.resolve(undefined)
      return api.core.invoke(command, args)
    }

    /**
     * Whether the desktop shell is driving this window.
     *
     * The window controls are hidden entirely without it: in a browser tab the
     * native frame is present, and a second set of controls would be wrong.
     */
    function hasHost() {
      var api = globalThis.__TAURI__
      return Boolean(api && api.core && typeof api.core.invoke === 'function')
    }

    /**
     * The last editable element that held focus.
     *
     * Cut and Paste end in a native `Ctrl+X`/`Ctrl+V`, which acts on whatever the
     * OS considers focused. Opening a menu moves focus to the menu's own button,
     * so by the time an item is chosen the composer no longer has it and the chord
     * would land nowhere. Remembering the element lets focus be handed back before
     * the chord is sent.
     *
     * A module-level variable rather than state: nothing renders from it, and
     * re-rendering on every focus change would be pure overhead.
     */
    var lastEditable = null

    /**
     * The selection range inside {@link lastEditable}, as of the last time it was
     * intact.
     *
     * Cut needs this and Paste does not. A native `Ctrl+V` inserts at the caret, so
     * merely refocusing the editor is enough. `Ctrl+X` removes the *selection*, and
     * clicking a menu item blurs the editor, which drops that selection — so the
     * range is captured while it still exists and put back before the chord is
     * sent. Without it the chord arrives with nothing selected and silently does
     * nothing.
     */
    var lastRange = null

    /**
     * Start remembering the focused editable element and its selection.
     *
     * Installed once, at plugin mount. `selectionchange` fires on the document, so
     * the range is captured continuously while the user selects; `focusin` in the
     * capture phase records which element owns it.
     */
    function trackEditableFocus() {
      document.addEventListener(
        'focusin',
        function (event) {
          var node = event.target
          if (node === null) return
          if (node.isContentEditable === true || node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
            lastEditable = node
          }
        },
        true,
      )

      document.addEventListener('selectionchange', function () {
        var selection = window.getSelection()
        if (selection === null || selection.rangeCount === 0) return
        var node = selection.anchorNode
        if (node === null) return
        // Only track a selection inside the remembered editor, so selecting text
        // in the transcript never overwrites a composer selection.
        var element = node.nodeType === 1 ? node : node.parentElement
        if (lastEditable !== null && element !== null && lastEditable.contains(element)) {
          lastRange = selection.getRangeAt(0).cloneRange()
        }
      })
    }

    /**
     * Give focus back to the last editable, restoring its selection.
     *
     * Re-focusing a contenteditable restores its selection in Chromium only when
     * that selection was not cleared on blur, which is not reliable here — so the
     * remembered range is re-applied explicitly.
     *
     * @returns whether an editable now holds focus.
     */
    function restoreEditableFocus() {
      if (lastEditable === null) return false
      if (!document.contains(lastEditable)) {
        lastEditable = null
        lastRange = null
        return false
      }
      if (document.activeElement !== lastEditable) lastEditable.focus()

      if (lastRange !== null) {
        try {
          var selection = window.getSelection()
          selection.removeAllRanges()
          selection.addRange(lastRange)
        } catch {
          // A range whose nodes were removed by a re-render is unusable; the caret
          // then lands wherever focus put it, which is correct for Paste.
          lastRange = null
        }
      }
      return document.activeElement === lastEditable
    }

    /**
     * Read the current project, for the 项目 menu.
     *
     * The workspace owning the current session is the target. With no session
     * selected the most recently updated one is used, matching how the app itself
     * picks a default when creating a session.
     *
     * @param ctx - the client context.
     * @returns the workspace view, or `undefined` when there are none.
     */
    function currentWorkspace(ctx) {
      var workspaces = ctx.workspaces
      if (!workspaces) return undefined
      var items = workspaces.list.getSnapshot().items
      if (items.length === 0) return undefined

      var sessions = ctx.sessions
      var current = sessions ? currentSessionId(sessions.list.getSnapshot()) : undefined
      if (current !== undefined) {
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].sessionIds.indexOf(current) !== -1) return items[i]
        }
      }
      return items[0]
    }

    /**
     * Read the current session, for the 会话 menu.
     *
     * @param ctx - the client context.
     * @returns the session summary and id, or `undefined` when none is selected.
     */
    function currentSessionId(list) {
      // DSH 0.2 moved selection from list.current to main-view ownership.
      if (list.current != null) return list.current
      var entries = Object.entries(list.byId || {})
      for (var i = 0; i < entries.length; i += 1) {
        if ((entries[i][1].retainedBy?.mainView ?? 0) > 0) return entries[i][0]
      }
      return undefined
    }

    function currentSession(ctx) {
      var sessions = ctx.sessions
      if (!sessions) return undefined
      var list = sessions.list.getSnapshot()
      var id = currentSessionId(list)
      if (id === undefined) return undefined
      var summary = list.byId[id]
      if (summary === undefined) return undefined
      return { id: id, title: summary.title ?? summary.displayTitle ?? '' }
    }

    /**
     * Whether there is a non-empty selection to cut or copy.
     *
     * Read from the document selection rather than from the composer specifically,
     * because the bar is app-wide: selecting text in a transcript should be
     * copyable too.
     *
     * @returns whether Cut and Copy should be available.
     */
    // Read the complete event window, including off-screen history. A failed
    // history load must not silently put a truncated transcript on the clipboard.
    async function sessionContent(binding) {
      if (!binding?.eventSource || typeof binding.session.loadThrough !== 'function') {
        throw new Error(t('当前版本无法读取完整会话内容'))
      }
      await binding.session.loadThrough(0)
      var snapshot = binding.eventSource.getSnapshot()
      if (snapshot.hasMore) throw new Error(t('未能读取完整会话历史，请重试'))
      var rows = []
      var live = new Map()
      function contentText(content) {
        if (typeof content === 'string') return content
        return (content || []).map(function (part) {
          if (part.type === 'text') return part.text
          if (part.type === 'image') return t('[图片：') + (part.attachment?.name || t('图片')) + ']'
          if (part.type === 'file') return t('[文件：') + (part.attachment?.name || t('附件')) + ']'
          return ''
        }).filter(Boolean).join('\n')
      }
      for (var entry of snapshot.entries) {
        var event = entry.event
        // Surface replacements compact model context; the user's transcript
        // retains the original append, matching the conversation view.
        if (event.surfaceOp && event.surfaceOp !== 'append') continue
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          var message = event.type === 'user/message' ? event.data : event.data.message
          var text = contentText(message?.content)
          if (text) rows.push({ role: event.type === 'user/message' ? t('用户') : t('助手'), text: text })
        } else if (event.type === 'assistant/live-chunk' && event.data.chunk.type === 'text-delta') {
          var row = live.get(event.data.attemptId)
          if (!row) { row = { role: t('助手'), text: '' }; live.set(event.data.attemptId, row); rows.push(row) }
          row.text += event.data.chunk.text
        }
      }
      for (var pending of binding.session.getSnapshot().pendingSubmissions || []) {
        if (pending.placement === 'transcript' && pending.text) rows.push({ role: t('用户'), text: pending.text })
      }
      return rows.map(function (row) { return '## ' + row.role + '\n\n' + row.text }).join('\n\n')
    }

    function hasSelection() {
      if (window.__DSH_TERMINAL_EDIT__) return window.__DSH_TERMINAL_EDIT__.hasSelection()
      var selection = window.getSelection()
      return selection !== null && String(selection).length > 0
    }

    /**
     * The 编辑 menu.
     *
     * `cut`, `copy`, and `paste` act on whatever the app has focused. Their
     * enablement is derived from live state, so the menu is rebuilt each time it
     * opens (see {@link TitleBar}'s `editItems`).
     *
     * @returns the menu items.
     */
    function editItems(canPaste, canEdit) {
      return [
        { id: 'cut', label: t('剪切'), icon: h(CutIcon), shortcut: { keys: ['Ctrl', '+', 'X'], aria: 'Control+X' }, disabled: !canEdit },
        { id: 'copy', label: t('复制'), icon: h(IconCopy), shortcut: { keys: ['Ctrl', '+', 'C'], aria: 'Control+C' }, disabled: !canEdit },
        { id: 'paste', label: t('粘贴'), icon: h(PasteIcon), shortcut: { keys: ['Ctrl', '+', 'V'], aria: 'Control+V' }, disabled: !canPaste },
      ]
    }

    /**
     * The 会话 menu: the current session's own actions, matching what the
     * sidebar's session row offers.
     *
     * The LAST item is this project's own addition, below a separator: `reveal`
     * opens the session's directory. It is a SUBMENU — labelled 打开… — whose
     * entries are the applications the host resolved, reproduced from the app's own
     * session-header menu (`dsh-client-ui-open-in-app`): same catalog, same order,
     * same labels, same icons. See {@link openSubmenuItems}.
     *
     * Its directory is the session's WORKSPACE's — the app itself defines a
     * session's directory that way (`buildGroup(…, workspace.path, …)` in
     * `dsh-client-ui-workspace`), and a session summary carries no `cwd` for the
     * UI to read. It is therefore disabled exactly when 项目's own directory
     * actions are, which needs no second lookup.
     *
     * @param hasCurrent - whether a session is selected.
     * @param canReveal - whether that session's workspace has a directory.
     * @param apps - the resolved applications, or null before the first read.
     * @returns the menu items.
     */
    function sessionItems(hasCurrent, canReveal, apps) {
      var submenu = openSubmenuItems(apps)
      return [
        { id: 'rename', label: t('重命名'), icon: h(IconEdit), disabled: !hasCurrent },
        { id: 'archive', label: t('归档'), icon: h(IconArchive, { size: 16 }), disabled: !hasCurrent },
        { id: 'fork', label: t('分叉会话'), icon: h(IconBranch), disabled: !hasCurrent },
        { id: 'copy-session', label: t('复制...'), icon: h(IconCopy), disabled: !hasCurrent, submenu: [
          { id: 'copy-link', label: t('复制深度链接'), icon: h(IconLink) },
          { id: 'copy-content', label: t('复制会话内容'), icon: h(IconCopy) },
          { id: 'save-content', label: t('保存会话内容'), icon: h(IconDownload) },
        ] },
        // The app's own `Separator` item type, which renders the same hairline
        // divider its menus use above a footer.
        { type: 'separator', id: 'reveal-separator' },
        {
          id: 'reveal',
          label: t('打开…'),
          icon: h(IconFolderOpen),
          // Disabled when there is no directory, AND when the host resolved no
          // application: a submenu parent with nothing under it would open onto an
          // empty list, which reads as broken rather than as unavailable.
          disabled: !canReveal || submenu.length === 0,
          submenu: submenu,
        },
      ]
    }

    /**
     * The 打开… submenu: one entry per application the host resolved.
     *
     * THE APP'S OWN MENU, REPRODUCED. This is deliberately a copy of what
     * `dsh-client-ui-open-in-app` renders in the session header, because the
     * request is that its menu appear here unchanged:
     *
     *   - the app's `Menu` primitive builds the submenu from this array, so the
     *     nested list gets the app's own positioning, styling, hover behaviour and
     *     keyboard contract rather than a lookalike;
     *   - each entry carries the app's real application icon, served by the host's
     *     own icon route (`/open-in-app/icon/<id>`) — the same PNG the app's menu
     *     shows, not a substitute glyph;
     *   - the labels come from {@link APP_LABELS}, the app's own dictionary;
     *   - the order is the host's own (its resolution map's keys), which is the
     *     order the app's menu lists them in.
     *
     * `selectedId` marks the first entry, matching what the app's own split button
     * launches on a plain click — see {@link currentAppId}.
     *
     * @param apps - the resolved applications, or null before the first read.
     * @returns the submenu entries.
     */
    function openSubmenuItems(apps) {
      if (apps === null) return []
      var out = []
      for (var i = 0; i < apps.length; i += 1) {
        out.push({
          id: apps[i].id,
          label: apps[i].label,
          icon: h('img', {
            src: appIconUrl(apps[i].id),
            width: 18,
            height: 18,
            alt: '',
            'aria-hidden': 'true',
            draggable: false,
            style: { objectFit: 'contain', userSelect: 'none', display: 'block', flex: 'none' },
            // The app's own fallback: an icon the host cannot serve would otherwise
            // leave an empty slot, so a transparent pixel keeps the label aligned.
            onError: function (event) {
              event.target.style.visibility = 'hidden'
            },
          }),
        })
      }
      return out
    }

    /**
     * The 项目 menu: actions on the current project, matching the sidebar's
     * workspace row plus its new-session button.
     *
     * `reveal` is this project's own addition, placed last below a separator so it
     * cannot be mistaken for one of the destructive or session-creating actions
     * above it.
     *
     * @param hasProject - whether a project is available.
     * @param canReveal - whether that project has a directory to open.
     * @returns the menu items.
     */
    function projectItems(hasProject, canReveal) {
      return [
        { id: 'new-session', label: t('新建会话'), icon: h(IconNewChat), disabled: !hasProject },
        { id: 'rename', label: t('编辑项目'), icon: h(IconEdit), disabled: !hasProject },
        // `danger` is the Menu primitive's own flag, rendering the label in the
        // app's danger colour — the same treatment 删除工作区 gets in the sidebar.
        { id: 'delete', label: t('删除项目'), icon: h(IconTrash), danger: true, disabled: !hasProject },
        { type: 'separator', id: 'reveal-separator' },
        { id: 'reveal', label: t('在资源管理器打开'), icon: h(IconFolderOpen), disabled: !canReveal },
      ]
    }

    /** The 更多 menu contains appearance, settings, updates and about. */
    function updateLabel(update) {
      if (update.busy === 'check') return t('正在检测 dsh 更新…')
      if (update.busy) return t('正在更新 dsh…')
      if (update.error) return update.versions ? t('dsh 更新失败') : t('dsh 检测失败')
      var versions = update.versions
      if (!versions) return t('检测dsh更新')
      if (versions.current === versions.latest) return t('dsh 已是最新版')
      if (versions.current === versions.preview) return t('dsh 已是最新预览版')
      return t('dsh 可更新')
    }

    function moreItems(mode) {
      var vanilla = mode === 'vanilla'
      return [
        {
          id: 'toggle-styles',
          label: vanilla ? t('切换新样式') : t('切换成原版'),
          icon: h(vanilla ? IconStyles : IconRestore),
        },
        { id: 'settings', label: t('设置'), icon: h(IconSettings) },
        { id: 'dsh-update', label: t('检测更新...'), icon: h(IconRestore) },
        { id: 'about', label: t('关于'), icon: h(IconQuestion) },
      ]
    }

    /**
     * Open the app's settings panel.
     *
     * The current shell publishes its shared store on `sidebar.settings`.
     * Resolve it on each invocation so HMR cannot leave a stale store here.
     * Older shells keep local open state and expose only the trigger button.
     *
     * @returns whether the settings shell or its legacy trigger was opened.
     */
    function openSettings(ctx) {
      var entry = ctx.slots.entriesOfSlot('sidebar.settings')[0]
      var shell = entry?.store?.create?.()
      if (typeof shell?.actions?.open === 'function') {
        shell.actions.open()
        return true
      }
      var trigger = document.querySelector('button[aria-haspopup="dialog"]')
      if (trigger === null) return false
      trigger.click()
      return true
    }

    /**
     * Open one directory in Windows Explorer.
     *
     * REUSES THE APP'S OWN LAUNCHER rather than spawning anything ourselves. DSH
     * ships `dsh-host-open-in-app`, which resolves a catalog of installed
     * applications to verified launchers and exposes them as web routes; `explorer`
     * is one of its entries. Verified live against this installation:
     *
     *     GET  /open-in-app/apps  ->  {"apps":["explorer","cursor","vscode","intellij"]}
     *     POST /open-in-app/open      {app: "explorer", path: "<absolute dir>"}
     *
     * Driving that route means: no new Rust command, no new Tauri permission, and
     * no second launcher implementation to keep in step with the app's. It also
     * inherits the app's own guards — the route sits behind `requestRejection`
     * (Host/Origin fence plus browser authentication) and validates the body at the
     * wire, refusing a relative path or a directory that does not exist.
     *
     * A relative-path POST is issued from the same origin the app is served from,
     * so the route's own Origin check passes without any extra header.
     *
     * @param ctx - the client context, for the logger.
     * @param appId - a catalog id the host resolved (`explorer`, `cursor`, …).
     * @param path - the absolute directory to open.
     * @returns a promise settled when the request completes.
     */
    function openWithApp(ctx, appId, path) {
      if (typeof path !== 'string' || path === '') return Promise.resolve(false)

      var attempt = { source: 'titlebar', kind: 'launch', app: appId, path: path }
      return fetch('/open-in-app/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: appId, path: path }),
      }).then(
        function (response) {
          if (response.ok) {
            reportDiag(ctx, Object.assign({}, attempt, { ok: true, status: response.status }))
            // The shell launched the folder — but for an already-open directory it
            // re-focuses the EXISTING frame, which was observed stuck hidden, so
            // the launch succeeded and nothing appeared. The host finds the frame
            // by the folder's name and shows it; a fresh window needs no help and
            // the command answers false. Best-effort: the launch itself worked.
            invokeHost('focus_folder_window', { path: path }).catch(function () {})
            return true
          }
          // A non-OK answer is the app refusing the launch (an unavailable
          // launcher, or a path it will not open). The body carries the reason as
          // JSON — read it so the report names the cause, and fall back to the
          // status when the body will not parse. Surfaced through the overlay's
          // toast channel as well as the log: a launch that answers 404 for a
          // directory that no longer exists used to close the menu and do nothing
          // else, which reads as a dead button rather than as a refusal.
          response
            .json()
            .then(
              function (payload) {
                var message = payload && payload.message ? payload.message : 'HTTP ' + response.status
                reportLaunchFailure(ctx, path, message)
                reportDiag(ctx, Object.assign({}, attempt, { ok: false, status: response.status, message: message }))
              },
              function () {
                reportLaunchFailure(ctx, path, 'HTTP ' + response.status)
                reportDiag(ctx, Object.assign({}, attempt, { ok: false, status: response.status }))
              },
            )
          return false
        },
        function (error) {
          reportLaunchFailure(ctx, path, error)
          reportDiag(ctx, Object.assign({}, attempt, { ok: false, error: String(error) }))
          return false
        },
      )
    }

    /**
     * The title-bar build marker, carried on every diagnostics line — the log
     * alone must be able to answer which code the page was running when the
     * user clicked, so a stale page is ruled out rather than argued about.
     */
    var DIAG_VERSION = 'titlebar-diag1'

    /**
     * Append one diagnostics line to the host's log, via `/__dsh-desktop/diag`.
     *
     * Fire-and-forget and fully guarded: diagnostics must never become the
     * failure they exist to record, and a plain browser without the route loses
     * nothing but the log line.
     *
     * @param ctx - the client context, for the logger.
     * @param payload - the facts about one attempt.
     */
    function reportDiag(ctx, payload) {
      try {
        var body = JSON.stringify(
          Object.assign({ v: DIAG_VERSION, at: new Date().toISOString() }, payload),
        )
        fetch('/__dsh-desktop/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
        }).catch(function () {
          /* No route, no fence pass: diagnostics stay silent. */
        })
      } catch (error) {
        reportFailure(ctx, 'report diagnostics', error)
      }
    }

    /** Open a directory in Explorer — the one-click form of {@link openWithApp}. */
    function openInExplorer(ctx, path) {
      return openWithApp(ctx, 'explorer', path)
    }

    /**
     * The catalog ids whose labels this bar can render, in the app's own order.
     *
     * MIRRORS THE APP'S `APP_LABEL_KEY` MAP rather than asking for it, and the
     * duplication is forced: that map lives inside the app's own client bundle as
     * a module-private constant, with no service or slot that publishes it. What it
     * buys is the app's behaviour — an id the browser cannot name stays invisible
     * instead of rendering as a raw id, which is why this is a map and not a
     * passthrough of whatever the host answered.
     *
     * Keep in sync with `dsh-client-ui-open-in-app`'s `APP_LABEL_KEY`. An id the
     * app gains and this map lacks degrades to "not offered in the submenu", never
     * to a wrong label.
     */
    var APP_LABELS = {
      get explorer() { return t('文件资源管理器') },
      cursor: 'Cursor',
      vscode: 'VS Code',
      vscodeinsiders: 'VS Code Insiders',
      windsurf: 'Windsurf',
      zed: 'Zed',
      sublimetext: 'Sublime Text',
      intellij: 'IntelliJ IDEA',
      pycharm: 'PyCharm',
      webstorm: 'WebStorm',
      phpstorm: 'PhpStorm',
      goland: 'GoLand',
      rider: 'Rider',
      rustrover: 'RustRover',
      fork: 'Fork',
      sourcetree: 'Sourcetree',
      github: 'GitHub Desktop',
      tower: 'Tower',
      gitkraken: 'GitKraken',
      smartgit: 'SmartGit',
      sublimemerge: 'Sublime Merge',
      windowsterminal: 'Windows Terminal',
      gitbash: 'Git Bash',
    }

    /**
     * Read the applications the host resolved as installed.
     *
     * The same route the app's own session-header menu reads, so the submenu offers
     * exactly the applications that menu offers — and in the same order, which is
     * the catalog's own (the host answers the resolution map's keys).
     *
     * Named apps only, and never rejects: a failed or empty read yields an empty
     * list, and the caller then offers no submenu rather than an empty one.
     *
     * @returns a promise for the labelled applications.
     */
    function fetchOpenApps() {
      return fetch('/open-in-app/apps', { headers: { accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) return []
          return response.json()
        })
        .then(function (payload) {
          var ids = payload && Array.isArray(payload.apps) ? payload.apps : []
          return ids
            .filter(function (id) { return Object.prototype.hasOwnProperty.call(APP_LABELS, id) })
            .map(function (id) { return { id: id, label: APP_LABELS[id] } })
        })
        .catch(function () {
          // A host without the capability, or a transient failure: no submenu.
          return []
        })
    }

    /** The icon URL the app serves for one catalog id. */
    function appIconUrl(appId) {
      return '/open-in-app/icon/' + appId
    }

    /**
     * A small text-entry dialog, used for renaming a session or a project.
     *
     * Built on the app's own `Modal` and `Input`, so the surface, focus trapping,
     * Escape handling, and styling are the app's rather than a lookalike.
     *
     * @param props - dialog state and handlers.
     * @returns the dialog element.
     */
    function RenameDialog(props) {
      useLocale(React)
      var value = typeof props.value === 'string' ? props.value : ''
      var setValue = props.onChange
      var trimmed = value.trim()
      var blocked = trimmed === '' || trimmed === props.initial || props.pending

      /**
       * Submit on Enter, so the dialog behaves like the app's own rename field.
       *
       * @param event - the key event.
       */
      function onKeyDown(event) {
        if (event.key === 'Enter' && !blocked) {
          event.preventDefault()
          props.onConfirm(trimmed)
        }
      }

      return h(
        Modal,
        {
          open: props.open,
          onClose: props.onCancel,
          title: props.title,
          closeLabel: t('关闭'),
          footer: h(
            React.Fragment,
            null,
            h(Button, { variant: 'outline', onClick: props.onCancel }, t('取消')),
            h(
              Button,
              { variant: 'primary', disabled: blocked, onClick: function () { props.onConfirm(trimmed) } },
              t('确定'),
            ),
          ),
        },
        h('div', { className: 'dshTb__dialogField' },
          h(Input, {
            value: value,
            onChange: function (event) { setValue(event.target.value) },
            onKeyDown: onKeyDown,
            autoFocus: true,
            'aria-label': props.title,
          }),
          props.error ? h('div', { className: 'dshTb__dialogError' }, props.error) : null,
        ),
      )
    }

    /**
     * The 关于 dialog: what this window is, and which build is running.
     *
     * Built on the app's own `Modal` for the same reason the rename dialog is —
     * the surface, focus trapping, Escape handling, and palette are the app's,
     * so the dialog reads as part of the interface rather than as a card bolted
     * onto it. Simple by request: the mark, the name, the version, one line of
     * what the app is, and a close button.
     *
     * The version arrives already read (`appVersion`): `null` hides the row
     * entirely rather than showing a placeholder, because a dialog about the
     * build must not claim a build it cannot name.
     *
     * @param props - dialog state and handlers.
     * @returns the dialog element.
     */
    function AboutDialog(props) {
      useLocale(React)
      return h(
        Modal,
        {
          open: props.open,
          onClose: props.onClose,
          title: t('关于'),
          closeLabel: t('关闭'),
          footer: h(Button, { variant: 'primary', onClick: props.onClose }, t('关闭')),
        },
        h(
          'div',
          { className: 'dshTb__about' },
          h(
            'div',
            { className: 'dshTb__aboutHead' },
            h('div', { className: 'dshTb__aboutMark' }, h(Logo)),
            h(
              'div',
              { className: 'dshTb__aboutIdent' },
              h('div', { className: 'dshTb__aboutName' }, 'dsh desktop'),
              props.version
                ? h('div', { className: 'dshTb__aboutVersion' }, t('版本 ') + props.version)
                : null,
            ),
          ),
          h(
            'p',
            { className: 'dshTb__aboutText' },
            t('DeepSeek Harness（dsh）的 Windows 桌面外壳：把 dsh 的网页界面嵌进独立窗口，并在任务需要你时发出通知。'),
          ),
        ),
      )
    }

    function DshUpdateFooter(props) {
      var update = props.update
      var versions = update.versions
      var sameVersion = versions && versions.latest === versions.preview
      var blocked = Boolean(update.busy) || !versions
      return h(React.Fragment, null,
          h(Button, {
            variant: 'primary',
            disabled: blocked || versions.current === versions.latest,
            onClick: function () { props.onInstall('latest') },
          }, t('最新稳定版')),
          sameVersion ? null : h(Button, {
            variant: 'outline',
            disabled: blocked || versions.current === versions.preview,
            onClick: function () { props.onInstall('preview') },
          }, t('最新预览版')),
      )
    }

    function DshUpdatePanel(props) {
      var update = props.update
      var versions = update.versions
      var sameVersion = versions && versions.latest === versions.preview
      return h('div', { className: 'dshTb__dialogField dshTb__update', 'aria-busy': Boolean(update.busy) },
        h('div', { className: 'dshTb__updateHeader' },
          h('div', { role: 'status', 'aria-live': 'polite' }, updateLabel(update)),
          h(Button, { variant: 'outline', className: 'dshTb__recheck', disabled: Boolean(update.busy), onClick: props.onCheck }, t('重新检测')),
        ),
        versions ? h('dl', { className: 'dshTb__versions' },
          h('dt', null, t('当前版本')),
          h('dd', null, h('code', { className: 'dshTb__versionTag' }, versions.current)),
          h('dt', null, t('最新稳定版'), h('span', { className: 'dshTb__recommendation' }, t('推荐'))),
          h('dd', null, h('code', { className: 'dshTb__versionTag' }, versions.latest)),
          sameVersion ? null : h(React.Fragment, null,
            h('dt', null, t('最新预览版')),
            h('dd', null, h('code', { className: 'dshTb__versionTag' }, versions.preview)),
          ),
        ) : null,
        update.busy && update.busy !== 'check'
          ? h('p', { className: 'dshTb__aboutText' }, t('正在安装') + (update.busy === 'latest' ? t('最新稳定版') : t('最新预览版')) + t('，请稍候…'))
          : null,
        update.message ? h('p', { className: 'dshTb__aboutText', role: 'status' }, update.message) : null,
        update.error ? h('div', { className: 'dshTb__dialogError dshTb__updateError', role: 'alert' }, update.error) : null,
      )
    }

    function desktopUpdateLabel(update) {
      if (update.busy === 'check') return t('正在检测软件更新…')
      if (update.error) return t('软件更新检测失败')
      if (!update.result) return t('检测软件更新')
      if (!update.result.release) return t('暂无已发布版本')
      return update.result.release.updateAvailable ? t('发现新版本') : t('当前已是最新版本')
    }

    function DesktopUpdatePanel(props) {
      var update = props.update
      var result = update.result
      var release = result && result.release
      var date = release && release.publishedAt ? new Date(release.publishedAt) : null
      var published = date && !Number.isNaN(date.getTime())
        ? date.toLocaleDateString(window.__DSH_I18N__?.locale || 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }) : null
      return h('div', { className: 'dshTb__dialogField dshTb__desktopUpdate', 'aria-busy': update.busy === 'check' },
        h('div', { className: 'dshTb__desktopStatus' },
          h('div', { className: 'dshTb__aboutMark', 'aria-hidden': 'true' }, h(Logo)),
          h('div', { className: 'dshTb__desktopStatusText' },
            h('strong', { role: 'status', 'aria-live': 'polite' }, desktopUpdateLabel(update)),
            h('span', null, 'dsh desktop'),
          ),
        ),
        h('dl', { className: 'dshTb__versions dshTb__desktopVersions' },
          h('dt', null, t('当前版本')),
          h('dd', null, h('code', { className: 'dshTb__versionTag' }, result ? result.current : props.version || '—')),
          h('dt', null, t('最新版本')),
          h('dd', null, release ? h(React.Fragment, null,
            h('code', { className: 'dshTb__versionTag' }, release.version),
            release.prerelease ? h('span', { className: 'dshTb__recommendation' }, t('预览版')) : null,
          ) : '—'),
          published ? h(React.Fragment, null, h('dt', null, t('发布时间')), h('dd', null, published)) : null,
        ),
        update.error ? h('div', { className: 'dshTb__dialogError dshTb__updateError', role: 'alert' }, t(update.error)) : null,
        update.openError ? h('div', { className: 'dshTb__dialogError dshTb__updateError', role: 'alert' }, t(update.openError)) : null,
        release ? h('section', { className: 'dshTb__releaseNotes', 'aria-label': t('更新说明') },
          h('div', { className: 'dshTb__releaseHeading' }, h('h3', null, t('更新说明')), h('span', null, release.name)),
          h('div', { className: 'dshTb__releaseBody', tabIndex: 0 },
            release.notes && primitives.MarkdownText ? h(primitives.MarkdownText, {
              text: release.notes, variant: 'compact', labels: { code: { copyLabel: t('复制'), copiedLabel: t('已复制') }, footnotes: t('脚注') },
            }) : h('p', { className: 'dshTb__releasePlain' }, release.notes || t('此版本未提供更新说明。')),
          ),
        ) : h('p', { className: 'dshTb__aboutText' }, update.busy === 'check'
          ? t('正在获取最新发布信息…') : t('软件版本信息来自 GitHub Releases。')),
      )
    }

    function UpdateDialog(props) {
      useLocale(React)
      var desktop = props.tab === 'desktop'
      var release = props.desktopUpdate.result && props.desktopUpdate.result.release
      var tabs = [
        { id: 'desktop', label: t('软件更新'), busy: props.desktopUpdate.busy === 'check', available: !props.desktopUpdate.error && release && release.updateAvailable },
        { id: 'dsh', label: t('dsh 更新'), busy: Boolean(props.update.busy), available: !props.update.error && props.update.versions && props.update.versions.current !== props.update.versions.latest && props.update.versions.current !== props.update.versions.preview },
      ]
      function onTabKey(event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        var next = event.key === 'Home' ? 'desktop' : event.key === 'End' ? 'dsh' : desktop ? 'dsh' : 'desktop'
        props.onTab(next)
        document.getElementById('dsh-update-tab-' + next)?.focus()
      }
      return h(Modal, {
        open: true, onClose: props.onClose, title: t('检测更新'), closeLabel: t('关闭窗口'),
        className: 'dshTb__updateDialog', contentClassName: 'dshTb__updateContent',
        footer: desktop ? h(React.Fragment, null,
          h('span', { className: 'dshTb__updateSource' }, 'GitHub Releases'),
          h(Button, { variant: 'outline', disabled: Boolean(props.desktopUpdate.busy), onClick: props.onCheckDesktop }, t('重新检测')),
          release ? h(Button, { variant: release.updateAvailable ? 'primary' : 'outline', disabled: Boolean(props.desktopUpdate.busy), onClick: props.onOpenRelease },
            props.desktopUpdate.busy === 'open' ? t('正在打开…') : release.updateAvailable ? t('前往下载') : t('查看发布页')) : null,
        ) : h(DshUpdateFooter, { update: props.update, onInstall: props.onInstall }),
      },
        h('div', { className: 'dshTb__updateTabs', role: 'tablist', 'aria-label': t('更新组件') }, tabs.map(function (tab) {
          return h('button', {
            key: tab.id, type: 'button', role: 'tab', id: 'dsh-update-tab-' + tab.id,
            'aria-controls': 'dsh-update-panel-' + tab.id, 'aria-selected': props.tab === tab.id,
            tabIndex: props.tab === tab.id ? 0 : -1, 'data-modal-autofocus': props.tab === tab.id ? '' : undefined,
            className: 'dshTb__updateTab', onClick: function () { props.onTab(tab.id) }, onKeyDown: onTabKey,
          }, tab.label, tab.busy ? h('span', { className: 'dshTb__updateSpinner', role: 'img', 'aria-label': t('检测中') })
            : tab.available ? h('span', { className: 'dshTb__updateDot', role: 'img', 'aria-label': t('有可用更新') }) : null)
        })),
        h('div', { role: 'tabpanel', id: 'dsh-update-panel-desktop', 'aria-labelledby': 'dsh-update-tab-desktop', hidden: !desktop, tabIndex: 0 },
          desktop ? h(DesktopUpdatePanel, { update: props.desktopUpdate, version: props.version }) : null),
        h('div', { role: 'tabpanel', id: 'dsh-update-panel-dsh', 'aria-labelledby': 'dsh-update-tab-dsh', hidden: desktop, tabIndex: 0 },
          desktop ? null : h(DshUpdatePanel, { update: props.update, onCheck: props.onCheck })),
      )
    }

    /** Browser-only drawer dismissal and the selected Session's loading state. */
    function RemotePageChrome(props) {
      useLocale(React)
      var ctx = props.ctx
      var frameState = React.useState(null)
      var frame = frameState[0]
      var setFrame = frameState[1]
      var loadingState = React.useState(false)
      var loading = loadingState[0]
      var setLoading = loadingState[1]

      function closeDrawer(restoreFocus) {
        var layer = document.querySelector('[data-shell-overlay]')
        var currentFrame = layer && layer.parentElement
        if (!currentFrame || currentFrame.hasAttribute('data-sidebar-collapsed')) return
        if (!ctx.layout || typeof ctx.layout.toggleSidebar !== 'function') return
        ctx.layout.toggleSidebar()
        if (restoreFocus) document.querySelector('.dshTb__mark')?.focus()
      }

      React.useEffect(function () {
        var layer = document.querySelector('[data-shell-overlay]')
        setFrame(layer && layer.parentElement)

        // Use the Controller's lifecycle, including cached, failed and superseded
        // opens. A timer would hide the spinner while slow history is still loading.
        var currentId
        var currentSession
        var releaseSession
        var sessions = ctx.sessions
        function syncSession() {
          var id = currentSessionId(sessions.list.getSnapshot())
          var binding = id ? sessions.binding(id) : null
          var session = binding && binding.session
          if (id !== currentId) {
            currentId = id
            closeDrawer(false)
          }
          if (session !== currentSession) {
            if (typeof releaseSession === 'function') releaseSession()
            currentSession = session
            var syncLoading = function () {
              if (currentSession !== session) return
              var snapshot = session && session.getSnapshot()
              setLoading(Boolean(snapshot && !snapshot.removed &&
                (snapshot.openState === 'cold' || snapshot.openState === 'loading')))
            }
            releaseSession = session ? session.subscribe(syncLoading) : undefined
            syncLoading()
          }
        }
        var releaseList = sessions.list.subscribe(syncSession)
        syncSession()

        // Re-selecting the current row need not emit a list change. Wait until
        // its existing React click has run before collapsing (and unmounting) it.
        var closeTimer
        function onClick(event) {
          var target = event.target
          if (!target || typeof target.closest !== 'function') return
          var row = target.closest('[role="treeitem"][class*="_sessionRow"]')
          if (!row || !row.closest('[class*="_sidebarCol"]')) return
          if (target.closest('button, a, input, [role="button"], [role="menu"]')) return
          clearTimeout(closeTimer)
          closeTimer = setTimeout(function () { closeDrawer(false) }, 0)
        }
        function onKeyDown(event) {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          if (document.querySelector('[role="dialog"], [role="menu"]:not([data-dsh-ghost])')) return
          closeDrawer(true)
        }
        document.addEventListener('click', onClick)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          if (typeof releaseList === 'function') releaseList()
          if (typeof releaseSession === 'function') releaseSession()
          clearTimeout(closeTimer)
          document.removeEventListener('click', onClick)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [])

      if (!frame) return null
      return reactDom.createPortal(h(React.Fragment, null,
        h('button', {
          type: 'button', className: 'dshMobile__backdrop',
          'aria-label': t('关闭左侧侧边栏'),
          onClick: function () { closeDrawer(true) },
        }),
        loading ? h('div', {
          className: 'dshMobile__sessionLoading', role: 'status',
          'aria-live': 'polite', 'aria-busy': 'true',
        }, h('span', { className: 'dshMobile__spinner', 'aria-hidden': 'true' }),
        h('span', null, t('正在加载会话…'))) : null,
      ), frame)
    }

    /**
     * The title bar.
     *
     * @param props - the slot props plus the client context.
     * @returns the bar element.
     */
    function TitleBar(props) {
      useLocale(React)
      var ctx = props.ctx

      // `null` means "no menu open"; the string names which one is open, so the
      // Menu primitive's own selected-state logic can compare ids.
      var openState = React.useState(null)
      var openMenu = openState[0]
      var setOpenMenu = openState[1]

      var maximizedState = React.useState(false)
      var maximized = maximizedState[0]
      var setMaximized = maximizedState[1]

      var pasteState = React.useState(false)
      var canPaste = pasteState[0]
      var setCanPaste = pasteState[1]

      /**
       * The UI mode, so the 更多 menu can label the switch by its direction.
       *
       * Seeded from the document rather than from a settings read: the attribute
       * is already correct before first paint (the host half sets it), and it is
       * what the page is actually showing — which is what the label must describe.
       */
      var modeState = React.useState(readUiMode)
      var uiMode = modeState[0]
      var setUiMode = modeState[1]

      /**
       * The title-bar mode and icon-hover preference, for the same reason: the
       * host half writes both attributes before first paint, so the document is
       * the thing actually being rendered and the seed cannot be stale. Both
       * follow their announcement events afterwards — see the effect below.
       */
      var titlebarModeState = React.useState(readTitlebarMode)
      var titlebarMode = titlebarModeState[0]
      var setTitlebarMode = titlebarModeState[1]

      var titlebarHoverState = React.useState(readTitlebarHover)
      var titlebarHover = titlebarHoverState[0]
      var setTitlebarHover = titlebarHoverState[1]

      // Bumped whenever the services report a change, so the menu items are
      // rebuilt against fresh state rather than a snapshot from first render.
      var revisionState = React.useReducer(function (n) { return n + 1 }, 0)
      var bumpRevision = revisionState[1]

      var renameState = React.useState(null)
      var rename = renameState[0]
      var setRename = renameState[1]
      var renameValueState = React.useState('')
      var renameValue = renameValueState[0]
      var setRenameValue = renameValueState[1]
      var renameErrorState = React.useState(null)
      var renameError = renameErrorState[0]
      var setRenameError = renameErrorState[1]
      var renamePendingState = React.useState(false)
      var renamePending = renamePendingState[0]
      var setRenamePending = renamePendingState[1]

      var confirmState = React.useState(null)
      var confirm = confirmState[0]
      var setConfirm = confirmState[1]

      /** Whether the 关于 dialog is on screen. */
      var aboutState = React.useState(false)
      var aboutOpen = aboutState[0]
      var setAboutOpen = aboutState[1]

      var updateState = React.useState({ attempted: false, busy: null, versions: null, error: null, message: null })
      var dshUpdate = updateState[0]
      var setDshUpdate = updateState[1]
      var updateOpenState = React.useState(false)
      var updateOpen = updateOpenState[0]
      var setUpdateOpen = updateOpenState[1]
      // Block repeated clicks before React has committed the disabled state.
      var updatePending = React.useRef(false)
      var updateCapture = React.useRef(false)
      var desktopUpdateState = React.useState({ busy: null, result: null, error: null })
      var desktopUpdate = desktopUpdateState[0]
      var setDesktopUpdate = desktopUpdateState[1]
      var desktopUpdatePending = React.useRef(false)
      var updateTabState = React.useState('desktop')
      var updateTab = updateTabState[0]
      var setUpdateTab = updateTabState[1]
      var updateVisible = React.useRef(false)

      // ---- the theme switch (remote page) ----------------------------------

      /**
       * The preference the switch cycles, including system as a distinct state.
       *
       * Seeded from the theme owner and kept current by the same `theme/change`
       * event the appearance section reads — `ThemeRuntime` has no subscription
       * of its own by design, so the event is the only continuous feed.
       */
      var themeState = React.useState(readThemePreference)
      var themePreference = themeState[0]
      var setThemePreference = themeState[1]

      /**
       * Preserve system even when its resolved palette is light or dark.
       * @returns the preference, falling back to a registered theme's palette.
       */
      function readThemePreference() {
        try {
          var snapshot = ctx.theme && typeof ctx.theme.getTheme === 'function' ? ctx.theme.getTheme() : null
          var value = snapshot && snapshot.preference
          if (value === 'system' || value === 'light' || value === 'dark') return value
          var scheme = snapshot && snapshot.active && snapshot.active.colorScheme
          if (scheme === 'light' || scheme === 'dark') return scheme
        } catch (error) {
          // System is also the theme owner's default.
        }
        return 'system'
      }

      function nextTheme(preference) {
        return preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system'
      }

      React.useEffect(function () {
        if (!ctx.theme) return undefined
        var sync = function () {
          setThemePreference(readThemePreference())
        }
        var disposer = typeof ctx.on === 'function' ? ctx.on('theme/change', sync) : undefined
        sync()
        return function () {
          if (typeof disposer === 'function') disposer()
        }
      }, [])

      /**
       * Cycle system → light → dark → system through the theme owner. The
       * remote theme adapter keeps its preference in this browser's storage.
       */
      function toggleTheme() {
        var theme = ctx.theme
        if (!theme || typeof theme.setTheme !== 'function') return
        try {
          theme.setTheme(nextTheme(readThemePreference()))
          setThemePreference(readThemePreference())
        } catch (error) {
          reportFailure(ctx, 'switch the theme', error)
        }
      }

      async function checkDesktopUpdate() {
        if (desktopUpdatePending.current) return
        desktopUpdatePending.current = true
        setDesktopUpdate(function (previous) { return { busy: 'check', result: previous.result, error: null } })
        try {
          if (!hasHost()) throw new Error(t('请在当前桌面应用中检测软件更新。'))
          var result = await invokeHost('check_desktop_update')
          if (!result || !result.current || !Object.prototype.hasOwnProperty.call(result, 'release')) throw new Error(t('未能读取软件版本，请重新检测。'))
          setAppVersion(result.current)
          setDesktopUpdate({ busy: null, result: result, error: null })
        } catch (error) {
          setDesktopUpdate({ busy: null, result: null, error: String((error && error.message) || error) })
        } finally {
          desktopUpdatePending.current = false
        }
      }

      async function openDesktopRelease() {
        var release = desktopUpdate.result && desktopUpdate.result.release
        if (!release || desktopUpdatePending.current) return
        desktopUpdatePending.current = true
        setDesktopUpdate(Object.assign({}, desktopUpdate, { busy: 'open', openError: null }))
        try {
          await invokeHost('open_desktop_release', { url: release.url })
        } catch (error) {
          setDesktopUpdate(function (previous) { return Object.assign({}, previous, { openError: String((error && error.message) || error) }) })
        } finally {
          desktopUpdatePending.current = false
          setDesktopUpdate(function (previous) { return Object.assign({}, previous, { busy: null }) })
        }
      }

      async function checkDshUpdate() {
        if (updatePending.current) return
        updatePending.current = true
        setDshUpdate(function (previous) {
          return { attempted: true, busy: 'check', versions: previous.versions, error: null, message: previous.message }
        })
        try {
          if (!hasHost()) throw new Error(t('请在桌面应用中检测 dsh 更新。'))
          var versions = await invokeHost('check_dsh_update')
          if (!versions || !versions.current || !versions.latest || !versions.preview) throw new Error(t('未能读取 dsh 版本，请重新检测。'))
          setDshUpdate(function (previous) {
            return { attempted: true, busy: null, versions: versions, error: null, message: previous.message }
          })
        } catch (error) {
          setDshUpdate(function (previous) {
            return { attempted: true, busy: null, versions: null, error: String((error && error.message) || error), message: previous.message }
          })
        } finally {
          updatePending.current = false
        }
      }

      async function installDshUpdate(channel) {
        if (updatePending.current || !dshUpdate.versions || !['latest', 'preview'].includes(channel)) return
        if (channel === 'preview' && dshUpdate.versions.latest === dshUpdate.versions.preview) return
        if (dshUpdate.versions.current === dshUpdate.versions[channel]) return
        updatePending.current = true
        var previousVersions = dshUpdate.versions
        setDshUpdate({ attempted: true, busy: channel, versions: previousVersions, error: null, message: null })
        var bridge = window.__DSH_UI_STATE__
        try {
          if (!hasHost()) throw new Error(t('请在桌面应用中安装 dsh 更新。'))
          if (!bridge?.prepareRemoteApply) throw new Error(t('页面保存服务尚未准备好，请稍后重试'))
          var identity = window.__DSH_REMOTE_IDENTITY__
          var status = await invokeHost('remote_status', { identity: identity })
          updateCapture.current = true
          var payload = await bridge.prepareRemoteApply(status.frontendVersion, t('正在保存界面并更新 dsh…'))
          var request = { channel: channel, identity: identity, payload: payload,
            palette: window.__DSH_DESKTOP_BOOT__?.capturePalette() }
          if (channel === 'preview') request.targetVersion = previousVersions.preview
          await invokeHost('install_dsh_update', request)
          // The host now owns the snapshot and navigates to its install page.
          // Keep input frozen until the new backend restores this document.
        } catch (error) {
          bridge?.finishRemoteApply()
          updatePending.current = false
          setDshUpdate({ attempted: true, busy: null, versions: previousVersions, error: String((error && error.message) || error), message: null })
        } finally {
          updateCapture.current = false
        }
      }

      // Export only owned business state. Restoring calls React setters and
      // never runs rename/delete/confirm handlers.
      React.useEffect(function () {
        var bridge = window.__DSH_UI_STATE__
        if (!bridge) return
        return bridge.registerProvider('title-bar', {
          version: 1,
          owns: function (node) {
            return Boolean(node && (node.matches?.('.dshTb__dialogField, .dshTb__about') || node.querySelector?.('.dshTb__dialogField, .dshTb__about')))
          },
          capture: function () {
            if (renamePending || (!updateCapture.current && (updatePending.current || desktopUpdatePending.current))) throw new Error('snapshot-input-busy')
            setOpenMenu(null)
            if (!rename && !confirm && !aboutOpen && (!dshUpdate.attempted || updateCapture.current)) return null
            return { rename: rename, value: renameValue, confirm: confirm, about: aboutOpen,
              update: updateCapture.current ? null : dshUpdate, updateOpen: !updateCapture.current && updateOpen,
              desktopUpdate: updateCapture.current ? null : desktopUpdate, updateTab: updateTab,
              sessionId: currentSessionId(ctx.sessions.list.getSnapshot()) || null }
          },
          restore: function (saved) {
            if (saved.sessionId !== (currentSessionId(ctx.sessions.list.getSnapshot()) || null)) throw new Error('snapshot-session-missing')
            if (saved.rename && !['session', 'project'].includes(saved.rename.kind)) throw new Error('snapshot-form-unsupported')
            setRename(saved.rename); setRenameValue(saved.value); setRenameError(null)
            setConfirm(saved.confirm); setAboutOpen(saved.about)
            if (saved.update) setDshUpdate(saved.update)
            if (saved.desktopUpdate) setDesktopUpdate(saved.desktopUpdate)
            setUpdateTab(saved.updateTab === 'dsh' ? 'dsh' : 'desktop')
            updateVisible.current = Boolean(saved.updateOpen)
            setUpdateOpen(Boolean(saved.updateOpen))
          },
        })
      }, [rename, renameValue, renamePending, confirm, aboutOpen, dshUpdate, updateOpen, desktopUpdate, updateTab])

      /**
       * The app's own version, for the 关于 dialog.
       *
       * `null` means "not read yet"; the read happens once, when the dialog
       * first opens, so a session that never opens the dialog never spends the
       * call. `''` means the read failed or is unavailable (a plain browser has
       * no `__TAURI__`), and the dialog then omits the version row instead of
       * showing a placeholder — a dialog about the build must not claim a build
       * it cannot name.
       */
      var appVersionState = React.useState(null)
      var appVersion = appVersionState[0]
      var setAppVersion = appVersionState[1]

      /**
       * The applications the host resolved, for the 会话 menu's 打开… submenu.
       *
       * `null` means "not read yet", which is what the menu shows before the first
       * open — the read is kicked off when the menu opens, so the bar's own mount
       * costs no request. An empty array means the host resolved nothing, and the
       * submenu is then not offered at all.
       */
      var openAppsState = React.useState(null)
      var openApps = openAppsState[0]
      var setOpenApps = openAppsState[1]

      /**
       * Which application the submenu marks as the current choice.
       *
       * The app's own session-header menu persists this in the browser
       * (`dsh.open-in-app.choice`), but that value is not an input to the LAUNCH:
       * the app passes the chosen id explicitly each time, and a menu that
       * pre-selected a remembered entry would be implying a default this bar does
       * not apply. So the submenu marks the first entry — the same one the app's
       * own split button launches on a plain click — and choosing any entry here
       * opens with that entry, every time.
       */
      function currentAppId() {
        return openApps !== null && openApps.length > 0 ? openApps[0].id : undefined
      }

      // Re-render on any controller change, so 会话/项目 availability follows the
      // app's state instead of freezing at mount.
      React.useEffect(function () {
        var disposers = []
        if (ctx.sessions) disposers.push(ctx.sessions.list.subscribe(bumpRevision))
        if (ctx.workspaces) disposers.push(ctx.workspaces.list.subscribe(bumpRevision))
        return function () {
          for (var i = 0; i < disposers.length; i += 1) disposers[i]()
        }
      }, [])

      // The version is read once, when the dialog first opens — see the state
      // declaration for why a failed read degrades to omitting the row.
      React.useEffect(function () {
        if ((!aboutOpen && !updateOpen) || appVersion !== null) return
        var api = globalThis.__TAURI__
        if (!api || !api.app || typeof api.app.getVersion !== 'function') {
          setAppVersion('')
          return
        }
        api.app.getVersion().then(
          function (version) {
            setAppVersion(String(version || ''))
          },
          function () {
            setAppVersion('')
          },
        )
      }, [aboutOpen, updateOpen, appVersion])

      /**
       * Tell the injected boot bar that the real one is on screen.
       *
       * Runs after the first commit, so the bar it announces has actually
       * rendered. Fire-and-forget: an absent listener means `boot.js` was never
       * injected (a plain browser, or `dom: false`), which is not a condition this
       * bar can or should do anything about.
       */
      React.useEffect(function () {
        // The attribute first: it is the half that survives a missed event.
        document.documentElement.setAttribute(TITLEBAR_READY_ATTRIBUTE, 'ready')
        try {
          document.dispatchEvent(new CustomEvent(TITLEBAR_READY_EVENT))
        } catch {
          // An engine without `CustomEvent` cannot be running this bundle: the
          // overlay itself dispatches one. Nothing to recover from here.
        }
      }, [])

      /**
       * Follow the UI mode, the title-bar mode, and the icon-hover preference
       * announced by the appearance plugin.
       *
       * Listening to the announcements rather than to a click on this bar's own
       * menu items is what keeps the labels honest: all three can also change
       * from the settings document (another window, the 外观 section, or a value
       * edited by hand), and a label must describe what the page is actually
       * showing either way.
       *
       * Each attribute is re-read rather than taken from the event detail, so a
       * label can never disagree with the gate the stylesheet is applying.
       */
      React.useEffect(function () {
        function onModeChange() {
          setUiMode(readUiMode())
        }
        function onTitlebarModeChange() {
          setTitlebarMode(readTitlebarMode())
        }
        function onTitlebarHoverChange() {
          setTitlebarHover(readTitlebarHover())
        }
        document.addEventListener(MODE_CHANGE_EVENT, onModeChange)
        document.addEventListener(TITLEBAR_MODE_CHANGE_EVENT, onTitlebarModeChange)
        document.addEventListener(TITLEBAR_HOVER_CHANGE_EVENT, onTitlebarHoverChange)
        // Also re-read on mount, in case any of the three moved while this bar
        // was unmounted and the announcement was therefore missed.
        onModeChange()
        onTitlebarModeChange()
        onTitlebarHoverChange()
        return function () {
          document.removeEventListener(MODE_CHANGE_EVENT, onModeChange)
          document.removeEventListener(TITLEBAR_MODE_CHANGE_EVENT, onTitlebarModeChange)
          document.removeEventListener(TITLEBAR_HOVER_CHANGE_EVENT, onTitlebarHoverChange)
        }
      }, [])

      /**
       * Keep the maximize glyph in step with the window.
       *
       * Polled on the DOM's `resize` event rather than a Tauri window event: the
       * viewport changes whenever the window is maximized, restored, or snapped,
       * and `resize` needs no permission of its own. A slow interval is layered on
       * top so a state change that does not alter the viewport (maximizing an
       * already-full-width window) is still picked up.
       */
      React.useEffect(function () {
        if (!hasHost()) return undefined
        var cancelled = false

        function sync() {
          invokeHost('window_is_maximized').then(function (value) {
            if (!cancelled && typeof value === 'boolean') setMaximized(value)
          }, function () { /* a failed query leaves the last known value */ })
        }

        sync()
        window.addEventListener('resize', sync)
        var timer = setInterval(sync, 1500)
        return function () {
          cancelled = true
          window.removeEventListener('resize', sync)
          clearInterval(timer)
        }
      }, [])

      /**
       * Refresh whether Paste is available, from the real clipboard.
       *
       * Read on open rather than continuously: the clipboard changes outside this
       * app, and polling it would be both wasteful and a privacy smell.
       */
      function refreshClipboard() {
        if (!hasHost()) {
          setCanPaste(false)
          return
        }
        invokeHost('clipboard_read_text').then(function (text) {
          setCanPaste(typeof text === 'string' && text.length > 0)
        }, function () { setCanPaste(false) })
      }

      /**
       * Open one menu, refreshing the state its items depend on.
       *
       * @param id - which menu to open.
       */
      function openThis(id) {
        refreshClipboard()
        // The 会话 menu's submenu lists the host's applications, so the catalog is
        // read when that menu opens rather than at mount: the bar costs no request
        // until the user asks for something that needs one, and a later change to
        // the installed set is picked up on the next open.
        if (id === 'session') refreshOpenApps()
        setOpenMenu(id)
      }

      /**
       * Read the host's resolved applications, once per open.
       *
       * Written into state only when the answer differs, so an unchanged catalog
       * does not re-render the bar on every menu open.
       */
      function refreshOpenApps() {
        fetchOpenApps().then(function (apps) {
          // Diagnostics: the submenu is offered only when this read answers, so
          // its count in the log explains a missing or disabled 打开… item.
          reportDiag(ctx, { source: 'titlebar', kind: 'catalog', count: apps.length })
          setOpenApps(function (previous) {
            var same =
              previous !== null &&
              previous.length === apps.length &&
              previous.every(function (entry, index) { return entry.id === apps[index].id })
            return same ? previous : apps
          })
        })
      }

      /** Close whichever menu is open. */
      function closeMenu() {
        setOpenMenu(null)
      }

      // ---- the actions -----------------------------------------------------

      /**
       * Copy the current selection.
       *
       * Written from the DOM selection rather than by synthesizing Ctrl+C: the
       * selection is already known here, and this does not depend on which element
       * the OS considers focused after the user clicked the title bar.
       */
      function doCopy() {
        if (window.__DSH_TERMINAL_EDIT__) { window.__DSH_TERMINAL_EDIT__.copy().catch(function (e) { reportFailure(ctx, 'copy', e) }); return }
        var text = String(window.getSelection() || '')
        if (text === '') return
        if (!hasHost()) {
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(function () { document.execCommand('copy') })
          else document.execCommand('copy')
          return
        }
        invokeHost('clipboard_write_text', { text: text }).catch(function (error) {
          reportFailure(ctx, 'copy', error)
        })
      }

      /**
       * Cut the current selection.
       *
       * A native Ctrl+X, because the composer is a controlled contenteditable that
       * reverts scripted edits — see the Rust `clipboard` module. Focus is handed
       * back to the remembered editor first, since opening the menu took it.
       */
      function doCut() {
        if (window.__DSH_TERMINAL_EDIT__) return
        restoreEditableFocus()
        if (!hasHost()) { document.execCommand('cut'); return }
        invokeHost('clipboard_edit_shortcut', { key: 'x' }).catch(function (error) {
          reportFailure(ctx, 'cut', error)
        })
      }

      /**
       * Paste, as a native Ctrl+V.
       *
       * Same reasoning as {@link doCut}: focus must be on the editor, not on the
       * menu button that was just clicked, or the chord lands nowhere.
       */
      function doPaste() {
        if (window.__DSH_TERMINAL_EDIT__) { window.__DSH_TERMINAL_EDIT__.paste().catch(function (e) { reportFailure(ctx, 'paste', e) }); return }
        restoreEditableFocus()
        invokeHost('clipboard_edit_shortcut', { key: 'v' }).catch(function (error) {
          reportFailure(ctx, 'paste', error)
        })
      }

      /**
       * Rename the current session.
       *
       * Routed through the session binding's `rename`, which is what the sidebar's
       * own dialog calls; `uiWorkspace` exposes no session rename of its own.
       *
       * @param title - the new title.
       */
      function renameSession(title) {
        var session = currentSession(ctx)
        if (session === undefined) return
        var binding = ctx.sessions.binding(session.id)
        if (binding === undefined) {
          setRenameError(t('这个会话已不可用'))
          return
        }
        setRenamePending(true)
        setRenameError(null)
        binding.session.rename(title).then(function (result) {
          setRenamePending(false)
          if (result && result.ok === false) {
            setRenameError(result.error && result.error.message ? result.error.message : t('重命名失败'))
            return
          }
          setRename(null)
        }, function (error) {
          setRenamePending(false)
          setRenameError(error instanceof Error ? error.message : String(error))
        })
      }

      /**
       * Rename the current project.
       *
       * @param title - the new title.
       */
      function renameProject(title) {
        var workspace = currentWorkspace(ctx)
        if (workspace === undefined) return
        setRenamePending(true)
        setRenameError(null)
        ctx.workspaces.rename(workspace.workspaceId, title).then(function () {
          setRenamePending(false)
          setRename(null)
        }, function (error) {
          setRenamePending(false)
          setRenameError(error instanceof Error ? error.message : String(error))
        })
      }

      /** Archive the current session. */
      function archiveSession() {
        var session = currentSession(ctx)
        if (session === undefined) return
        ctx.uiWorkspace.archiveSession(session.id).catch(function (error) {
          reportFailure(ctx, 'archive the session', error)
        })
      }

      /** Fork the current session, opening the child. */
      function forkSession() {
        var session = currentSession(ctx)
        if (session === undefined) return
        ctx.uiWorkspace.forkSession(session.id).catch(function (error) {
          reportFailure(ctx, 'fork the session', error)
        })
      }

      /**
       * Copy the current session's deep link.
       *
       * The link is this app's own scheme — `deepseekharness://session/<id>` —
       * because the DSH server URL cannot be shared: its port is OS-assigned
       * per launch and it carries a one-time token. The link carries only the
       * session id, and the app translates a click on it back into that
       * session (see `deep_link.rs` and the bridge's `openDeepLink`).
       *
       * Written through the host clipboard like the 编辑 menu's copy, and
       * confirmed through the overlay's toast, because the copied string is
       * invisible: without a confirmation the user cannot tell the copy
       * happened at all.
       */
      function copyDeepLink() {
        var session = currentSession(ctx)
        if (session === undefined) return
        invokeHost('clipboard_write_text', { text: 'deepseekharness://session/' + session.id.replace(/^session-/, '') })
          .then(function () {
            try {
              document.dispatchEvent(
                new CustomEvent(REPORT_EVENT, { detail: { message: t('已复制深度链接') } }),
              )
            } catch {
              // No CustomEvent or no listener: the copy itself still happened.
            }
          })
          .catch(function (error) {
            reportFailure(ctx, 'copy the session link', error)
          })
      }

      /** Start a new session in the current project. */
      function newSession() {
        var workspace = currentWorkspace(ctx)
        ctx.uiWorkspace.startSession(workspace === undefined ? undefined : workspace.workspaceId)
      }

      /** Delete the current project, after confirmation. */
      function deleteProject() {
        var workspace = currentWorkspace(ctx)
        if (workspace === undefined) return
        ctx.workspaces.delete(workspace.workspaceId).catch(function (error) {
          reportFailure(ctx, 'delete the project', error)
        })
      }

      /**
       * Collapse or expand the sidebar, from the title bar's mark.
       *
       * This is the control the sidebar's own 收起侧边栏 button used to be. The
       * button is hidden by the overlay's stylesheet (section 8b) and this is what
       * replaces it, so the action has to reach the same place: `ctx.layout`,
       * which is the service that button calls.
       *
       * WHY NOT CLICK THE APP'S BUTTON. Driving it by dispatching a click on the
       * hidden node would work today and break silently the moment the app renames
       * a class or moves the button — and the node is `display: none` in desktop
       * mode, so it is not even a stable handle. The service is the app's own
       * public seam for exactly this, and it keeps working whether or not the
       * overlay is applied.
       *
       * Guarded like every other cross-boundary call here: a build whose layout
       * service does not answer this method must leave the bar inert, never throw
       * during a click.
       */
      function toggleSidebar() {
        var layout = ctx.layout
        if (!layout || typeof layout.toggleSidebar !== 'function') {
          reportFailure(ctx, 'toggle the sidebar', 'the layout service is unavailable')
          return
        }
        try {
          layout.toggleSidebar()
        } catch (error) {
          reportFailure(ctx, 'toggle the sidebar', error)
        }
      }

      /**
       * The brand lockup, which doubles as the sidebar's collapse control.
       *
       * ## Why the mark is the button
       *
       * The sidebar's own header is hidden (section 8b), and that header held the
       * mark AND the collapse button. Putting the mark back here — in the strip
       * directly above the sidebar it controls — is what keeps the window from
       * losing its identity, and making that same mark the control is what keeps a
       * second button out of the bar.
       *
       * ## The hover swap is the app's own
       *
       * The swap is copied from the app's collapsed rail, which shows the mark on
       * the toggle and swaps it for `IconPanelLeftOutline16` while the pointer is
       * over that toggle:
       *
       *     .…_collapsed .…_toggle:hover .…_railMark   { display: none }
       *     .…_collapsed .…_toggle:hover .…_panelIcon  { display: inline }
       *
       * So the reveal on hover is not an invention — it is the app's own idiom for
       * "this mark is a sidebar control", which is exactly what a user who has
       * seen the rail already knows. The panel glyph is rendered from the start and
       * hidden by CSS, not mounted on hover: swapping artwork must not depend on a
       * React render landing before the pointer leaves again.
       *
       * ## What it does not do
       *
       * There is no `aria-expanded` here, deliberately. The bar is a client plugin
       * and the sidebar's collapsed state lives in the layout store, so a subscriber
       * would mean a second source of truth for a value that only decides a tooltip
       * word — and a wrong one is worse than an absent one. The label describes the
       * ACTION ("收起侧边栏"), and the app's own aria-label for its button does the
       * same thing for the same reason.
       *
       * @returns the lockup element.
       */
      function brand() {
        var remote = isRemotePage()
        return h(
          'div',
          { className: 'dshTb__brand' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshTb__mark',
              // The app's own label for this control, so the replacement is
              // announced the same way the button it replaces was.
              'aria-label': t('收起侧边栏'),
              title: t('收起侧边栏'),
              // Pointer-down is suppressed for the same reason every other button
              // in the bar does it: taking focus here would drop the composer's
              // selection and with it a pending Ctrl+C/V.
              onMouseDown: function (event) { event.preventDefault() },
              onClick: toggleSidebar,
            },
            // Both glyphs are always in the tree; the stylesheet picks one per
            // hover state. See the doc block above.
            h('span', { className: 'dshTb__markLogo' }, h(Logo)),
            h('span', { className: 'dshTb__markPanel' }, h(IconPanelLeft)),
          ),
          // The wordmark stays a desktop affordance: the remote bar carries the
          // quick actions and the mark only, per the reduced-bar contract.
          remote ? null : h('span', { className: 'dshTb__wordmark' }, 'dsh'),
          remote ? null : h('span', { className: 'dshTb__badge' }, 'desktop'),
        )
      }

      /**
       * Switch between this app's styles and the unmodified frontend.
       *
       * The target is the OTHER mode, read from the document at click time rather
       * than from the component's state: the two agree, but the document is what
       * the stylesheet is actually gating on, so deriving the next mode from it
       * makes the toggle follow the page even if a render is outstanding.
       *
       * Nothing is applied here — the appearance plugin owns the setting and the
       * attribute. This only asks; see {@link requestUiMode}.
       */
      function toggleStyles() {
        requestUiMode(readUiMode() === VANILLA ? DESKTOP : VANILLA)
      }



      /**
       * Handle a chosen menu item.
       *
       * @param id - the item id.
       */
      function onSelect(id) {
        var which = openMenu
        if (which === 'more' && id === 'dsh-update') {
          setOpenMenu(null)
          if (updateVisible.current) return
          updateVisible.current = true
          setRename(null); setConfirm(null); setAboutOpen(false)
          setUpdateTab('desktop')
          setUpdateOpen(true)
          // Start both immediately. Each operation owns its own pending guard,
          // so a slow/failing check never delays the other tab or a dsh install.
          checkDesktopUpdate()
          checkDshUpdate()
          return
        }
        setOpenMenu(null)
        if (which === 'edit') {
          if (id === 'cut') doCut()
          if (id === 'copy') doCopy()
          if (id === 'paste') doPaste()
          return
        }
        if (which === 'session') {
          if (id === 'rename') {
            var session = currentSession(ctx)
            setRenameValue(session === undefined ? '' : session.title)
            setRenameError(null)
            setRename({ kind: 'session', title: t('重命名会话') })
          }
          if (id === 'archive') archiveSession()
          if (id === 'fork') forkSession()
          if (id === 'copy-link') copyDeepLink()
          if (id === 'copy-content') copySessionContent(ctx, currentSession(ctx)?.id)
          if (id === 'save-content') saveSessionContent(ctx, currentSession(ctx)?.id)
          // `reveal` is a SUBMENU parent: the primitive shows its entries instead
          // of calling this, so it never arrives here. What arrives is one of the
          // application ids, and the session's directory is its workspace's — see
          // `sessionItems`.
          if (!['rename', 'archive', 'fork', 'copy-link', 'copy-content', 'save-content', 'copy-session'].includes(id)) {
            openWithApp(ctx, id, revealPath)
          }
          return
        }
        if (which === 'project') {
          if (id === 'new-session') newSession()
          if (id === 'rename') {
            var workspace = currentWorkspace(ctx)
            setRenameValue(workspace === undefined ? '' : workspace.title)
            setRenameError(null)
            setRename({ kind: 'project', title: t('编辑项目') })
          }
          if (id === 'delete') {
            var target = currentWorkspace(ctx)
            if (target !== undefined) setConfirm({ title: t('删除项目'), name: target.title })
          }
          if (id === 'reveal') openInExplorer(ctx, revealPath)
          return
        }
        if (which === 'more') {
          if (id === 'toggle-styles') toggleStyles()
          if (id === 'settings') openSettings(ctx)
          if (id === 'about') setAboutOpen(true)
        }
      }

      // ---- rendering -------------------------------------------------------

      var session = currentSession(ctx)
      var workspace = currentWorkspace(ctx)
      var canEdit = hasSelection()
      // A workspace's own `path` is the directory both 会话 ▸ 打开… and
      // 项目 ▸ 在资源管理器打开 act on, because a session's directory IS its
      // workspace's. Read from the same service `currentWorkspace` uses, so the
      // two can never disagree about which project is current.
      var revealPath = workspace === undefined ? undefined : workspace.path
      var canReveal = typeof revealPath === 'string' && revealPath !== ''

      /**
       * One menu, with its trigger as the anchor.
       *
       * The app's own rows do exactly this: `Menu` wraps `anchor` in its own
       * measured span and positions the popup under it, so the trigger button is
       * *rendered by* the Menu rather than next to it. Following that shape means
       * no manual rect plumbing and no stray wrapper element.
       *
       * Pointer-down is suppressed on the trigger so clicking the bar never takes
       * focus from the composer — which is what keeps a pending selection and the
       * subsequent native Ctrl+C/V working.
       *
       * @param id - the menu id.
       * @param label - the visible trigger label.
       * @param items - the items to render.
       * @param selectedId - the item to mark as current, for the app's own
       *   `selection="fill"` treatment. Only the session menu's submenu uses it.
       * @returns the menu element.
       */
      function menuFor(id, label, items, selectedId) {
        if (!hasHost()) items = items.filter(function (item) {
          return !['reveal', 'reveal-separator', 'copy-session', 'copy-link', 'dsh-update', 'workspace-reveal', 'paste'].includes(item.id)
        })
        return h(Menu, {
          open: openMenu === id,
          onClose: closeMenu,
          items: items,
          onSelect: onSelect,
          portal: true,
          className: 'dshTb__menu',
          // The app's own dense + fill selection, matching the session-header menu
          // the submenu reproduces.
          dense: true,
          selection: 'fill',
          selectedId: selectedId,
          anchor: h(
            'button',
            {
              type: 'button',
              className: 'dshTb__item' + (openMenu === id ? ' dshTb__item--open' : ''),
              'aria-haspopup': 'menu',
              'aria-expanded': openMenu === id,
              onMouseDown: function (event) { event.preventDefault() },
              onClick: function () { if (openMenu === id) closeMenu(); else openThis(id) },
            },
            label,
          ),
        })
      }

      function controlButton(label, onClick, children, extraClass) {
        return h(
          'button',
          {
            type: 'button',
            className: 'dshTb__control' + (extraClass ? ' ' + extraClass : ''),
            'aria-label': label,
            title: label,
            onMouseDown: function (event) { event.preventDefault() },
            onClick: onClick,
          },
          children,
        )
      }

      var controls = hasHost()
        ? h(
            'div',
            { className: 'dshTb__controls' },
            controlButton(t('最小化'), function () {
              invokeHost('window_minimize').catch(function (error) { reportFailure(ctx, 'minimize', error) })
            }, h(MinimizeIcon)),
            controlButton(t('最大化'), function () {
              invokeHost('window_toggle_maximize').then(function (value) {
                if (typeof value === 'boolean') setMaximized(value)
              }, function (error) { reportFailure(ctx, 'toggle maximize', error) })
            }, maximized ? h(RestoreIcon) : h(MaximizeIcon)),
            controlButton(t('关闭'), function () {
              invokeHost('window_close').catch(function (error) { reportFailure(ctx, 'close', error) })
            }, h(CloseIcon), 'dshTb__control--close'),
          )
        : null

      var dialog = null
      if (rename !== null) {
        dialog = h(RenameDialog, {
          open: true,
          title: rename.title,
          value: renameValue,
          initial: rename.kind === 'session'
            ? (session === undefined ? '' : session.title)
            : (workspace === undefined ? '' : workspace.title),
          onChange: setRenameValue,
          pending: renamePending,
          error: renameError,
          onCancel: function () { setRename(null); setRenameError(null) },
          onConfirm: function (title) {
            if (rename.kind === 'session') renameSession(title)
            else renameProject(title)
          },
        })
      } else if (confirm !== null) {
        dialog = h(
          Modal,
          {
            open: true,
            onClose: function () { setConfirm(null) },
            title: t('删除项目'),
            closeLabel: t('关闭'),
            footer: h(
              React.Fragment,
              null,
              h(Button, { variant: 'outline', onClick: function () { setConfirm(null) } }, t('取消')),
              h(
                Button,
                {
                  variant: 'primary',
                  onClick: function () { setConfirm(null); deleteProject() },
                },
                t('删除'),
              ),
            ),
          },
          h('div', { className: 'dshTb__dialogField' },
            t('确定要删除项目“') + confirm.name + t('”吗？这会移除工作区注册，但不会删除文件或会话。')),
        )
      } else if (aboutOpen) {
        dialog = h(AboutDialog, {
          open: true,
          version: appVersion,
          onClose: function () { setAboutOpen(false) },
        })
      } else if (updateOpen) {
        dialog = h(UpdateDialog, {
          update: dshUpdate,
          desktopUpdate: desktopUpdate, version: appVersion,
          tab: updateTab, onTab: setUpdateTab,
          onClose: function () { updateVisible.current = false; setUpdateOpen(false) },
          onCheck: checkDshUpdate,
          onCheckDesktop: checkDesktopUpdate,
          onOpenRelease: openDesktopRelease,
          onInstall: installDshUpdate,
        })
      }

      /**
       * The theme switch, for the remote bar's right end.
       *
       * The glyph shows the current preference; the accessible name describes
       * the next step of the cycle.
       *
       * @returns the button element.
       */
      function themeButton() {
        var next = nextTheme(themePreference)
        var label = next === 'system' ? t('切换到跟随系统') : next === 'light' ? t('切换到浅色主题') : t('切换到深色主题')
        var currentLabel = themePreference === 'system' ? t('跟随系统') : themePreference === 'light' ? t('浅色') : t('深色')
        return h(
          'button',
          {
            type: 'button',
            className: 'dshTb__theme',
            'aria-label': label,
            'data-theme-preference': themePreference,
            title: t('当前：') + currentLabel + '；' + label,
            onMouseDown: function (event) { event.preventDefault() },
            onClick: toggleTheme,
          },
          h('span', { 'aria-hidden': 'true' }, h(themePreference === 'system' ? SystemThemeIcon : themePreference === 'light' ? SunIcon : MoonIcon)),
        )
      }

      // PORTALLED TO `document.body`, NOT LEFT IN THE OVERLAY LAYER — see the
      // module header. Two independent reasons, both fatal from inside the frame:
      // the layer is at z-index 20 while the app's dialogs and masks are
      // body-portalled at 1000–1100, so the bar would sit under a dialog's mask;
      // and the onboarding overlay sets `#root.inert`, which would make a bar
      // inside it visible but unclickable.
      //
      // THE REMOTE PAGE GETS THE REDUCED BAR. On `data-dsh-browser` the four
      // menus and the window controls are gone — their actions are desktop
      // affordances — and the bar carries the mark at its top-left corner where
      // it always was, the quick actions beside it (filled by the overlay's DOM
      // tier, which is why the container renders even while empty), and the
      // theme switch at the right end.
      var remote = isRemotePage()
      var tree = h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: 'dshTb',
            style: { height: BAR_HEIGHT + 'px' },
            // Dragging is delegated to the OS through the host command rather than
            // a CSS drag region, because a decorationless window has no caption for
            // the OS to drag. Anything inside a button is excluded, so a click on a
            // menu or a window control never starts a window move.
            //
            // Double-click toggles maximize, as a native caption does.
            onMouseDown: function (event) {
              if (event.button !== 0) return
              if (event.target.closest('button') !== null) return
              invokeHost('window_start_drag').catch(function () {
                // A refused drag is not worth reporting: it happens whenever the
                // pointer is released before the OS takes over.
              })
            },
            onDoubleClick: function (event) {
              if (event.target.closest('button') !== null) return
              invokeHost('window_toggle_maximize').then(function (value) {
                if (typeof value === 'boolean') setMaximized(value)
              }, function () {
                // As above: a failed toggle leaves the glyph as it was.
              })
            },
          },
          brand(),
          // The quick actions sit BESIDE the mark, not before it: the mark stays
          // the bar's top-left corner, as it is on the desktop.
          remote ? h('div', { className: 'dshTb__quick' }) : null,
          remote
            ? null
            : h(
                'nav',
                { className: 'dshTb__nav', 'aria-label': t('主菜单') },
                // SIMPLE MODE renders the boot bar's shape — mark, 更多, window
                // controls — so the strip the user saw before DSH mounted is one
                // they can keep. The three service menus are withheld whole: a
                // trigger that appears and disappears would make the bar's
                // geography move around, and the mode's point is a quieter strip,
                // not a shorter list inside it.
                titlebarMode === TITLEBAR_SIMPLE
                  ? null
                  : menuFor('edit', t('编辑'), editItems(canPaste, canEdit)),
                titlebarMode === TITLEBAR_SIMPLE
                  ? null
                  : menuFor('session', t('会话'), sessionItems(session !== undefined, canReveal, openApps), currentAppId()),
                titlebarMode === TITLEBAR_SIMPLE
                  ? null
                  : menuFor('project', t('项目'), projectItems(workspace !== undefined, canReveal)),
                menuFor('more', t('更多'), moreItems(uiMode)),
              ),
          h('div', { className: 'dshTb__spacer' }),
          remote ? themeButton() : null,
          controls,
        ),
        dialog,
        remote ? h(RemotePageChrome, { ctx: ctx }) : null,
      )

      // A body-less document would mean the slot rendered before the parser
      // produced one, which cannot happen for a mounted app — falling back to the
      // tree itself keeps the bar rather than dropping it if it somehow did.
      return document.body ? reactDom.createPortal(tree, document.body) : tree
    }

    // Both menu entry points pass an explicit id. Retaining a background session
    // loads its history without navigating away from the conversation being read.
    async function copySessionContent(ctx, sessionId) {
      if (!sessionId) return
      var reference
      try {
        if (typeof ctx.sessions.retain === 'function') {
          reference = ctx.sessions.retain(sessionId, { source: 'desktopSessionCopy' })
          await reference.ready
        }
        var text = await sessionContent(reference ? reference.binding : ctx.sessions.binding(sessionId))
        if (!text) throw new Error(t('该会话暂无可复制的内容'))
        await invokeHost('clipboard_write_text', { text: text })
        document.dispatchEvent(new CustomEvent(REPORT_EVENT, { detail: { message: t('已复制会话内容') } }))
      } catch (error) {
        reportFailure(ctx, t('复制会话内容'), error)
      } finally {
        if (reference) reference.release()
      }
    }

    async function saveSessionContent(ctx, sessionId) {
      if (!sessionId) return
      try {
        var controller = ctx.get('sessionLogDownload')
        if (!controller) throw new Error(t('Session 日志下载服务不可用'))
        await controller.download(sessionId)
      } catch (error) {
        reportFailure(ctx, t('保存会话内容'), error)
      }
    }

    function bindSessionActions(ctx) {
      ctx.effect(function () {
        var actions = {
          copyContent: function (sessionId) { return copySessionContent(ctx, sessionId) },
          saveContent: function (sessionId) { return saveSessionContent(ctx, sessionId) },
        }
        window.__DSH_SESSION_ACTIONS__ = actions
        return function () {
          if (window.__DSH_SESSION_ACTIONS__ === actions) delete window.__DSH_SESSION_ACTIONS__
        }
      }, 'desktop session menu actions')
    }

    function headerRenameTarget(ctx, sessionId) {
      var list = ctx.sessions.list.getSnapshot()
      var summary = list.byId[sessionId]
      if (!summary || list.currentAddress || summary.origin === 'subagent'
        || ctx.sessions.subagentAddress?.(sessionId)
        || ctx.sessions.binding(sessionId)?.session.getSnapshot().subagent) return
      return { id: sessionId, title: summary.displayTitle ?? summary.title ?? '' }
    }

    // Keep the upstream header and its lineage controls. Only its single root
    // breadcrumb gains an action, using the sidebar's own rename request/dialog.
    function bindHeaderSessionTitle(ctx) {
      if (typeof ctx.slots.entriesOfSlot !== 'function') return
      var actionSlot = 'conversation.session.header.actions'
      var renameSlot = 'sidebar.workspaces.session.menu.item'
      ctx.slots.inject(renameSlot, function () {
        return ctx.slots.inject(actionSlot, function () {
          function renameRequest() {
            var entry = ctx.slots.entriesOfSlot(renameSlot).find(function (entry) { return entry.options.id === 'rename' })
            return entry?.inject?.()?.requestSessionRename
          }
          function HeaderSessionTitle(props) {
            useLocale(React)
            var marker = React.useRef(null)
            var summary = props.useSessions(function (state) { return state.byId[props.sessionId] })
            var address = props.useSessions(function (state) { return state.currentAddress })
            React.useLayoutEffect(function () {
              var root = marker.current?.closest('[data-slot="conversation.session.header"]')
              if (!root) return
              var title, saved
              function activate() {
                var target = headerRenameTarget(ctx, props.sessionId)
                if (target && document.documentElement.getAttribute(MODE_ATTRIBUTE) !== VANILLA) renameRequest()?.(target.id, target.title)
              }
              function keydown(event) {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (!event.repeat) activate()
              }
              function release() {
                if (!title) return
                title.removeEventListener('click', activate)
                title.removeEventListener('keydown', keydown)
                title.removeAttribute('data-dsh-session-title-rename')
                saved.forEach(function (value, key) { if (value === null) title.removeAttribute(key); else title.setAttribute(key, value) })
                title = undefined
              }
              function scan() {
                // A root header has one breadcrumb segment. Ancestor buttons and
                // subagent lineage controls must never become rename triggers.
                var next = document.documentElement.getAttribute(MODE_ATTRIBUTE) !== VANILLA
                  && headerRenameTarget(ctx, props.sessionId) && typeof renameRequest() === 'function'
                  ? root.querySelector('nav > span:only-child > span:first-child') : undefined
                if (next === title) return
                release()
                if (!next) return
                title = next
                saved = new Map(['role', 'tabindex', 'title'].map(function (key) { return [key, title.getAttribute(key)] }))
                title.setAttribute('role', 'button')
                title.setAttribute('tabindex', '0')
                title.setAttribute('title', t('重命名会话'))
                title.setAttribute('data-dsh-session-title-rename', '')
                title.addEventListener('click', activate)
                title.addEventListener('keydown', keydown)
              }
              // The upstream header can render its breadcrumb after our layout
              // effect as its own session/store subscriptions settle.
              var observer = new MutationObserver(scan)
              observer.observe(root, { childList: true, subtree: true })
              var modeObserver = new MutationObserver(scan)
              modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] })
              var offRename = ctx.slots.subscribe(renameSlot, scan)
              scan()
              return function () { observer.disconnect(); modeObserver.disconnect(); offRename(); release() }
            // Token/step counters replace the summary during streaming. They
            // do not change this binding; activate() reads the current title.
            }, [props.sessionId, Boolean(summary), summary?.origin, address, t('重命名会话')])
            return h('span', { ref: marker, hidden: true })
          }
          return ctx.slots.register({ name: actionSlot, id: 'desktop-title-rename' }, HeaderSessionTitle)
        })
      })
    }

    // Mirror the sidebar's live slot entries, including their injected services,
    // into the existing header menu. The original export/feedback component keeps
    // owning its trigger, menu, dialogs and callbacks.
    function bindHeaderSessionMenu(ctx) {
      if (typeof ctx.slots.entriesOfSlot !== 'function' || typeof ctx.slots.spec !== 'function') return
      var headerSlot = 'conversation.session.header.utilities'
      var sourceSlot = 'sidebar.workspaces.session.menu.item'
      var mirrorSlot = 'desktop.session.header.menu.item'
      ctx.slots.inject(sourceSlot, function () {
        return ctx.slots.inject(headerSlot, function () {
          var original, removeHeader, removeItems = [], disposed = false
          function clear() {
            removeItems.splice(0).reverse().forEach(function (dispose) { dispose() })
            if (removeHeader) { var dispose = removeHeader; removeHeader = undefined; dispose() }
            original = undefined
          }
          function syncItems() {
            if (!removeHeader) return
            removeItems.splice(0).reverse().forEach(function (dispose) { dispose() })
            ctx.slots.entriesOfSlot(sourceSlot).forEach(function (entry) {
              removeItems.push(ctx.slots.register(Object.assign({}, entry.options, {
                name: mirrorSlot, inject: entry.inject, locale: entry.locale, store: entry.store,
              }), entry.component))
            })
          }
          function syncHeader() {
            if (disposed) return
            var next = ctx.slots.entries(headerSlot).find(function (entry) {
              return entry.options.id === 'session-log-download' && entry.component !== HeaderSessionMenu
            })
            if (document.documentElement.getAttribute(MODE_ATTRIBUTE) === VANILLA) next = undefined
            if (original === next) return
            clear()
            if (!next || typeof next.component !== 'function') return
            original = next
            removeHeader = ctx.slots.register(Object.assign({}, next.options, {
              name: headerSlot, priority: (next.options.priority || 0) - 1,
              inject: next.inject, locale: next.locale, store: next.store,
              children: { [mirrorSlot]: ctx.slots.spec(sourceSlot) },
            }), HeaderSessionMenu)
            syncItems()
          }
          function HeaderSessionMenu(props) {
      useLocale(React)
            var root = React.useRef(null)
            var mounted = React.useState(null), target = mounted[0], setTarget = mounted[1]
            var summary = props.useSessions(function (state) { return state.byId[props.sessionId] })
            var close = React.useCallback(function (open) {
              if (open === true) return
              var button = root.current && root.current.querySelector('button[aria-expanded="true"]')
              if (button) button.click()
            }, [])
            var menuState = React.useMemo(function () { return [true, close] }, [close])
            React.useEffect(function () {
              var host, separator, menu, nativeRows
              function release() {
                if (host) host.remove()
                if (separator) separator.remove()
                if (menu) {
                  menu.removeAttribute('data-dsh-header-session-id')
                  menu.removeAttribute('data-dsh-header-session-path')
                }
                host = separator = menu = nativeRows = undefined
              }
              function scan() {
                var button = root.current && root.current.querySelector('button[aria-expanded="true"]')
                if (!button || (menu && !menu.isConnected)) {
                  if (host) { release(); setTarget(null) }
                  if (!button) return
                }
                if (host) return
                var candidates = document.querySelectorAll('[role="menu"]')
                for (var i = 0; i < candidates.length; i++) {
                  var candidate = candidates[i]
                  if (candidate.closest('[data-dsh-ghost]')) continue
                  var key = Object.keys(candidate).find(function (key) { return key.indexOf('__reactFiber$') === 0 })
                  var fiber = key && candidate[key]
                  for (var depth = 0; fiber && depth < 35; depth++, fiber = fiber.return) {
                    var owner = fiber.memoizedProps
                    if (!Array.isArray(owner?.items) || !owner.items.some(function (item) { return item.id === 'download' })) continue
                    if (typeof owner.onClose !== 'function') continue
                    menu = candidate
                    break
                  }
                  if (menu) break
                }
                if (!menu) return
                var viewport = menu.querySelector('[class*="viewport"]') || menu
                host = document.createElement('div')
                host.setAttribute('data-dsh-header-menu-items', '')
                nativeRows = document.createElement('div')
                host.appendChild(nativeRows)
                var extras = document.createElement('div')
                extras.setAttribute('data-dsh-header-menu-extras', '')
                host.appendChild(extras)
                separator = document.createElement('div')
                separator.setAttribute('role', 'separator')
                separator.setAttribute('data-dsh-header-menu-divider', '')
                separator.style.cssText = 'height:.5px;margin:4px 2px;background:var(--dsw-alias-border-l1)'
                viewport.prepend(host, separator)
                menu.setAttribute('data-dsh-header-session-id', String(props.sessionId))
                if (summary?.cwd) menu.setAttribute('data-dsh-header-session-path', summary.cwd)
                setTarget(nativeRows)
              }
              var observer = new MutationObserver(scan)
              observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
              scan()
              return function () { observer.disconnect(); release() }
            }, [props.sessionId, summary?.cwd])
            return h(React.Fragment, null,
              h('span', { ref: root, style: { display: 'contents' } }, original && h(original.component, props)),
              target && reactDom.createPortal(props.renderSlot(mirrorSlot, {
                sessionId: props.sessionId, displayTitle: summary?.title ?? summary?.displayTitle ?? '',
              }, { hookContext: menuState }), target))
          }
          var offHeader = ctx.slots.subscribe(headerSlot, syncHeader)
          var offItems = ctx.slots.subscribe(sourceSlot, syncItems)
          var modeObserver = new MutationObserver(syncHeader)
          modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] })
          syncHeader()
          return function () { disposed = true; modeObserver.disconnect(); offHeader(); offItems(); clear() }
        })
      })
    }

    /** Await native file completion while retaining the upstream export actions. */
    function bindSessionExport(ctx) {
      if (!window.__TAURI__?.core || typeof ctx.inject !== 'function') return
      // Optional on older DSH. Both the header action and /export use this service.
      ctx.inject(['sessionLogDownload'], function (scope) {
        var controller = scope.sessionLogDownload
        if (typeof controller?.run !== 'function' || typeof controller?.publish !== 'function') return
        scope.effect(function () {
          var original = controller.run
          var pending = new Set()
          var disposed = false
          var vanilla = () => document.documentElement.getAttribute('data-dsh-ui') === 'vanilla'
          var report = message => document.dispatchEvent(new CustomEvent(REPORT_EVENT, { detail: { message, key: 'session-export' } }))
          async function run(sessionId, signal) {
            var wantsDialog = vanilla()
            controller.publish(sessionId, { open: wantsDialog, status: 'downloading', error: null })
            try {
              // The host keeps the chosen path and returns a single-use download ID.
              // The startup timeout begins only after the native picker is closed.
              var requestId = await window.__TAURI__.core.invoke('prepare_session_export', { sessionId: String(sessionId) })
              if (signal.aborted || disposed) return
              if (!requestId) {
                controller.publish(sessionId, { open: false, status: 'idle', error: null })
                return
              }
              var route = 'api/session.export?' + new URLSearchParams({ sessionId, includeDescendants: 'true', desktopExportId: requestId })
              var response = await controller.fetcher(route, { method: 'HEAD', signal })
              if (!response.ok) throw Error(t('Session 导出失败：HTTP ') + response.status)
              if (signal.aborted || disposed) return
              // Listen before clicking: a small archive can finish immediately.
              var path = await new Promise(function (resolve, reject) {
                var timer
                var finish = function (error, path) {
                  clearTimeout(timer)
                  window.removeEventListener('dsh-desktop:session-export', receive)
                  signal.removeEventListener('abort', abort)
                  pending.delete(abort)
                  error ? reject(error) : resolve(path)
                }
                var abort = () => finish(Error(t('Session 导出已取消')))
                var receive = function (event) {
                  var result = event.detail
                  if (result?.sessionId !== String(sessionId) || result.requestId !== requestId) return
                  if (result.status === 'started') clearTimeout(timer)
                  else if (result.status === 'success') finish(null, result.path)
                  else if (result.status === 'error') finish(Error(result.error || t('Session 日志下载失败')))
                }
                pending.add(abort)
                window.addEventListener('dsh-desktop:session-export', receive)
                signal.addEventListener('abort', abort, { once: true })
                timer = setTimeout(() => finish(Error(t('Session 日志下载未能启动，请重试。'))), 30000)
                try { controller.save(route, 'dsh-session-' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') + '.zip') }
                catch (error) { finish(error) }
              })
              var open = wantsDialog && vanilla() && controller.store.getSnapshot().bySession[String(sessionId)]?.open === true
              controller.publish(sessionId, { open, status: 'success', error: null })
              if (!vanilla()) report(t('Session 日志已保存到：') + path)
            } catch (error) {
              if (signal.aborted || disposed) return
              var message = error instanceof Error ? error.message : String(error)
              controller.publish(sessionId, { open: vanilla(), status: 'error', error: message })
              if (!vanilla()) report(message)
            }
          }
          controller.run = run
          return function () {
            disposed = true
            if (controller.run === run) controller.run = original
            for (var abort of pending) abort()
          }
        }, 'desktop Session export completion')
      })
    }

    /** Mount the bar into the frame-wide overlay slot. */
    function apply(ctx) {
      if (window.__DSH_REMOTE_THEME__ && typeof ctx.inject === 'function') {
        ctx.inject(['configForms'], function (child) {
          window.__DSH_REMOTE_THEME__.bind(child, child.configForms.get('ui-theme'))
        })
      }
      // The frame must leave room for the bar, so the height is published as a
      // custom property the stylesheet reads. Set here rather than hard-coded in
      // CSS so the two cannot drift.
      document.documentElement.style.setProperty('--dsh-desktop-titlebar-height', BAR_HEIGHT + 'px')

      // Watch focus so Cut and Paste can hand it back to the editor before sending
      // a native chord. Installed once for the plugin's lifetime.
      trackEditableFocus()
      bindSessionActions(ctx)
      bindSessionExport(ctx)
      bindHeaderSessionTitle(ctx)
      bindHeaderSessionMenu(ctx)

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'desktop-title-bar',
            // Order 0: the bar is a frame edge, not a floating card, so it sits
            // beneath any other overlay an app or plugin adds.
            order: 0,
          },
          function TitleBarSlot() {
            return h(TitleBar, { ctx: ctx })
          },
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
