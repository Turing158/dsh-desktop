/* DeepseekHarness desktop — the title bar for the interval before DSH exists.
 *
 * ## Why this file exists
 *
 * The window is created with `decorations(false)`, so the app draws its own
 * caption — but the app's own bar is a DSH **client plugin**
 * (`title-bar/client.js`), and a client plugin can only run once DSH's plugin
 * tree has mounted. Between the window appearing and that moment there are two
 * pages with no caption at all:
 *
 *   - the app's own boot page (onboarding, install progress, errors), served
 *     from the app's private protocol, and
 *   - the DSH page itself, while it still shows its own "Loading plugins…"
 *     splash.
 *
 * Both are pages where the window cannot be moved, minimized, or closed, which
 * is worse than cosmetic: `decorations(false)` removed the OS controls, so
 * without a bar there is no window control at all.
 *
 * So this script is injected by the Rust host as a WebView2
 * **document-created** script (`initialization_script`), which runs before any
 * page script on every navigation — including the iframes DSH renders for its
 * document preview, which is why {@link isOwnTopLevelDocument} refuses anything
 * that is not the top-level page. It draws the bar immediately, and retires the
 * moment the real bar takes over.
 *
 * ## The two bars, and how the handoff works
 *
 *   page loads  ──► boot bar (this file) ──► 更多 ▸ 关于   [window controls]
 *   DSH mounts  ──► client plugin renders the full bar, then announces
 *                   `dsh-desktop:titlebar-ready`; this bar removes itself.
 *
 * The bar is **never absent**: if the client plugin fails to load, or the boot
 * goes wrong, this one simply stays — which is exactly the state in which the
 * user most needs a close button.
 *
 * The reduced menu is deliberate rather than a limitation being papered over.
 * 编辑 / 会话 / 项目 all act on DSH services — the current session, the current
 * workspace, the clipboard bridge — and none of them exist yet. Offering them
 * before DSH is up would mean offering dead entries. 关于 is the one item that
 * means the same thing on every page, so it is the one item kept — and it
 * works: it opens this bar's own about dialog, which says what the real bar's
 * dialog says (the same whale, the same sentence) with no dialog primitive to
 * help, because this world has none. See {@link openAbout} below.
 *
 * ## Why it is a classic script
 *
 * It is injected as a plain `<script>` body, not a module, so it must stay a
 * classic script: no `import`/`export`, no top-level `await`, and no dependency
 * on anything DSH provides — during the boot page there is no DSH at all.
 *
 * ## Stacking
 *
 * The bar is appended to `<body>` and positioned `fixed` with a z-index above
 * every overlay the app portals to the body (the app's dialogs and onboarding
 * mask sit at 1100). A bar inside the app's own frame cannot win that fight: the
 * frame's overlay layer establishes its own stacking context at z-index 20, so
 * anything inside it is capped below a body-portalled dialog mask. That is the
 * bug this placement exists to avoid — see `title-bar/client.js`, which portals
 * the real bar to the same plane for the same reason.
 */
(function () {
  'use strict'

  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)

  /* Injected on every navigation, and an already-evaluated script must not build
     a second bar. The flag lives on `window` because that is the only scope that
     is fresh per document and shared across evaluations within one. */
  if (window.__dshDesktopTitleBarBoot === true) return
  window.__dshDesktopTitleBarBoot = true

  /** Bar height in px. Kept in sync with `title-bar/client.js` by a test. */
  var BAR_HEIGHT = 44

  /** The host element's id, so the client plugin's takeover is unambiguous. */
  var HOST_ID = 'dsh-desktop-titlebar-boot'

  /**
   * Announced by the client plugin once the full bar is on screen.
   *
   * Keep in sync with `TITLEBAR_READY_EVENT` in `title-bar/client.js`.
   */
  var READY_EVENT = 'dsh-desktop:titlebar-ready'

  /**
   * The durable half of {@link READY_EVENT}.
   *
   * An event only reaches a listener that was already installed, and this script
   * can mount *after* the real bar has already announced itself — a slow document
   * start on a page whose plugin tree was warm. Without this check the boot bar
   * would then install itself on top of the real one and stay there, since the
   * announcement it waits for had already happened.
   *
   * Keep in sync with `TITLEBAR_READY_ATTRIBUTE` in `title-bar/client.js`.
   */
  var READY_ATTRIBUTE = 'data-dsh-titlebar'

  /**
   * The `<html>` custom property naming the bar's height.
   *
   * Published here as well as by the client plugin, so a page styled against it
   * (the app's boot UI) reserves the right space even when DSH never mounts.
   */
  var HEIGHT_PROPERTY = '--dsh-desktop-titlebar-height'

  /**
   * The DeepSeek mark, as the bar's inline SVG path.
   *
   * A second copy of the constant in `title-bar/client.js`, which is unavoidable:
   * the two run in different worlds (this one during the boot page, that one
   * inside DSH) and neither can import the other. `titlebar-boot.test.mjs`
   * asserts the two strings are identical, so the guarantee the project relies on
   * — one piece of artwork, one whale — is enforced rather than assumed.
   */
  var LOGO_PATH =
    'M48.8354 10.0479C48.3232 9.792 48.1025 10.2798 47.8032 10.5278C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C36.4668 10.0156 35.9702 9.3198 35.356 7.7275C35.2456 7.3999 35.1353 7.064 34.7651 7.0078C34.3633 6.9438 34.2056 7.2876 34.0479 7.5757C32.6143 10.2559 33.3311 15.8721 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C31.8657 19.2559 29.6758 15.3599 25.8467 12.5518C23.8618 10.584 26.1069 8.9678 26.627 8.7759C27.1704 8.5757 26.8159 7.8877 25.0591 7.896C22.9873 7.9038 20.5688 9.0879 18.7095 9.584C11.9102 8.272 6.4272 10.9521 3.8433 14.7681C-1.521 22.688 1.7085 33.5039 8.0737 38.8799C14.3047 44.1357 23.5229 45.9199 31.1016 39.4561C33.4102 40.624 36.5454 40.5439 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C39.397 30.4639 41.7524 25.1279 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C46.7559 18.9038 49.0005 15.5039 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C7.6011 33.8559 4.4976 27.0156 4.1978 21.3677C4.1582 20.5757 4.3867 20.2959 5.1587 20.1519C12.9189 18.688 19.0161 24.248 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398Z'

  /**
   * The one sentence the about dialog says, byte-identical to the real bar's
   * dialog text (`title-bar/client.js`), so the two abouts describe the same
   * app the same way. `titlebar-boot.test.mjs` asserts the equality, the same
   * way it asserts the two copies of {@link LOGO_PATH} are one artwork.
   */
  var ABOUT_TEXT =
    t('DeepSeek Harness（dsh）的 Windows 桌面外壳：把 dsh 的网页界面嵌进独立窗口，并在任务需要你时发出通知。')

  /**
   * The bar's stylesheet, injected with the bar.
   *
   * SELF-CONTAINED ON PURPOSE. The app's own bar is styled by `theme.css`, which
   * only exists on the DSH page — and even there its rules read `--dsw-*` tokens
   * that the app's theme plugin publishes at *runtime*, i.e. after the splash this
   * bar exists to cover. So this carries its own rules with literal fallbacks.
   *
   * COLOURS COME FROM THE PALETTE THAT IS ACTUALLY LIVE. During the DSH splash the
   * only signal is `body[data-ds-dark-theme]`, which DSH's own boot script sets
   * before the page parses; afterwards the app's theme presenter toggles the same
   * attribute. The boot page has no such marker, so it declares the three custom
   * properties below in its own stylesheet instead — one mechanism, two pages.
   *
   * The values match `src-tauri/src/titlebar.rs` and the dark palette of
   * `theme.css`, so the strip does not change colour when the real bar replaces
   * this one.
   */
  var CSS = [
    '#' + HOST_ID + '{',
    'position:fixed;inset:0 0 auto 0;height:' + BAR_HEIGHT + 'px;z-index:1200;',
    'display:flex;align-items:center;gap:8px;padding:0 0 0 10px;box-sizing:border-box;',
    'font:13px/1 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;',
    'user-select:none;cursor:default;',
    'background:var(--dsh-desktop-titlebar-bg,#f9fafb);',
    'color:var(--dsh-desktop-titlebar-fg,#0f1115);',
    'border-bottom:1px solid var(--dsh-desktop-titlebar-border,rgb(0 0 0 / 10%));',
    '}',
    'body[data-ds-dark-theme] #' + HOST_ID + '{',
    'background:var(--dsh-desktop-titlebar-bg,#1b1b1c);',
    'color:var(--dsh-desktop-titlebar-fg,#f9fafb);',
    'border-bottom-color:var(--dsh-desktop-titlebar-border,rgb(255 255 255 / 12%));',
    '}',
    '.' + CLS('brand') + '{display:flex;align-items:center;gap:7px;flex:none;margin-right:6px}',
    '.' + CLS('logo') + '{display:block;flex:none}',
    '.' + CLS('wordmark') + '{font-size:14px;font-weight:600;letter-spacing:-.01em;line-height:1}',
    '.' + CLS('badge') + '{display:inline-flex;align-items:center;height:15px;padding:0 5px;',
    'border-radius:4px;background:rgb(127 127 127 / 22%);font-size:9px;font-weight:600;',
    'letter-spacing:.04em;line-height:1;opacity:.75}',
    '.' + CLS('nav') + '{display:flex;align-items:center;gap:2px;flex:none}',
    '.' + CLS('item') + '{appearance:none;border:0;background:transparent;color:inherit;',
    'font:inherit;font-size:13px;line-height:1;padding:6px 10px;border-radius:8px;',
    'cursor:pointer;white-space:nowrap;opacity:.78}',
    '.' + CLS('item') + ':hover,.' + CLS('item') + '[aria-expanded="true"]{opacity:1;',
    'background:var(--dsh-desktop-titlebar-hover,rgb(0 0 0 / 6%))}',
    'body[data-ds-dark-theme] .' + CLS('item') + ':hover,',
    'body[data-ds-dark-theme] .' + CLS('item') + '[aria-expanded="true"]{',
    'background:var(--dsh-desktop-titlebar-hover,rgb(255 255 255 / 8%))}',
    '.' + CLS('spacer') + '{flex:1 1 auto;align-self:stretch}',
    '.' + CLS('controls') + '{display:flex;align-items:stretch;flex:none;align-self:stretch}',
    /* Hidden until a host bridge is detected: in a plain browser the native frame
       is present and a second set of controls would be wrong. See `revealControls`. */
    '.' + CLS('controls') + '[data-host="unknown"]{visibility:hidden}',
    '.' + CLS('control') + '{appearance:none;border:0;background:transparent;color:inherit;',
    'width:46px;display:inline-flex;align-items:center;justify-content:center;',
    'cursor:default;opacity:.78}',
    '.' + CLS('control') + ':hover{opacity:1;background:var(--dsh-desktop-titlebar-hover,rgb(0 0 0 / 6%))}',
    'body[data-ds-dark-theme] .' + CLS('control') + ':hover{',
    'background:var(--dsh-desktop-titlebar-hover,rgb(255 255 255 / 8%))}',
    '.' + CLS('control') + '--close:hover{background:#e5484d;color:#fff;opacity:1}',
    '.' + CLS('menu') + '{position:fixed;z-index:1300;box-sizing:border-box;',
    'width:max-content;min-width:0;max-width:min(360px,calc(100vw - 16px));',
    'max-height:calc(100dvh - 16px);overflow-y:auto;padding:4px;gap:0;',
    'display:flex;flex-direction:column;border-radius:12px;',
    'border:1px solid var(--dsh-menu-border,var(--dsh-desktop-titlebar-border,rgb(0 0 0 / 10%)));',
    'background:var(--dsh-menu-surface,var(--dsh-desktop-titlebar-menu-bg,#fff));',
    'color:var(--dsw-alias-label-primary,var(--dsh-desktop-titlebar-fg,#0f1115));',
    'font:14px/20px "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;',
    'box-shadow:var(--dsh-menu-shadow,0 3px 8px rgb(0 0 0 / 6%),0 12px 32px rgb(0 0 0 / 10%))}',
    'body[data-ds-dark-theme] .' + CLS('menu') + '{',
    'background:var(--dsh-menu-surface,var(--dsh-desktop-titlebar-menu-bg,#353638));',
    'color:var(--dsw-alias-label-primary,var(--dsh-desktop-titlebar-fg,#f9fafb));',
    'border-color:var(--dsh-menu-border,var(--dsh-desktop-titlebar-border,rgb(255 255 255 / 12%)));',
    /* Match the full menu surface when the theme plugin has not loaded yet. */
    'box-shadow:var(--dsh-menu-shadow,0 3px 8px rgb(0 0 0 / 12%),0 12px 32px rgb(0 0 0 / 20%))}',
    '.' + CLS('menuItem') + '{box-sizing:border-box;width:100%;min-width:0;min-height:28px;',
    'padding:4px 10px;border:0;border-radius:7px;background:transparent;font:inherit;',
    'color:inherit;text-align:left;white-space:normal;overflow-wrap:anywhere;cursor:pointer;}',
    '.' + CLS('menuItem') + ':hover{background:var(--dsh-menu-hover,rgb(65 118 230 / 8%))}',
    'body[data-ds-dark-theme] .' + CLS('menuItem') + ':hover{background:var(--dsh-menu-hover,rgb(86 134 254 / 14%))}',
    '.' + CLS('menuItem') + ':focus-visible,.' + CLS('item') + ':focus-visible{',
    'outline:2px solid var(--dsh-menu-accent,#4176e6);outline-offset:-2px;}',
    '@media(pointer:coarse){.' + CLS('menuItem') + '{min-height:44px}}',
    /* The 关于 dialog. The real bar's dialog is the app's own Modal; this one is
       hand-built, so it carries its own surface — the menu's palette under a
       mask that owns the page while it is open. The popup closes first; 1300
       stays above the bar (1200) and every app layer the boot pages
       portal (1000–1100). */
    '.' + CLS('overlay') + '{position:fixed;inset:0;z-index:1300;display:flex;',
    'align-items:center;justify-content:center;background:rgb(0 0 0 / 44%);}',
    '.' + CLS('about') + '{display:flex;flex-direction:column;gap:14px;min-width:264px;',
    'width:380px;max-width:calc(100vw - 48px);padding:24px;border-radius:12px;box-sizing:border-box;',
    'background:var(--dsh-desktop-titlebar-menu-bg,#fff);',
    'color:var(--dsh-desktop-titlebar-fg,#0f1115);',
    'box-shadow:0 8px 24px rgb(0 0 0 / 24%),0 2px 8px rgb(0 0 0 / 12%);}',
    'body[data-ds-dark-theme] .' + CLS('about') + '{',
    'background:var(--dsh-desktop-titlebar-menu-bg,#2c2c2e);',
    'color:var(--dsh-desktop-titlebar-fg,#f9fafb);}',
    /* Geometry mirrors the real dialog (`theme.css`, .dshTb__about*): the same
       head row, the same enlarged whale, the same type sizes — so the handoff
       between the two bars swaps surfaces, not content or layout. */
    '.' + CLS('aboutHead') + '{display:flex;align-items:center;gap:12px;}',
    '.' + CLS('aboutMark') + '{display:flex;flex:none;}',
    '.' + CLS('aboutMark') + ' svg{width:30px;height:30px;}',
    '.' + CLS('aboutIdent') + '{display:flex;flex-direction:column;gap:2px;}',
    '.' + CLS('aboutName') + '{font-size:14px;font-weight:600;line-height:1.4;}',
    '.' + CLS('aboutVersion') + '{font-size:12px;line-height:1.4;opacity:.62;}',
    '.' + CLS('aboutText') + '{margin:0;font-size:13px;line-height:1.6;opacity:.62;}',
    '.' + CLS('aboutFoot') + '{display:flex;justify-content:flex-end;}',
    /* Ink-inverted rather than a brand fill: this world owns no accent token,
       and an inverted pill reads as the primary action in both palettes. */
    '.' + CLS('aboutClose') + '{appearance:none;border:0;font:inherit;font-size:13px;',
    'padding:6px 18px;border-radius:8px;cursor:default;',
    'background:var(--dsh-desktop-titlebar-fg,#0f1115);',
    'color:var(--dsh-desktop-titlebar-bg,#f9fafb);}',
    'body[data-ds-dark-theme] .' + CLS('aboutClose') + '{',
    'background:var(--dsh-desktop-titlebar-fg,#f9fafb);',
    'color:var(--dsh-desktop-titlebar-bg,#1b1b1c);}',
    '.' + CLS('aboutClose') + ':hover{opacity:.88}',
  ].join('')

  /** One of this bar's class names. */
  function CLS(suffix) {
    return 'dshBoot__' + suffix
  }

  /**
   * Build an element.
   *
   * @param tag - the tag name.
   * @param attrs - attributes to set; `class` and `text` are special-cased.
   * @param children - child elements.
   * @returns the element.
   */
  function h(tag, attrs, children) {
    var node = document.createElement(tag)
    var attributes = attrs || {}
    for (var key in attributes) {
      if (!Object.prototype.hasOwnProperty.call(attributes, key)) continue
      if (key === 'class') node.className = attributes[key]
      else if (key === 'text') node.textContent = attributes[key]
      else if (attributes[key] !== null && attributes[key] !== undefined) {
        node.setAttribute(key, String(attributes[key]))
      }
    }
    var list = children || []
    for (var i = 0; i < list.length; i++) node.appendChild(list[i])
    return node
  }

  /**
   * Whether this document is the app's own top-level page.
   *
   * TWO CHECKS, AND THE SECOND IS NOT OBVIOUS.
   *
   * The origin test is the ordinary one: a document-created script runs on every
   * top-level navigation, and the bar belongs to this app's window rather than to
   * whatever the webview might be pointed at. It matches the two origins the
   * Tauri capabilities are scoped to.
   *
   * The frame test is the one that matters here, because **WebView2 runs these
   * scripts in subframes too, and Tauri's `for_main_frame_only` is documented as
   * ignored on Windows** (`wry`'s `with_initialization_script_for_main_only`). DSH
   * renders same-origin iframes — the document preview is built from a base64
   * payload — so without this check the bar would be mounted inside every one of
   * them, drawing a second, third, and fourth strip inside a preview pane.
   *
   * `window.top === window` is the right test rather than `frameElement`, which
   * throws for a cross-origin parent; a preview iframe is same-origin today, but
   * the guard should not depend on that staying true.
   *
   * @returns {boolean} whether to mount.
   */
  function isOwnTopLevelDocument() {
    try {
      if (window.top !== window) return false
    } catch (error) {
      // A throwing comparison means this is a frame with a foreign parent, which
      // is by definition not the app's own top-level page.
      return false
    }

    var location = window.location
    if (!location) return true
    var scheme = String(location.protocol || '')
    if (scheme === 'tauri:') return true
    if (scheme !== 'http:' && scheme !== 'https:') return false
    var host = String(location.hostname || '')
    return (
      window.__DSH_DESKTOP_BOOT_HOST__ === true ||
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === 'tauri.localhost' ||
      /\.tauri\.localhost$/.test(host)
    )
  }

  /**
   * Invoke a host command from the bar.
   *
   * `__TAURI__` is injected by the desktop shell and `__TAURI_INTERNALS__` backs
   * it; the order in which either appears relative to this script is not
   * guaranteed, so nothing is captured at mount time. A missing bridge resolves
   * to `undefined` rather than throwing, so a page without a shell degrades to
   * inert buttons.
   *
   * @param command - the Rust command name.
   * @returns a promise, always resolving, so a call site never needs its own
   *   rejection handler.
   */
  function invokeHost(command, args) {
    var api = window.__TAURI__
    var call =
      api && api.core && typeof api.core.invoke === 'function'
        ? api.core.invoke(command, args)
        : undefined
    if (call === undefined) {
      var internals = window.__TAURI_INTERNALS__
      if (internals && typeof internals.invoke === 'function') {
        call = internals.invoke(command, args)
      }
    }
    if (call === undefined) return Promise.resolve(undefined)
    // A refused command is not worth reporting from here: the window controls
    // have no UI to report into, and a rejected promise nobody handles would be
    // an unhandled rejection on every click of a page without permission.
    return Promise.resolve(call).then(
      function (value) {
        return value
      },
      function () {
        return undefined
      },
    )
  }

  /** Whether a shell is present to answer the window-control commands. */
  function hasHost() {
    var api = window.__TAURI__
    if (api && api.core && typeof api.core.invoke === 'function') return true
    var internals = window.__TAURI_INTERNALS__
    return Boolean(internals && typeof internals.invoke === 'function')
  }

  /**
   * The window-control glyphs, drawn here rather than taken from the app.
   *
   * DSH ships no minimize/maximize/restore icons — the OS caption used to provide
   * them — so the bar draws its own. They are built with `createElementNS` because
   * an element created in the HTML namespace renders as an unknown inline element,
   * not as a vector, however the markup is nested.
   *
   * @param paths - child descriptors: `{ tag, attrs }`.
   * @returns the svg element.
   */
  function glyph(paths) {
    var SVG = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('aria-hidden', 'true')
    for (var i = 0; i < paths.length; i++) {
      var shape = document.createElementNS(SVG, paths[i].tag)
      var attributes = paths[i].attrs
      for (var key in attributes) {
        if (Object.prototype.hasOwnProperty.call(attributes, key)) {
          shape.setAttribute(key, String(attributes[key]))
        }
      }
      svg.appendChild(shape)
    }
    return svg
  }

  function minimizeGlyph() {
    return glyph([{ tag: 'path', attrs: { d: 'M3.5 8h9' } }])
  }

  function maximizeGlyph() {
    return glyph([{ tag: 'rect', attrs: { x: 3.75, y: 3.75, width: 8.5, height: 8.5, rx: 1.5 } }])
  }

  function restoreGlyph() {
    return glyph([
      { tag: 'rect', attrs: { x: 3.5, y: 5.5, width: 7, height: 7, rx: 1.4 } },
      {
        tag: 'path',
        attrs: {
          d: 'M5.75 5.5V4.9A1.4 1.4 0 0 1 7.15 3.5h3.5A1.4 1.4 0 0 1 12.05 4.9v3.5a1.4 1.4 0 0 1-1.4 1.4h-.6',
        },
      },
    ])
  }

  function closeGlyph() {
    return glyph([{ tag: 'path', attrs: { d: 'M4 4l8 8M12 4l-8 8' } }])
  }

  /** The DeepSeek mark, in the bar's own ink. */
  function logo() {
    var SVG = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('class', CLS('logo'))
    svg.setAttribute('viewBox', '0 0 50 50')
    svg.setAttribute('width', '20')
    svg.setAttribute('height', '20')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('aria-hidden', 'true')
    var path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', LOGO_PATH)
    path.setAttribute('fill', 'currentColor')
    svg.appendChild(path)
    return svg
  }

  /** Write the stylesheet into the page, once. */
  function installStyles() {
    if (document.getElementById(HOST_ID + '-style')) return
    var head = document.head || document.documentElement
    if (!head) return
    var style = document.createElement('style')
    style.id = HOST_ID + '-style'
    style.textContent = CSS
    head.appendChild(style)
    // The icon-hover preference is the user's, and the host's head script has
    // already published it by the time <body> exists and this bar mounts — so
    // honouring it here costs one attribute read. Read ONCE rather than
    // watched: this bar lives for seconds, the real bar (whose own hover rules
    // gate on the same attribute live) takes over the strip, and a preference
    // changed mid-boot landing one bar late is invisible. The rule overrides
    // the hover states by id specificity, so the off state is total — no
    // background, no red close tint, no opacity lift.
    if (document.documentElement.getAttribute('data-dsh-titlebar-hover') !== 'off') return
    var off = document.createElement('style')
    off.id = HOST_ID + '-style-hover-off'
    off.textContent = [
      '#' + HOST_ID + ' .' + CLS('item') + ':hover{opacity:.78;background:transparent}',
      '#' + HOST_ID + ' .' + CLS('control') + ':hover{background:transparent}',
      '#' + HOST_ID + ' .' + CLS('control') + '--close:hover{background:transparent;color:inherit}',
      '.' + CLS('menuItem') + ':hover{background:transparent}',
      '.' + CLS('aboutClose') + ':hover{opacity:1}',
    ].join('')
    head.appendChild(off)
  }

  /**
   * Mount the bar.
   *
   * Called as soon as `<body>` exists — before the app's own scripts run, because
   * those are deferred modules and this is not — so the bar is present for the
   * page's first paint rather than appearing over it.
   */
  function mount() {
    if (document.getElementById(HOST_ID)) return

    document.documentElement.style.setProperty(HEIGHT_PROPERTY, BAR_HEIGHT + 'px')
    installStyles()

    var menu = null
    var menuOpen = false
    var maximized = false

    /** Close the popup, if it is open. */
    function closeMenu() {
      if (menu && menu.parentNode) menu.parentNode.removeChild(menu)
      menu = null
      menuOpen = false
      more.setAttribute('aria-expanded', 'false')
    }

    /**
     * Open the 更多 popup under its trigger.
     *
     * Placed from the trigger's own rect rather than with CSS, because the bar is
     * `fixed` and the popup is a sibling of it in `<body>`: a CSS-only child would
     * have to inherit the bar's flex layout, which is what the real bar's portal
     * exists to avoid as well.
     */
    function openMenu() {
      var rect = more.getBoundingClientRect()
      var item = h('button', {
        type: 'button',
        class: CLS('menuItem'),
        role: 'menuitem',
        text: t('关于'),
      })
      // Pointer-down is suppressed so choosing the item never moves focus into
      // the popup — the same reason the trigger suppresses it.
      item.addEventListener('mousedown', function (event) {
        event.preventDefault()
      })
      item.addEventListener('click', function () {
        closeMenu()
        openAbout()
      })
      menu = h('div', { class: CLS('menu'), role: 'menu' }, [item])
      menu.style.left = Math.round(rect.left) + 'px'
      menu.style.top = Math.round(rect.bottom + 4) + 'px'
      document.body.appendChild(menu)
      var menuBox = menu.getBoundingClientRect()
      menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuBox.width - 8)) + 'px'
      menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuBox.height - 8)) + 'px'
      menuOpen = true
      more.setAttribute('aria-expanded', 'true')
    }

    /** The about dialog's overlay, or null while it is closed. */
    var overlay = null

    /** The Escape listener the open dialog installed, for its removal. */
    var overlayKeydown = null

    /** Remove the about dialog, if it is open. */
    function closeAbout() {
      if (!overlay) return
      document.removeEventListener('keydown', overlayKeydown)
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      overlay = null
      overlayKeydown = null
    }

    /**
     * Open the 关于 dialog.
     *
     * BUILT BY HAND, ON PURPOSE. The real bar's dialog is the app's own `Modal`
     * primitive; nothing like that exists in this world, and pulling a framework
     * in for one panel is exactly the dependency this script exists to avoid. So
     * the panel is plain elements shaped like the real one — same head row, same
     * enlarged whale, same sentence ({@link ABOUT_TEXT}) — under a mask that owns
     * the page for as long as it is open.
     *
     * Three ways out, like every dialog: the 关闭 button, a click on the mask
     * (a click inside the card is the dialog's own business), and Escape.
     */
    function openAbout() {
      if (overlay) return

      var close = h('button', { type: 'button', class: CLS('aboutClose'), text: t('关闭') })
      close.addEventListener('click', closeAbout)

      // The version arrives after the dialog is on screen, so the row is
      // appended when it answers rather than placeholdered beforehand. A failed
      // or unavailable read (`''`) omits the row entirely — the same degrade the
      // real bar's dialog ships: a dialog about the build must not claim a
      // build it cannot name.
      var ident = h('div', { class: CLS('aboutIdent') }, [
        h('div', { class: CLS('aboutName'), text: 'DeepseekHarness' }),
      ])

      overlay = h('div', { class: CLS('overlay') }, [
        h(
          'div',
          {
            class: CLS('about'),
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('关于'),
          },
          [
            h('div', { class: CLS('aboutHead') }, [
              h('div', { class: CLS('aboutMark') }, [logo()]),
              ident,
            ]),
            h('p', { class: CLS('aboutText'), text: ABOUT_TEXT }),
            h('div', { class: CLS('aboutFoot') }, [close]),
          ],
        ),
      ])

      overlay.addEventListener('mousedown', function (event) {
        if (event.target === overlay) closeAbout()
      })
      overlayKeydown = function (event) {
        if (event.key === 'Escape') closeAbout()
      }
      document.addEventListener('keydown', overlayKeydown)
      document.body.appendChild(overlay)

      var api = window.__TAURI__
      if (!api || !api.app || typeof api.app.getVersion !== 'function') return
      api.app.getVersion().then(function (version) {
        if (!overlay) return
        var text = String(version || '')
        if (text === '') return
        ident.appendChild(h('div', { class: CLS('aboutVersion'), text: t('版本 ') + text }))
      }, function () {
        /* As above: the row stays omitted. */
      })
    }

    var more = h(
      'button',
      {
        type: 'button',
        class: CLS('item'),
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        text: t('更多'),
      },
      [],
    )
    more.addEventListener('mousedown', function (event) {
      // Pointer-down is suppressed so clicking the bar never steals focus from
      // whatever the page has focused — the same reason the real bar does it.
      event.preventDefault()
    })
    more.addEventListener('click', function () {
      if (menuOpen) closeMenu()
      else openMenu()
    })

    /**
     * One window-control button.
     *
     * @param label - the accessible name and tooltip.
     * @param onClick - the handler.
     * @param icon - the glyph element.
     * @param extraClass - an extra class, for the close button's hover tint.
     * @returns the button.
     */
    function control(label, onClick, icon, extraClass) {
      var button = h(
        'button',
        {
          type: 'button',
          class: CLS('control') + (extraClass ? ' ' + extraClass : ''),
          'aria-label': label,
          title: label,
        },
        [icon],
      )
      button.addEventListener('mousedown', function (event) {
        event.preventDefault()
      })
      button.addEventListener('click', onClick)
      return button
    }

    /** Swap the maximize glyph for the state the window is actually in. */
    function syncMaximized() {
      invokeHost('window_is_maximized').then(function (value) {
        if (typeof value !== 'boolean' || value === maximized) return
        maximized = value
        var button = maximizeButton
        if (!button) return
        button.replaceChildren(maximized ? restoreGlyph() : maximizeGlyph())
        button.setAttribute('aria-label', maximized ? t('向下还原') : t('最大化'))
      }, function () {
        /* A failed query leaves the last known glyph. */
      })
    }

    var maximizeButton = control(
      t('最大化'),
      function () {
        invokeHost('window_toggle_maximize').then(function (value) {
          if (typeof value === 'boolean') {
            maximized = value
            maximizeButton.replaceChildren(maximized ? restoreGlyph() : maximizeGlyph())
            maximizeButton.setAttribute('aria-label', maximized ? t('向下还原') : t('最大化'))
          }
        }, function () {})
      },
      maximizeGlyph(),
    )

    var controls = h('div', { class: CLS('controls'), 'data-host': 'unknown' }, [
      control(
        t('最小化'),
        function () {
          invokeHost('window_minimize')
        },
        minimizeGlyph(),
      ),
      maximizeButton,
      control(
        t('关闭'),
        function () {
          invokeHost('window_close')
        },
        closeGlyph(),
        CLS('control') + '--close',
      ),
    ])

    var bar = h(
      'div',
      { id: HOST_ID, role: 'banner', 'aria-label': t('标题栏') },
      [
        h('div', { class: CLS('brand') }, [
          logo(),
          h('span', { class: CLS('wordmark'), text: 'deepseek' }),
          h('span', { class: CLS('badge'), text: 'HARNESS' }),
        ]),
        h('nav', { class: CLS('nav'), 'aria-label': t('主菜单') }, [more]),
        h('div', { class: CLS('spacer') }),
        controls,
      ],
    )

    // Dragging is delegated to the OS through the host command rather than a CSS
    // drag region: a decorationless window has no caption for the OS to drag.
    // Anything inside a button is excluded, so a click on a menu or a window
    // control never starts a window move.
    bar.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return
      if (event.target.closest && event.target.closest('button') !== null) return
      closeMenu()
      invokeHost('window_start_drag')
    })

    // Double-click toggles maximize, as a native caption does.
    bar.addEventListener('dblclick', function (event) {
      if (event.target.closest && event.target.closest('button') !== null) return
      invokeHost('window_toggle_maximize').then(function () {
        syncMaximized()
      }, function () {})
    })

    // A click anywhere else, or Escape, dismisses the popup — the behaviour every
    // menu has, and the only way to dismiss one that is not a modal.
    function onDocumentMouseDown(event) {
      if (!menuOpen) return
      if (menu && menu.contains(event.target)) return
      if (more.contains(event.target)) return
      closeMenu()
    }
    function onDocumentKeyDown(event) {
      if (menuOpen && event.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', onDocumentMouseDown, true)
    document.addEventListener('keydown', onDocumentKeyDown)

    document.body.appendChild(bar)
    syncMaximized()

    // Handed back to `retire` so the real bar's lifetime is not spent with this
    // one's document listeners still attached — or with its dialog still open:
    // a handoff mid-read would leave the mask stranded over the real bar.
    teardown = function () {
      closeMenu()
      closeAbout()
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      document.removeEventListener('keydown', onDocumentKeyDown)
      revealTimer = 0
    }

    /**
     * Show the window controls once a shell is known to be present.
     *
     * CHECKED ON A LADDER, NOT ONCE. A document-created script does not know
     * whether Tauri's own `withGlobalTauri` bridge has been injected yet, and the
     * two are independent initialization scripts. Starting hidden and revealing on
     * the first successful check means a browser tab never shows a second set of
     * controls (the native frame is already there), while the app reveals them
     * within a frame or two.
     *
     * The ladder is bounded: if no bridge ever appears the buttons stay hidden,
     * which is the correct outcome for a page that has no window to control, and
     * costs nothing but a few timers.
     */
    var attempts = 0
    var revealTimer = 0
    function revealControls() {
      if (hasHost()) {
        controls.setAttribute('data-host', 'yes')
        revealTimer = 0
        return
      }
      attempts += 1
      if (attempts < 5) revealTimer = window.setTimeout(revealControls, 40 * attempts)
    }
    revealControls()
  }

  /**
   * Removes everything the mounted bar installed, or `null` when none is mounted.
   *
   * Held rather than looked up, because the document-level listeners cannot be
   * found from the DOM: `removeEventListener` needs the exact function reference,
   * and a leftover capture listener would keep firing on every click of the real
   * bar's lifetime.
   */
  var teardown = null

  /**
   * Remove the bar and everything it installed.
   *
   * Called when the real bar announces itself. Everything this file added is
   * removed rather than left inert: the two bars occupy the same strip, so a
   * leftover one would sit on top of the real one at identical coordinates.
   */
  function retire() {
    if (typeof teardown === 'function') {
      try {
        teardown()
      } catch (error) {
        // A failing teardown must not prevent the removal below, which is the
        // part that actually matters: two visible bars is the bug.
      }
      teardown = null
    }

    var bar = document.getElementById(HOST_ID)
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar)
    var style = document.getElementById(HOST_ID + '-style')
    if (style && style.parentNode) style.parentNode.removeChild(style)
    document.removeEventListener(READY_EVENT, retire)
  }

  /**
   * Run `fn` as soon as `<body>` exists.
   *
   * A document-created script runs before the parser has produced anything, so
   * neither `<body>` nor necessarily `<html>` is available yet. Waiting for
   * `<body>` rather than for `DOMContentLoaded` is deliberate: DSH's own module
   * script is deferred, and `DOMContentLoaded` waits for it, which would leave the
   * splash — the exact page this bar is for — without a caption for as long as the
   * app takes to execute.
   *
   * @param fn - the callback.
   */
  function whenBody(fn) {
    if (document.body) {
      fn()
      return
    }

    var done = false
    function run() {
      if (done || !document.body) return
      done = true
      cleanup()
      fn()
    }
    function cleanup() {
      if (observer) observer.disconnect()
      document.removeEventListener('readystatechange', run)
      window.clearTimeout(timer)
    }

    var observer = null
    if (typeof MutationObserver === 'function' && document.documentElement) {
      observer = new MutationObserver(run)
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
    document.addEventListener('readystatechange', run)
    // A last resort for an engine where neither signal arrives: a bounded poll.
    var polls = 0
    var timer = 0
    function poll() {
      if (done || polls++ > 200) return
      if (document.body) {
        run()
        return
      }
      timer = window.setTimeout(poll, 10)
    }
    timer = window.setTimeout(poll, 10)
  }

  if (!isOwnTopLevelDocument()) return

  /**
   * Whether the real title bar has already taken over.
   *
   * Checked at mount time as well as from {@link retire}'s event, so this script
   * cannot install itself over a bar that announced before it ran.
   *
   * THE NULL CHECK IS NOT DEFENSIVE PARANOIA — IT IS THE BUG THIS FUNCTION SHIPPED
   * WITH. This script runs as a WebView2 **document-created** script, which `wry`
   * documents as running "before the HTML document has been parsed". At that moment
   * there is no `<html>` yet, so `document.documentElement` is `null` — measured with
   * CDP's equivalent (`Page.addScriptToEvaluateOnNewDocument`):
   *
   *     { documentElementIsNull: true, bodyIsNull: true, headIsNull: true,
   *       getAttributeThrew: true }
   *
   * Calling `getAttribute` on it therefore threw a `TypeError` at the TOP LEVEL of
   * the script, which killed the whole thing before `whenBody` ever ran — so the bar
   * never mounted on any page, and the boot page (whose window is
   * `decorations(false)`) had no close button at all. Note the shape of the mistake:
   * {@link whenBody} exists precisely to wait for the DOM, and this call sat in
   * front of it, guarding for `<body>` while tripping over `<html>`.
   *
   * "Not ready" is the correct answer when there is no document yet: a real bar
   * cannot have announced itself before the document exists.
   *
   * @returns {boolean} whether to stand down.
   */
  function realBarIsReady() {
    var root = document.documentElement
    if (!root) return false
    return root.getAttribute(READY_ATTRIBUTE) !== null
  }

  document.addEventListener(READY_EVENT, retire)

  if (realBarIsReady()) return

  whenBody(function () {
    // Re-checked here rather than only above: the real bar mounts on DSH's own
    // schedule, which can land between this script running and `<body>` existing.
    if (realBarIsReady()) return
    try {
      mount()
    } catch (error) {
      // A bar that cannot be built must not take the page down with it: the page
      // may be the app's own error screen, which is the one place the user needs
      // to read.
      if (window.console && window.console.warn) {
        window.console.warn('desktop title bar (boot): could not mount: ' + error)
      }
    }
  })
})()
