/* DeepseekHarness desktop — appearance overlay (DOM tier).
 *
 * Injected into the served page as an inline classic script by the desktop
 * app's host plugin. This tier covers what CSS cannot express: relocating
 * existing elements, reacting to live state, and marking nodes for styling.
 *
 * Injected as a plain <script>, NOT a module, so this file must stay a classic
 * script: no import/export, no top-level await.
 *
 * Grounding — selectors come from inspecting the live page, not guessing:
 *   #root > div > div[class*="_frame"]      the app frame
 *   [class*="_sidebarCol"]                  the left column
 *   [class*="_input"][contenteditable]      the composer's editable area
 *   body[data-ds-dark-theme]                dark mode marker
 * Each step fails quietly if a selector misses, so a DSH upgrade degrades to
 * "overlay does nothing" instead of a broken UI.
 *
 * The 原版 mode
 * -------------
 * `html[data-dsh-ui="vanilla"]` means "show the unmodified frontend". The CSS
 * tier handles its own half by gating every rule (see theme.css); this file
 * handles the DOM half, and the two jobs are different in kind:
 *
 *   - the periodic pass and the MutationObserver keep running, because the bar
 *     must still be able to switch back;
 *   - every decoration is either not applied at all (title sync, right-click
 *     takeover) or actively REMOVED, so the page stops carrying attributes the
 *     overlay added.
 *
 * The removals matter: `data-dsh-relocated` and `data-dsh-danger` are inert
 * once the stylesheet stops matching, but leaving them behind would mean the
 * page is not actually "the frontend with no project modifications" — and would
 * make the next switch back depend on state nobody re-derives. So vanilla runs
 * a real cleanup pass rather than merely skipping its work.
 *
 * WHY THE MODE IS READ FROM THE DOCUMENT, NOT PUSHED IN. The client plugin
 * (ui-client) owns the setting and writes the attribute; this tier reads it on
 * every pass. That keeps the two halves independent — either can be re-evaluated
 * alone, which is exactly what happens when the injected script is evaluated
 * more than once — and it means a mode change needs no message passing.
 */
(function () {
  'use strict'

  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)

  /** Poll interval while waiting for the app to mount, in ms. */
  var MOUNT_POLL_MS = 400

  /** Give up waiting after roughly 30 seconds. */
  var MOUNT_MAX_POLLS = 75

  /** Steady-state re-check interval, to survive React re-renders, in ms. */
  var WATCH_MS = 2000

  /** `<html>` attribute naming the UI mode; the CSS tier's gate keys off it. */
  var MODE_ATTRIBUTE = 'data-dsh-ui'

  /**
   * The label of the injected row on a WORKSPACE menu: a direct action.
   *
   * Kept as one constant because the title bar's 项目 menu offers the same item
   * from a different code path, and the two must read identically or the feature
   * looks like two different features.
   */
  var REVEAL_LABEL = t('在资源管理器打开')

  /**
   * The label of the injected row on a SESSION menu: a submenu parent.
   *
   * The ellipsis is the app's own convention for "this opens further" — its
   * session-header control labels its menu button 选择打开方式, and this row leads to
   * the same list.
   */
  var OPEN_LABEL = t('打开…')

  /**
   * The deep-link row's label and the link it copies.
   *
   * The scheme is the desktop shell's own (`deepseekharness://session/<id>`):
   * the DSH server URL cannot be shared — its port is OS-assigned per launch and
   * it carries a one-time token — so the link names only the session, and the
   * shell translates a click on it back into that session (see `deep_link.rs`
   * and the bridge's `openDeepLink`). Kept as one constant for the same reason
   * {@link REVEAL_LABEL} is: the title bar's 会话 menu offers the identical
   * action from a different code path, and the two must read identically.
   */
  var DEEP_LINK_PREFIX = 'deepseekharness://session/'
  var DEEP_LINK_LABEL = t('复制深度链接')

  // The same copy/download artwork used by the title bar's primitives.
  var COPY_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor"/>' +
    '<path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" fill="currentColor"/></svg>'
  var DOWNLOAD_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M8 1.95317V10.0469 M4.25 6.29688L8 10.0469L11.75 6.29688 M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469" stroke="currentColor"/></svg>'

  /**
   * The app's own folder-open glyph, as path data.
   *
   * Transcribed from `IconFolderOpenOutline16` in the shipped frontend bundle
   * (`dsh-web-frontend`, where it is exported from the same primitives map as the
   * icons the rest of this project already uses). It is copied rather than
   * imported for a reason that cannot be worked around: this file is a CLASSIC
   * script with no module system, so it cannot `require` the primitives module the
   * way `title-bar/client.js` does.
   *
   * The alternative — drawing a folder here — would put a second folder glyph in
   * one interface, beside the app's own on every workspace row. One piece of
   * artwork is worth the transcription, and the viewBox and `currentColor` fill
   * are the bundle's own.
   */
  var FOLDER_ICON_PATH =
    'M5.19629 1.57104C5.81144 1.5711 6.38623 1.8786 6.72754 2.39038L7.19922 3.09839C7.28454 3.22635 7.42824 3.30344 7.58203 3.30347H12.1699C13.5039 3.30348 14.5859 4.38548 14.5859 5.71948V6.62671C15.2694 7.02689 15.6605 7.85012 15.4385 8.68726L14.3848 12.658C14.1037 13.7164 13.1449 14.4527 12.0498 14.4529H2.91699C1.51651 14.4529 0.451662 13.2814 0.501954 11.9519V3.98706C0.501954 2.65305 1.58396 1.57104 2.91797 1.57104H5.19629ZM3.7793 7.75562C3.30994 7.75562 2.89883 8.07153 2.77832 8.52515L1.91602 11.7722C1.74167 12.4291 2.23734 13.073 2.91699 13.073H12.0498C12.5191 13.0728 12.9304 12.757 13.0508 12.3035L14.1045 8.33374C14.1819 8.04202 13.9619 7.756 13.6602 7.75562H3.7793ZM2.91797 2.9519C2.34625 2.9519 1.88281 3.41534 1.88281 3.98706V7.2937C2.33068 6.7269 3.02249 6.37476 3.7793 6.37476H13.2051V5.71948C13.2051 5.14777 12.7416 4.68434 12.1699 4.68433H7.58203C6.96675 4.6843 6.39209 4.37595 6.05078 3.86401L5.5791 3.15601C5.49379 3.02821 5.34995 2.95196 5.19629 2.9519H2.91797Z'

  /**
   * The app's own link glyph, as path data — the two halves of the chain.
   *
   * Transcribed from `IconLinkOutline16` in the shipped frontend bundle, for the
   * same reason as {@link FOLDER_ICON_PATH}: this file is a classic script with
   * no module system, so it cannot require the primitives module, and copying
   * the app's artwork keeps the injected row visually native. Same viewBox
   * (0 0 16 16), same `currentColor` fill; the two paths are the two chain halves
   * the app draws.
   */
  var LINK_ICON_PATHS = [
    'M9.94133 6.50173C11.3218 7.99603 11.3218 10.3011 9.94128 11.7954C9.88691 11.8542 9.82125 11.9196 9.72099 12.0198L7.75707 13.9838C7.65709 14.0838 7.592 14.1491 7.53334 14.2034C6.03906 15.5843 3.7327 15.5854 2.23827 14.2048C2.17933 14.1503 2.11374 14.0844 2.01315 13.9838C1.91318 13.8839 1.84922 13.8188 1.79495 13.7601C0.413857 12.2657 0.413909 9.95948 1.795 8.46503C1.84923 8.4064 1.91335 8.34115 2.01321 8.24129L3.79275 6.46313C3.71814 7.08101 3.75236 7.71445 3.90115 8.33518L3.00344 9.23151C2.89398 9.34097 2.8535 9.38307 2.82251 9.41658C1.93771 10.3744 1.93704 11.8514 2.82179 12.8092C2.85279 12.8427 2.89383 12.884 3.0034 12.9936C3.11272 13.1029 3.15429 13.1442 3.18777 13.1752C4.14561 14.0603 5.62381 14.0608 6.58178 13.1758C6.61532 13.1448 6.65722 13.1032 6.76685 12.9935L8.73077 11.0296C8.83999 10.9204 8.88142 10.8787 8.91238 10.8452C9.79744 9.88728 9.7969 8.40911 8.91173 7.45124C8.88074 7.41775 8.83944 7.3762 8.73011 7.26687C8.62082 7.15757 8.58061 7.11623 8.54712 7.08526C8.37347 6.92477 8.18243 6.79361 7.98088 6.69165L9.00289 5.66964C9.17506 5.78373 9.34035 5.91265 9.49663 6.05703C9.55538 6.11135 9.62026 6.17652 9.72036 6.27662C9.82094 6.3772 9.88686 6.4428 9.94133 6.50173Z',
    'M6.06816 9.49196C4.68626 7.99724 4.68667 5.68942 6.06885 4.19487C6.12268 4.13671 6.18789 4.07306 6.28706 3.9739L8.24541 2.01416C8.34478 1.91479 8.41018 1.85055 8.46845 1.79665C9.96301 0.414902 12.2689 0.414922 13.7635 1.79665C13.8217 1.85051 13.8866 1.91559 13.9858 2.01486C14.0849 2.11394 14.1502 2.17769 14.204 2.23583C15.5861 3.7304 15.5866 6.03823 14.2047 7.53291C14.1508 7.59125 14.0854 7.65638 13.9858 7.75595L12.1994 9.54098C12.2614 8.92982 12.2185 8.30587 12.0634 7.69657L12.9956 6.76573C13.1044 6.65692 13.1458 6.61529 13.1765 6.58205C14.0621 5.62404 14.0621 4.1454 13.1765 3.18738C13.1458 3.15419 13.104 3.1135 12.9956 3.00508C12.8877 2.89716 12.8471 2.85551 12.814 2.82485C11.8559 1.9389 10.376 1.93886 9.41794 2.82485C9.38479 2.85554 9.34381 2.89622 9.23564 3.00439L7.27728 4.96413C7.16875 5.07265 7.12708 5.11322 7.09636 5.14643C6.21074 6.10441 6.21153 7.58236 7.09705 8.5404C7.12775 8.57357 7.16826 8.61575 7.27659 8.72408C7.38456 8.83205 7.42647 8.87227 7.45958 8.90293C7.62849 9.0591 7.81309 9.1881 8.00856 9.28894L6.98795 10.3095C6.82111 10.1978 6.66052 10.0715 6.50872 9.93114C6.45057 9.87733 6.38547 9.81341 6.28637 9.71431C6.1871 9.61504 6.12202 9.55018 6.06816 9.49196Z',
  ]

  /**
   * The attribute family for the WINDOW'S OWN LAYOUT, which survives 原版.
   *
   * 原版 means "the frontend with none of this project's modifications", and this
   * tier enforces that by stripping every `data-dsh-desktop` tag. But the bar's
   * strip is not an appearance choice — the window is `decorations(false)`, so the
   * bar exists in 原版 too, and content underneath it must stay clear of it. Those
   * tags therefore live in their own family that {@link clearDecorations} never
   * touches.
   *
   * The distinction is worth stating plainly, because getting it wrong is the bug
   * this exists to fix: **appearance tags are removed in 原版, layout tags are not.**
   * When the dialog tag was `data-dsh-desktop='dialog'`, opening 设置 in 原版 put the
   * panel's header back under the bar (measured `panelTop: 24` against `46`).
   */
  var CHROME_ATTRIBUTE = 'data-dsh-chrome'

  /** The value marking a full-surface layer that must start below the bar. */
  var CHROME_LAYER = 'layer'

  /** The value meaning "unmodified frontend". */
  var VANILLA = 'vanilla'

  /**
   * The document title the app ships with.
   *
   * Restored when the overlay stops naming the active workspace, so vanilla
   * shows the frontend's own title rather than the last workspace the overlay
   * happened to write. Taken from the served `index.html` (`<title>DeepSeek
   * Harness</title>`), which is what the page had before this script ran.
   */
  var DEFAULT_TITLE = 'DeepSeek Harness'

  var polls = 0
  var timer = null
  var marked = new WeakSet()

  /**
   * Whether the overlay is switched off for the unmodified frontend.
   *
   * Read from the document on every use rather than cached, because the client
   * plugin can flip the attribute at any moment and the next pass must observe
   * it.
   *
   * @returns {boolean} whether 原版 mode is active.
   */
  function isVanilla() {
    return document.documentElement.getAttribute(MODE_ATTRIBUTE) === VANILLA
  }

  /**
   * Remove every attribute this tier adds, so 原版 really is the frontend.
   *
   * Each tag is inert once the stylesheet stops matching, so this is not about
   * appearance — it is about the page genuinely carrying no project
   * modifications. The `marked` set is replaced rather than cleared so the
   * composer, whose node may well be the same one, is re-decorated correctly on
   * the next switch back.
   *
   * @returns {boolean} whether anything was removed.
   */
  function clearDecorations() {
    var changed = false
    document.querySelectorAll('.dshPluginStatus').forEach(function (node) { node.remove() })
    var tagged = document.querySelectorAll('[data-dsh-desktop], [data-dsh-relocated], [data-dsh-danger]')
    for (var i = 0; i < tagged.length; i++) {
      var node = tagged[i]
      if (node.getAttribute('data-dsh-desktop') === 'nested-menu') {
        node.style.removeProperty('--dsh-menu-left')
        node.style.removeProperty('--dsh-menu-top')
      }
      if (node.hasAttribute('data-dsh-desktop')) node.removeAttribute('data-dsh-desktop')
      if (node.hasAttribute('data-dsh-relocated')) node.removeAttribute('data-dsh-relocated')
      if (node.hasAttribute('data-dsh-danger')) node.removeAttribute('data-dsh-danger')
      changed = true
    }

    // NOTE what is deliberately NOT removed: `data-dsh-chrome`. The bar's strip is
    // the window's layout, not this project's appearance — the window is
    // `decorations(false)` in both modes, so the bar is there in 原版 too and the
    // app under it must keep clear of it. Stripping these was the reported bug:
    // opening 设置 in 原版 slid the panel's header back under the bar.

    // The readiness flag also gates stylesheet behaviour, so it goes with them.
    if (document.documentElement.hasAttribute('data-dsh-ready')) {
      document.documentElement.removeAttribute('data-dsh-ready')
      changed = true
    }

    // Give the frontend its own title back; the overlay had replaced it with the
    // active workspace.
    if (document.title !== DEFAULT_TITLE) {
      document.title = DEFAULT_TITLE
      changed = true
    }

    marked = new WeakSet()
    return changed
  }

  /**
   * Mark the app as mounted, so CSS can gate itself on readiness.
   *
   * The overlay's stylesheet is injected in `<head>` and may apply before the
   * app has rendered anything. Exposing a flag lets the stylesheet delay
   * anything that would otherwise flash (transitions, the accent bar) until
   * there is something to show.
   */
  function markReady() {
    var root = document.documentElement
    if (root.getAttribute('data-dsh-ready') !== '1') {
      root.setAttribute('data-dsh-ready', '1')
    }
  }

  /**
   * Mark the composer so the CSS tier can style it, and skip the redundant work
   * of re-marking the same node on every pass.
   *
   * This is the canonical case for the DOM tier: CSS cannot create an attribute,
   * so the stylesheet needs this hook to target the composer reliably without
   * depending on a build-specific CSS-module hash.
   *
   * @returns {boolean} whether the composer was found.
   */
  function decorateComposer() {
    var input = document.querySelector('[class*="_input"][contenteditable="true"]')
    if (!input) return false
    var card = input.closest('[class*="_card"]') || input.parentElement
    if (card && !marked.has(card)) {
      marked.add(card)
      card.setAttribute('data-dsh-desktop', 'composer')
    }
    return true
  }

  /**
   * Reflect the active workspace in the document title.
   *
   * The desktop window has no browser tab to name the project. The native window
   * mirrors `document.title` (the Rust side registers a document-title handler),
   * so setting it here is what gives the taskbar and Alt-Tab a meaningful label.
   *
   * The value is read from the app's own sidebar rather than tracked separately,
   * so it cannot drift: `_projectRow` is the workspace name row, and
   * `_sessionRow_selected` is the active conversation. Both were verified
   * against the live DOM rather than guessed.
   */
  function syncTitle() {
    var sidebar = document.querySelector('[class*="_sidebarCol"]')
    if (!sidebar) return

    var project = sidebar.querySelector('[class*="_projectRow"]')
    var session = sidebar.querySelector('[class*="_sessionRow"][class*="_selected"]')
    var name = project ? (project.textContent || '') : ''
    if (!name) name = session ? (session.textContent || '') : ''
    name = name.replace(/\s+/g, ' ').trim()
    // Reject empty or absurd values (a row containing half the tree).
    if (name.length === 0 || name.length > 48) return

    var next = name + ' — DeepSeek Harness'
    if (document.title !== next) document.title = next
  }

  /**
   * Whether a settings row is one of the two this overlay relocates.
   *
   * Two shapes have to be handled, because the rows come from different CSS
   * modules:
   *
   *   - the appearance group has a dedicated `_title` child holding only the
   *     title ("外观");
   *   - the other rows use `<hash>_rowText`, which wraps the title *and* the
   *     description ("字号大小仅影响会话内容的字号…").
   *
   * So the title is the specific child when one exists, and otherwise the row's
   * own first text node. Matching uses a prefix test against the known titles
   * rather than equality on the whole string, because the description runs into
   * the same text content. A prefix is still narrow enough not to catch an
   * unrelated row: "外观" would match a hypothetical "外观模式说明", but no such
   * row exists, and a false positive would only hide a row the user can still
   * reach from the new section.
   *
   * @param {Element} row - a direct child of the settings item wrapper.
   * @param {string} title - the title to test for.
   * @returns {boolean} whether this row is that title.
   */
  function rowHasTitle(row, title) {
    var specific = row.querySelector("[class*='_title']")
    var scope = specific !== null ? specific : row
    // `firstChild` is the text node before the description element on rows that
    // use `_rowText`; falling back to textContent covers the rest.
    var firstText = ''
    for (var i = 0; i < scope.childNodes.length; i += 1) {
      var node = scope.childNodes[i]
      if (node.nodeType === 3 && (node.textContent || '').trim() !== '') {
        firstText = node.textContent
        break
      }
      if (node.nodeType === 1 && (node.textContent || '').trim() !== '') {
        firstText = node.textContent
        break
      }
    }
    var text = (firstText || scope.textContent || '').replace(/\s+/g, ' ').trim()
    return text.indexOf(title) === 0
  }

  /**
   * Tag the General rows this overlay relocates into the 外观 section.
   *
   * Those rows cannot be unregistered — the theme plugin owns the registrations
   * and offers no withdrawal — so they are tagged here and hidden by CSS, which
   * is why the relocated controls appear once rather than twice.
   *
   * The wrapper `[data-slot="settings.general.item"]` holds exactly one element
   * per General row, so its direct children are the rows.
   *
   * @returns {boolean} whether any row needed tagging.
   */
  function markRelocatedRows() {
    var wrapper = document.querySelector("[data-slot='settings.general.item']")
    if (!wrapper) return false

    var changed = false
    var children = wrapper.children
    for (var i = 0; i < children.length; i++) {
      var row = children[i]
      var relocate = rowHasTitle(row, t('外观')) || rowHasTitle(row, t('字号大小'))
      var current = row.getAttribute('data-dsh-relocated')
      var wanted = relocate ? 'true' : null
      if (current === wanted) continue
      changed = true
      if (wanted === null) row.removeAttribute('data-dsh-relocated')
      else row.setAttribute('data-dsh-relocated', wanted)
    }
    return changed
  }

  /** The settings shell gives unknown section ids a gear and accepts no icon
   * slot. Mark our two fixed labels; CSS replaces only their decorative glyphs,
   * leaving React's nodes and the navigation's accessible names intact. */
  function markSettingsNavigationIcons() {
    document.querySelectorAll('[role="dialog"] [class*="_navList"] > button').forEach(function (button) {
      var label = button.querySelector('[class*="_navLabel"]')
      var icon = button.querySelector('[class*="_navIcon"]')
      var text = label ? label.textContent.trim() : ''
      var wanted = icon && text === t('外观') ? 'settings-appearance'
        : icon && text === t('远程控制') ? 'settings-remote' : null
      var current = button.getAttribute('data-dsh-desktop')
      if (current === wanted) return
      if (wanted) button.setAttribute('data-dsh-desktop', wanted)
      else if (current === 'settings-appearance' || current === 'settings-remote') {
        button.removeAttribute('data-dsh-desktop')
      }
    })
  }

  /**
   * Tag the full-access permission with the role the stylesheet colours by.
   *
   * `danger-full-access` ("完全权限") is the preset that removes confirmation
   * steps and permits sensitive operations. The app already treats it as the
   * dangerous one — it is the only preset that opens a confirmation dialog, and
   * its own id says `danger` — but once selected it looks identical to the safe
   * presets. The stylesheet gives it a warning colour, and this is what tells it
   * where to apply:
   *
   *   `chip`     the composer's permission button while it shows that preset
   *   `selector` the settings row's dropdown button, same condition
   *   `item`     the 完全权限 entry inside either opened menu
   *
   * WHY TAG BY LABEL. CSS cannot select on text, and the CSS-module hashes
   * (`Sh0Q9G_trigger`, `oY77xG_selector`, `_item_1nxmc_92`) are regenerated every
   * build. The visible label is the one thing stable across both, and it is
   * matched EXACTLY so a longer label containing it — a description, or a future
   * "完全权限（危险）" — is not tagged by accident.
   *
   * The tag is only given to a node that *shows* the preset, never to the preset
   * id in general, so switching to a safer mode removes the warning immediately.
   */
  function markDangerPermission() {
    var LABEL = t('完全权限')

    // (a) The trigger buttons: the composer chip and the settings selector.
    // Only a button whose own visible label IS the preset qualifies, which
    // excludes the menus' wrapping elements (they contain the label too).
    var buttons = document.querySelectorAll('button')
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i]
      var text = (button.textContent || '').replace(/\s+/g, ' ').trim()
      // A trigger carries its value as its whole text; a menu item is handled
      // below, so an open menu's entries are excluded here by their role.
      var isMenuItem = button.getAttribute('role') === 'menuitem'
      var isTrigger = !isMenuItem && text === LABEL

      // Distinguish the two trigger surfaces by where they live: the settings
      // dialog versus the composer.
      var role = null
      if (isTrigger) {
        role = button.closest('[role="dialog"]') !== null ? 'selector' : 'chip'
      }
      var current = button.getAttribute('data-dsh-danger')
      var wanted = role
      if (current === wanted) continue
      if (wanted === null) button.removeAttribute('data-dsh-danger')
      else button.setAttribute('data-dsh-danger', wanted)
    }

    // (b) The 完全权限 entry inside an opened menu. Its text is the label, and a
    // menu item is identifiable by role or by living inside a [role="menu"].
    var menus = document.querySelectorAll("[role='menu']")
    for (var m = 0; m < menus.length; m++) {
      var items = menus[m].querySelectorAll('button, [role="menuitem"]')
      for (var j = 0; j < items.length; j++) {
        var item = items[j]
        var itemText = (item.textContent || '').replace(/\s+/g, ' ').trim()
        var wanted2 = itemText === LABEL ? 'item' : null
        var current2 = item.getAttribute('data-dsh-danger')
        if (current2 === wanted2) continue
        if (wanted2 === null) item.removeAttribute('data-dsh-danger')
        else item.setAttribute('data-dsh-danger', wanted2)
      }
    }
  }

  /**
   * Re-tag rows whenever the settings panel re-renders.
   *
   * Switching settings sections unmounts and remounts this subtree, creating new
   * nodes without the tag. Waiting for the periodic pass would leave the
   * duplicates visible for up to a second, so a MutationObserver applies the tag
   * as soon as the nodes exist.
   *
   * The observer is deliberately unconditional rather than installed on open:
   * the settings dialog does not exist until first opened, and re-observing on
   * every change would be more machinery than one document-wide observer.
   *
   * The permission tag rides the same observer, because the menus it must catch
   * are transient: they exist only while open, for a fraction of a second, and
   * the periodic pass would routinely miss them.
   *
   * The observer stands down in 原版 for a reason worth stating: it is the one
   * path that tags nodes BETWEEN periodic passes, so without this check a
   * re-render in vanilla mode would re-add `data-dsh-relocated` to a fresh
   * settings row moments after {@link clearDecorations} removed it. Skipping the
   * callback is cheaper and more direct than racing it.
   */
  function watchRelocatedRows() {
    if (typeof MutationObserver !== 'function') return
    var scheduled = false
    var observer = new MutationObserver(function () {
      // NOTE what is NOT here: a vanilla guard. It used to be the first line, and it
      // was a real bug — the frame callback below applies the LAYOUT tag (which both
      // modes need) as well as the appearance tags (which 原版 must not have), so
      // returning here meant a dialog opened while in 原版 was never tagged at all
      // and sat under the bar (measured: panelTop 24 with no tag, against 46 with
      // one). The mode split now happens INSIDE the frame, after the layout tag.
      //
      // THE LAYOUT TAG RUNS HERE, NOT IN THE FRAME. The callback is a microtask:
      // it always lands before the frame that will paint the mutation paints. The
      // tag is what starts the stylesheet's dialog-open animation and what holds
      // the layer below the bar, so a tag that waits for the frame can paint the
      // dialog ONCE un-offset and fully opaque before the fade — a one-frame blip,
      // measured live (first painted frame at top 50 and opacity 1, the animation
      // only starting on the next). The candidate scan is a few computed-style
      // reads, cheap enough per batch, and idempotent.
      //
      // Coalesce the APPEARANCE work: one render produces many records, and the
      // tagging below scans every button in the document.
      // Tag conditional bodies in the mutation microtask, before a quick close
      // can unmount them (animation frames may be throttled in the background).
      markCollapseBodies()
      // Every batch can mount a dialog, including one arriving while an earlier
      // batch is waiting for its appearance frame. Never defer its first paint.
      markFullSurfaceLayers(false)
      if (scheduled) return
      scheduled = true
      syncRemotePanelChrome()
      requestAnimationFrame(function () {
        scheduled = false
        // Everything past here is APPEARANCE, so 原版 stops: a re-render must not
        // re-add the relocated-row, permission and ungrouped-bucket tags that
        // `clearDecorations` has just removed.
        if (isVanilla()) return
        markRelocatedRows()
        markSettingsNavigationIcons()
        markDangerPermission()
        markUngroupedBucket()
        decoratePluginStatuses()
      })
    })
    var options = { childList: true, subtree: true }
    if (isRemotePage()) {
      options.attributes = true
      options.attributeFilter = ['data-sidebar-right-open', 'hidden', 'aria-selected']
      window.addEventListener('resize', syncRemotePanelChrome)
    }
    observer.observe(document.body, options)
  }

  /**
   * Tag the layout frame so the stylesheet can reserve the title bar's space.
   *
   * WHY THIS IS NEEDED AT ALL. The stylesheet could find the frame with
   * `:has(> [data-shell-overlay])`, which needs no JavaScript — and it does, as
   * the primary rule. This tag is the fallback for an engine without `:has()`,
   * which is why both exist rather than one.
   *
   * DO NOT REPLACE THIS WITH `[data-rightbar-collapsed]`, which is what the
   * stylesheet used first and why the layout broke when the right panel opened:
   * the app writes that attribute as `cols.rightbar === 0 || void 0`, and React
   * OMITS an attribute whose value is `void 0`. It is therefore present only
   * while the right panel is COLLAPSED — so expanding the panel dropped the
   * frame's padding and slid every column up under the bar.
   *
   * `data-shell-overlay` does not have that problem: it is written as the
   * literal `true`, on the frame's own overlay layer, which is always rendered.
   * The frame is its direct parent — a React Fragment sits between them in the
   * component tree but adds no DOM node.
   *
   * The frame tag is now only a FALLBACK. The bar's space is reserved by the
   * container (`#root` as a fixed box, see `theme.css`), which needs no JavaScript
   * and works in both modes; this tag only matters for an engine or a page where
   * `#root` is not the app's mount point.
   *
   * It is therefore tagged as CHROME, not as overlay decoration: it describes the
   * window's layout, so it must survive 原版 — see {@link CHROME_ATTRIBUTE}.
   *
   * @returns {boolean} whether the frame was found.
   */
  function decorateFrame() {
    var layer = document.querySelector('[data-shell-overlay]')
    if (!layer) return false
    var frame = layer.parentElement
    if (frame && !marked.has(frame)) {
      marked.add(frame)
      frame.setAttribute(CHROME_ATTRIBUTE, 'frame')
    }
    return true
  }

  /**
   * Elements that can be a full-surface layer, as a cheap pre-filter.
   *
   * WHY A ROLE SELECTOR. The alternative is `getComputedStyle` on every element
   * in the document, which measured ~1–2.4 ms over ~740 nodes — affordable twice
   * a second, but not on every mutation frame while the agent is streaming. Every
   * full-screen layer this app renders carries its role as part of its
   * accessibility contract (the same reason `theme.css` keys menus on
   * `[role="menu"]`), so this set is both tiny and stable across builds:
   *
   *   role="presentation"  the settings overlay, the modal root, onboarding
   *   role="dialog"        the image lightbox backdrop
   *   aria-modal="true"    the same, stated the other way
   *   role="status"        the drag-and-drop mask
   *
   * It is a PRE-filter, not the test: the real question is the computed inset
   * (see {@link isFullSurfaceLayer}). A backstop sweep of the whole document runs
   * on the periodic pass, so a future layer without a role is still caught within
   * two seconds rather than never.
   */
  var LAYER_CANDIDATES = '[role="presentation"], [role="dialog"], [aria-modal="true"], [role="status"]'

  /**
   * Whether an element is a full-surface layer, judged by its INSET.
   *
   * THE TEST IS THE SHAPE, NOT THE SIZE OR THE PARENT, and both of those were
   * wrong in earlier versions of this function:
   *
   *   - **Not the parent.** The first version only scanned `document.body.children`,
   *     on the assumption that the app portals its dialogs to `<body>`. It does
   *     portal some there (the modal root, the onboarding overlay, every menu),
   *     but the settings overlay — the one users open most — is rendered INSIDE
   *     `#root`, eleven levels down. It was therefore never tagged, its panel went
   *     on centring in the full viewport, and its header and close button slid
   *     under the bar. Measured live: `parentIsBody: false`, header hidden by 20px.
   *
   *   - **Not the size.** A `getBoundingClientRect()` height test misses a layer
   *     whose box is transiently short, and needs a layout read to answer.
   *
   * `inset: 0` on all four sides is what "I am a full-screen layer" MEANS, it is
   * readable from computed style without forcing layout, and it is self-selecting:
   *
   *   - the bar is `inset: 0 0 auto 0`, so its `bottom` is `auto` — never matches,
   *     and no name-based exclusion is needed;
   *   - every coordinate-positioned surface (menus, tooltips, hovercards, the dock
   *     float, the toast) is placed by JavaScript with `left`/`top` px and `auto`
   *     elsewhere — never matches. That matters: those compute their coordinates
   *     from `getBoundingClientRect()`, which is in REAL viewport space, so
   *     shifting them would put every menu 44px away from its trigger.
   *
   * @param {Element} node - a candidate element.
   * @returns {boolean} whether it is a full-surface layer.
   */
  function isFullSurfaceLayer(node) {
    if (!window.getComputedStyle) return false
    var style = window.getComputedStyle(node)
    if (!style || style.position !== 'fixed') return false
    return (
      style.top === '0px' &&
      style.right === '0px' &&
      style.bottom === '0px' &&
      style.left === '0px'
    )
  }

  /**
   * The bar's height, in px, as the stylesheet's own variable states it.
   *
   * The stylesheet offsets a tagged layer with
   * `top: var(--dsh-desktop-titlebar-height, 44px)`, so a TAGGED layer's computed
   * top is that value and no longer `0px` — which is exactly the value this
   * constant carries. It is read live rather than written down so the client
   * plugin's height and this answer cannot drift; a page without the variable
   * (the stylesheet not yet injected) falls back to the same 44px the stylesheet
   * itself falls back to.
   *
   * @returns {number} the bar's height in px.
   */
  function titlebarHeight() {
    try {
      var style = window.getComputedStyle(document.documentElement)
      if (style && typeof style.getPropertyValue === 'function') {
        var parsed = parseFloat(style.getPropertyValue('--dsh-desktop-titlebar-height'))
        if (parsed > 0) return parsed
      }
    } catch (error) {
      /* A computed style that throws must not break the pass; the fallback stands. */
    }
    return 44
  }

  /**
   * Whether a TAGGED element is still a full-surface layer, its own offset
   * discounted.
   *
   * THE RETIREMENT QUESTION, AND WHY IT IS NOT {@link isFullSurfaceLayer}. The
   * stylesheet moves a tagged layer's top edge down to the bar's height, so once
   * the tag is on, the layer's computed top reads the offset — `44px`, never
   * `0px`. Asking the unoffset question of a correctly tagged layer therefore
   * answers "no", and a retirement loop that asked it would strip the tag from
   * every layer it had just written, on every pass: the tag could never outlive
   * the synchronous call that set it, no layer was ever offset, and every dialog
   * centred in the full viewport with its header against the bar. Measured live
   * before the fix: tag written in the first loop, gone by the second, computed
   * `top` back to `0px`.
   *
   * So the retirement asks the SHAPE question with the offset accepted: still
   * fixed, still pinned to the other three edges, and its top either at the
   * viewport edge (untagged) or at the bar's height (tagged). A surface that
   * stopped being a layer at all — the right sidebar's panel docking back to
   * `position: absolute; top: 0` inside its column — still fails on its position
   * or its edges, which is the shape change retirement exists to catch.
   *
   * @param {Element} node - a candidate element.
   * @returns {boolean} whether it is a full-surface layer, offset or not.
   */
  function isOffsetFullSurfaceLayer(node) {
    if (!window.getComputedStyle) return false
    var style = window.getComputedStyle(node)
    if (!style || style.position !== 'fixed') return false
    if (style.right !== '0px' || style.bottom !== '0px' || style.left !== '0px') return false
    var offset = String(titlebarHeight()) + 'px'
    return style.top === '0px' || style.top === offset
  }

  /**
   * Tag every full-surface layer so the stylesheet can start it BELOW the bar.
   *
   * WHY THIS IS NEEDED. The bar is chrome: it stays above the app's dialogs, so
   * the window controls remain reachable while one is open and no mask dims it.
   * A dialog layer, meanwhile, is `position: fixed; inset: 0` and centres its
   * content in the FULL viewport — so with the bar over the top 44px, the
   * settings panel (`height: min(800px, 100vh - 48px)`) puts its header and its
   * own close button underneath the bar. That was the reported bug.
   *
   * The stylesheet's fix is one property: the layer's `top` becomes the bar's
   * height, so its box IS the area below the bar. Its mask then covers that area
   * and not the bar, and its content centres in the space actually available.
   *
   * THE TAG IS ALSO RETIRED, not only written. A tag that outlived the shape it
   * describes would keep the offset on a surface that stopped being full-surface:
   * the right sidebar's panel is ONE element that is `position: fixed; inset: 0`
   * while fullscreen and plain `position: absolute; top: 0` in its column when
   * docked, so a write-once tag pinned it 44px below its column's top edge after
   * docking back. Re-asking the question on every pass keeps the tag a statement
   * about the surface's PRESENT shape rather than its history. The tagged set is
   * a handful of layers, so the cost is a few computed-style reads per pass.
   *
   * @param {boolean} sweep - also inspect every element, not just
   *   {@link LAYER_CANDIDATES}. True on the slow periodic pass, false on the
   *   mutation-driven one, where the cost would be paid per render.
   * @returns {boolean} whether any tag was added or removed.
   */
  function markFullSurfaceLayers(sweep) {
    var changed = false
    // File previews can contain thousands of syntax/PDF nodes. On the phone,
    // known semantic layers cover the UI; reading every node's computed style
    // every two seconds stalls opening, closing and scrolling those previews.
    var selector = sweep && !isRemotePage() ? 'body *' : LAYER_CANDIDATES
    if (isRemotePage()) selector += ', [data-sidebar-right-panel], [data-sidebar-right-float-host]'
    var nodes = document.querySelectorAll(selector)
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      // A ghost is a fading clone of a surface that just unmounted, held only to
      // play its exit animation. It is inert by construction and must stay exactly
      // where its original was, so neither loop may touch it: a fresh tag here
      // would shift a not-yet-offset clone down by the bar's height mid-fade.
      if (node.getAttribute(GHOST_ATTRIBUTE)) continue
      // Already tagged: read the chrome family, which is the one this writes.
      if (node.getAttribute(CHROME_ATTRIBUTE) === CHROME_LAYER) continue
      // Settings already clears the title bar through its semantic CSS rule.
      // Accept that inset on first discovery too, or it never gets an entrance
      // animation. Coordinate-positioned popups still fail the other edges.
      if (!isFullSurfaceLayer(node) && !(node.matches(LAYER_CANDIDATES) && isOffsetFullSurfaceLayer(node))) continue
      node.setAttribute(CHROME_ATTRIBUTE, CHROME_LAYER)
      changed = true
    }

    // Retirement. Keyed on the tag's VALUE so the frame's own `data-dsh-chrome`
    // — a different shape of tag on a node that never was a layer — is not
    // touched. The question is the OFFSET shape ({@link
    // isOffsetFullSurfaceLayer}): the unoffset test would retire the tag it just
    // wrote, because the stylesheet's own offset changes the answer.
    var tagged = document.querySelectorAll('[' + CHROME_ATTRIBUTE + "='" + CHROME_LAYER + "']")
    for (var j = 0; j < tagged.length; j++) {
      var stale = tagged[j]
      if (stale.getAttribute(GHOST_ATTRIBUTE)) continue
      if (isOffsetFullSurfaceLayer(stale)) continue
      stale.removeAttribute(CHROME_ATTRIBUTE)
      changed = true
    }
    return changed
  }

  /** Keep React's status nodes intact; the button already exposes the localized
   * state in its accessible name. Only our decorative sibling is owned here. */
  function decoratePluginStatuses() {
    document.querySelectorAll('[data-plugin-module] > button[aria-label]').forEach(function (button) {
      var trailing = button.querySelector('[class*="_cardTrailing"]')
      if (!trailing) return
      var name = button.getAttribute('aria-label') || ''
      var separator = name.lastIndexOf(', ')
      if (separator < 0) return
      var label = name.slice(separator + 2)
      var nativeTag = trailing.querySelector('[data-tone]:not(.dshPluginStatus)')
      var tone = nativeTag ? nativeTag.getAttribute('data-tone') : 'success'
      var status = trailing.querySelector('.dshPluginStatus')
      if (!status) {
        status = document.createElement('span')
        status.className = 'dshPluginStatus'
        status.setAttribute('aria-hidden', 'true')
        var text = document.createElement('span')
        text.className = 'dshPluginStatus__text'
        status.appendChild(text)
        trailing.insertBefore(status, trailing.firstChild)
      }
      if (status.getAttribute('data-tone') !== tone) status.setAttribute('data-tone', tone)
      if (status.firstChild.textContent !== label) status.firstChild.textContent = label
    })
  }

  /** Run one overlay pass. @returns {boolean} whether the app had mounted. */
  function pass() {
    // The remote page's quick actions are window chrome, like the bar they sit
    // in: they are rebuilt in 原版 too, where the drawer CSS still applies and
    // the rail is still gone — without them a phone in 原版 would have no way to
    // reach 新会话 / 插件 / 设置 at all.
    syncRemoteQuickActions()
    syncRemotePanelChrome()

    // Vanilla: the frontend must carry none of this overlay's marks, so the pass
    // is a cleanup rather than a skip. The right-click listener likewise stands
    // down (see {@link onContextMenu}).
    if (isVanilla()) {
      clearDecorations()
      // THE CHROME TAGS ARE STILL APPLIED, and this is the whole point of the split
      // between the two attribute families. 原版 removes this project's appearance
      // changes; it does not remove the window's title bar, which exists in both
      // modes because the window is `decorations(false)`. A full-screen layer must
      // therefore keep clear of the bar's strip in 原版 too — skipping this is what
      // put the settings panel's header back under the bar the moment the user
      // switched to 原版.
      markFullSurfaceLayers(true)
      // Still report readiness: the mount poll uses this to stop waiting and
      // hand over to the steady-state interval, which is what keeps watching for
      // a switch back to the new styles.
      return decorateComposerPresent()
    }

    // `sweep: true` — the periodic pass is the backstop that catches a layer with
    // no role of its own, which the cheap candidate set would miss.
    markFullSurfaceLayers(true)

    var ready = decorateComposer()
    if (ready) {
      // The frame is tagged on the same pass, so the fallback offset exists as soon
      // as the layout does. Its result is ignored deliberately: a missing frame must
      // not hold back the rest of the pass.
      decorateFrame()
      markReady()
      syncTitle()
      markRelocatedRows()
      markSettingsNavigationIcons()
      markDangerPermission()
      markUngroupedBucket()
      markCollapseBodies()
      decoratePluginStatuses()
    }
    return ready
  }

  /**
   * Whether the composer exists, without decorating it.
   *
   * The mount poll only needs to know the app rendered; in vanilla the composer
   * must not be tagged, so this answers the question without touching the DOM.
   *
   * @returns {boolean} whether the composer was found.
   */
  function decorateComposerPresent() {
    return document.querySelector('[class*="_input"][contenteditable="true"]') !== null
  }

  /** Wait for the app to mount, then keep watching it. */
  function begin() {
    if (pass()) {
      timer = setInterval(pass, WATCH_MS)
      return
    }
    if (polls++ < MOUNT_MAX_POLLS) {
      timer = setTimeout(begin, MOUNT_POLL_MS)
    }
  }

  // ── right-click opens the row's own menu at the cursor ────────────────────
  //
  // The app's rows carry a "..." button whose menu React owns. Rather than
  // building a second menu, a right-click finds that row's button and clicks it,
  // then moves the menu to the cursor. That keeps exactly one menu implementation
  // and one set of items, so the options can never drift apart.
  //
  // The menu is rendered into a `position: fixed` portal at coordinates the
  // component computes from the button. Writing `left`/`top` on it afterwards is
  // therefore honoured, and survives React's re-renders (verified).

  /** Viewport inset kept clear when clamping a menu to the window, in px. */
  var MENU_MARGIN = 8

  /** How many frames to wait for React to mount the menu before giving up. */
  var MENU_MOUNT_FRAMES = 20

  /**
   * How many further frames to keep re-asserting the position after the first
   * successful placement. React re-renders the portal after mount (focus
   * handling, scroll listeners), and each render rewrites the inline
   * coordinates, so a single placement can be undone a frame later.
   */
  var REASSERT_FRAMES = 6

  /**
   * The actions button belonging to a row.
   *
   * The button is present in the DOM even when the row is not hovered — its
   * container is only hidden by CSS — so this works without synthesizing hover.
   * Rows without a menu (a blank "new session" row) simply have no button.
   *
   * @param {Element} node - an element inside a row.
   * @returns {HTMLButtonElement|null} the trigger, or null when the row has none.
   */
  function actionsButtonFor(node) {
    var el = node
    for (var i = 0; i < 6 && el; i++) {
      if (/\b_row\b|Row\b/i.test(String(el.className || ''))) {
        var actions = el.querySelector('[class*="rowActions"]')
        if (actions) return actions.querySelector('button')
        return null
      }
      el = el.parentElement
    }
    return null
  }

  /**
   * Move an open portal menu so it sits at the cursor, clamped to the viewport.
   *
   * Placement is measured after the menu has rendered, because its size decides
   * whether it must be clamped or flipped to stay on screen.
   *
   * @param {number} x - cursor x.
   * @param {number} y - cursor y.
   * @returns {boolean} whether a menu was found and moved.
   */
  function placeAtCursor(x, y) {
    var menu = openMenuElement()
    if (!menu) return false

    var rect = menu.getBoundingClientRect()
    var maxX = window.innerWidth - rect.width - MENU_MARGIN
    var maxY = window.innerHeight - rect.height - MENU_MARGIN

    var left = Math.max(MENU_MARGIN, Math.min(x, maxX))
    var top = Math.max(MENU_MARGIN, Math.min(y, maxY))

    // React sets these two through the portal's inline style, so overriding them
    // here repositions the menu without a re-render. `margin` is zeroed because
    // the anchor-positioned variant carries an offset that would otherwise shift
    // the clamped result.
    menu.style.margin = '0'
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
    return true
  }

  /**
   * Wait for the menu to mount, then place it at the cursor.
   *
   * React renders the menu on the state update triggered by `click()`, which
   * lands asynchronously — a single animation frame is not reliably enough, and
   * the menu would keep the position the component computed from its button.
   * So this polls briefly and re-places on each frame, which also corrects the
   * menu if React re-renders and rewrites the coordinates afterwards.
   *
   * @param {number} x - cursor x.
   * @param {number} y - cursor y.
   */
  function placeWhenMounted(x, y) {
    var attempts = 0

    var step = function () {
      if (placeAtCursor(x, y)) {
        // Placed once; keep watching for a few more frames because a React
        // re-render can restore the component's own coordinates.
        if (attempts++ < REASSERT_FRAMES) {
          requestAnimationFrame(step)
        }
        return
      }
      if (attempts++ < MENU_MOUNT_FRAMES) {
        requestAnimationFrame(step)
      }
    }

    requestAnimationFrame(step)
  }

  /**
   * Handle a right-click anywhere in the app.
   *
   * @param {MouseEvent} event - the contextmenu event.
   */
  function onContextMenu(event) {
    // In 原版 the native menu is left alone: suppressing the browser menu is a
    // project modification like any other. The listener stays installed and
    // simply returns, so switching back does not need it re-bound.
    if (isVanilla()) return

    // Cancel the native browser menu. This is a desktop shell, so the OS menu
    if (event.target.closest?.('[data-dsh-terminal]')) return
    // (Back/Reload/Save as…) is out of place, and the app provides its own.
    event.preventDefault()

    var button = actionsButtonFor(event.target)
    if (!button) {
      openTextMenu(event)
      return
    }

    // A right-click should replace any menu that is already open rather than
    // stacking a second one.
    closeOpenMenu()

    var x = event.clientX
    var y = event.clientY
    button.click()
    placeWhenMounted(x, y)
  }

  /** Close any open menu, so a new one does not stack on top of it. */
  function closeOpenMenu() {
    // Ghosts are excluded: Escape is the app's dismissal key for the LIVE menu,
    // and a fading copy must not be able to close a dialog with it.
    if (openMenuElement()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
  }

  var dismissTextMenu = null

  /** Text operations preserve the selection that existed before the menu took focus. */
  function openTextMenu(event) {
    var target = event.target
    if (!target?.closest || target.closest('[role="menu"], .xterm') || getComputedStyle(target).userSelect === 'none') return
    var editable = target.closest('textarea, input, [contenteditable]:not([contenteditable="false"])')
    var region = target.closest('[data-textpreview-path][data-path-label], [data-textpreview-plain], [data-code-preview] [data-code-block-content], [data-document-markdown], .dshChanges__code, [data-conversation-region]')
    if (!editable && !region) return
    if (editable && editable.tagName === 'INPUT' && !/^(text|search|url|tel|email|password)$/.test(editable.type)) return
    var writable = editable && !editable.readOnly && !editable.disabled
    var input = editable && /^(INPUT|TEXTAREA)$/.test(editable.tagName)
    var selection = window.getSelection()
    var ranges = []
    for (var i = 0; selection && i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange())
    var start = input ? editable.selectionStart : null
    var end = input ? editable.selectionEnd : null
    var direction = input ? editable.selectionDirection : null
    var selected = input ? editable.value.slice(start || 0, end || 0) : String(selection || '')
    if (editable?.type === 'password') selected = ''
    var previousFocus = document.activeElement
    var api = window.__TAURI__?.core
    var clipboard = navigator.clipboard

    function restore() {
      if (editable && !editable.isConnected) return false
      if (editable) editable.focus()
      if (input && start !== null) editable.setSelectionRange(start, end, direction)
      else if (selection) {
        selection.removeAllRanges()
        ranges.forEach(function (range) { if (range.commonAncestorContainer.isConnected) selection.addRange(range) })
      }
      return true
    }
    function copy() {
      if (api) return api.invoke('clipboard_write_text', { text: selected })
      if (clipboard?.writeText) return clipboard.writeText(selected)
      document.execCommand('copy')
    }
    function edit(key) {
      if (!writable || !restore()) return
      if (api) return api.invoke('clipboard_edit_shortcut', { key: key }).then(function (sent) {
        if (!sent) throw new Error(t('请先激活应用窗口后重试'))
      })
      if (key === 'x') { document.execCommand('cut'); return }
      if (clipboard?.readText) return clipboard.readText().then(function (text) {
        if (restore()) document.execCommand('insertText', false, text)
      })
      document.execCommand('paste')
    }
    function selectAll() {
      if (input) { editable.focus(); editable.select(); return }
      var scope = editable || region
      if (!scope?.isConnected) return
      if (editable) editable.focus()
      var range = document.createRange()
      range.selectNodeContents(scope)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    var entries = [
      { label: t('剪切'), key: 'X', enabled: Boolean(writable && selected), run: function () { return edit('x') } },
      { label: t('复制'), key: 'C', enabled: Boolean(selected), run: copy },
      { label: t('粘贴'), key: 'V', enabled: Boolean(writable), run: function () { return edit('v') } },
      { label: t('全选'), key: 'A', enabled: true, run: selectAll },
    ]
    showTextMenu(event, entries, {
      scope: editable || region,
      restore: function () {
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
        restore()
      },
    })
  }

  /** One renderer for DOM text and terminal buffer actions. The terminal supplies
   * its own clipboard actions and, when needed, a parent that retains input control. */
  function showTextMenu(point, entries, options) {
    if (isVanilla()) return null
    options = options || {}
    if (dismissTextMenu) dismissTextMenu(false)
    closeOpenMenu()
    var menu = document.createElement('div')
    menu.className = 'dshTextMenu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', t('文字操作'))
    menu.tabIndex = -1
    var closed = false
    var buttons = entries.map(function (entry) {
      var button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.setAttribute('aria-keyshortcuts', 'Control+' + entry.key)
      button.disabled = !entry.enabled
      var label = document.createElement('span')
      label.className = 'dshTextMenu__label'
      label.textContent = entry.label
      var shortcut = document.createElement('span')
      shortcut.className = 'dshTextMenu__shortcut'
      shortcut.setAttribute('aria-hidden', 'true')
      shortcut.textContent = 'Ctrl+' + entry.key
      button.append(label, shortcut)
      button.addEventListener('mousedown', function (e) { e.preventDefault() })
      button.addEventListener('click', function () {
        dismiss(true)
        Promise.resolve().then(entry.run).catch(options.onError || function (error) { showDesktopToast(t('文字操作失败：') + String(error), true) })
      })
      menu.appendChild(button)
      return button
    })
    function dismiss(refocus) {
      if (closed) return
      closed = true
      menu.remove()
      observer.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', keyboard, true)
      document.removeEventListener('dsh-desktop:ui-mode', modeChanged)
      window.removeEventListener('resize', resized)
      dismissTextMenu = null
      if (refocus) options.restore?.()
      options.onDismiss?.()
    }
    function outside(e) { if (!menu.contains(e.target)) dismiss(false) }
    function resized() { dismiss(false) }
    function modeChanged() { if (isVanilla()) dismiss(false) }
    function keyboard(e) {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation(); dismiss(true); return
      }
      var enabled = buttons.filter(function (b) { return !b.disabled })
      var index = enabled.indexOf(document.activeElement)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation()
        var next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1
          : index < 0 ? (e.key === 'ArrowUp' ? enabled.length - 1 : 0)
          : (index + (e.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length
        enabled[next]?.focus()
      } else if ((e.key === 'Enter' || e.key === ' ') && index >= 0) {
        e.preventDefault(); e.stopPropagation(); enabled[index].click()
      }
    }
    var observer = new MutationObserver(function () {
      var scope = options.scope
      if (scope && (!scope.isConnected || !scope.getClientRects().length || scope.closest('[hidden]'))) dismiss(false)
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    ;(options.parent || document.body).appendChild(menu)
    var box = menu.getBoundingClientRect()
    menu.style.left = Math.max(8, Math.min(point.clientX, window.innerWidth - box.width - 8)) + 'px'
    menu.style.top = Math.max(8, Math.min(point.clientY, window.innerHeight - box.height - 8)) + 'px'
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', keyboard, true)
    document.addEventListener('dsh-desktop:ui-mode', modeChanged)
    window.addEventListener('resize', resized)
    dismissTextMenu = dismiss
    // Mouse opening focuses only the container; no command is preselected.
    // Arrow keys still enter the list, and keyboard invocation has an initial item.
    var focus = options.keyboard ? buttons.find(function (b) { return !b.disabled }) : menu
    ;(focus || menu).focus({ preventScroll: true })
    return { menu: menu, dismiss: dismiss }
  }

  // ── a menu does not close just because the pointer left it ────────────────
  //
  // THE REPORTED BUG. Right-click a workspace row and the menu opens at the
  // cursor. Move the pointer onto the menu — still open. Move it off again — the
  // menu is gone, even though nothing was chosen and nothing was clicked. The
  // user wants the menu to behave as if the pointer had never entered it.
  //
  // WHY IT HAPPENS, MEASURED RATHER THAN GUESSED. The app's `Menu` primitive
  // renders
  //
  //     <span onPointerEnter={cancel} onPointerLeave={() => open && close()}>
  //       {anchor}
  //       {portal ? createPortal(list, document.body) : list}
  //     </span>
  //
  // and the row menus pass `portal: true` with `closeOnPointerLeave: true`. React
  // renders a portal's children into the portal CONTAINER while keeping them on
  // the ancestor tree for event propagation, so a `pointerleave` observed on the
  // menu is dispatched to that root `<span>` as well, whose handler closes the
  // menu. Verified live with real mouse input: pointer onto the menu kept it open
  // (`stillOpen: true`), pointer off it closed it (`stillOpen: false`).
  //
  // That pairing is deliberate for a hover-opened menu — the enter/leave pair is
  // what makes a menu follow the pointer across a submenu. But this app OPENS
  // these menus on a CLICK (a left-click on the row's "..." button, or a
  // right-click, which the overlay turns into exactly that click), and a
  // click-opened menu is not a hover affordance: it is dismissed by choosing an
  // item, by clicking outside, or by Escape.
  //
  // HOW THIS FIXES IT. The close is driven by a native `pointerout` that React
  // turns into the synthetic `pointerleave`. React 17+ attaches its listeners to
  // the ROOT CONTAINER it renders into, in the CAPTURE phase — for a menu
  // portalled to `document.body`, that is a capture listener on `body`. Both
  // facts were read off the live page with `DOMDebugger.getEventListeners`, not
  // inferred. A capture listener on `document` is therefore always ahead of
  // React's, so `stopPropagation` here means React never builds the synthetic
  // event at all.
  //
  // WHAT IS SUPPRESSED, AND WHAT IS NOT. Only a move that LEAVES A MENU FOR
  // SOMETHING OUTSIDE THAT SAME MENU:
  //
  //   - `relatedTarget` still inside the menu  → left alone. The app's submenu
  //     hover state is driven by the items' own `onMouseEnter`/`onMouseLeave`
  //     (a different pair of events, and not suppressed), but suppressing
  //     intra-menu moves as well would be wrong on principle: nothing is leaving.
  //   - `relatedTarget` inside a NESTED menu → left alone, for the same reason.
  //     A submenu is a `[role="menu"]` in its own right and is a descendant of
  //     the item's wrapper, so `menu.contains(to)` covers it.
  //   - `relatedTarget === null` → suppressed. That is the pointer leaving the
  //     window entirely (`pointerout` with no related target), which is the same
  //     intention as leaving the menu.
  //
  // The guard is only ever armed while a menu is actually on the page, and it
  // never touches `pointerenter`/`pointerover`, so the "cancel the pending close"
  // half of the pair keeps working untouched.

  /**
   * Whether a menu should stay open as the pointer moves off `from`.
   *
   * @param {Node} from - the element the pointer is leaving.
   * @param {EventTarget|null} to - where it is going, as the event reports it.
   * @returns {boolean} whether to withhold the leave from React.
   */
  function keepsMenuOpen(from, to) {
    var menu = from.closest ? from.closest('[role="menu"]') : null
    if (!menu) return false
    // Still inside this menu (or a submenu nested in it): a real move within the
    // menu, which is not a leave at all.
    //
    // `to` is tested for being a Node before `contains` is called on it. The
    // event's `relatedTarget` is typed as a bare EventTarget and can legitimately
    // be a Window or an already-detached node; `Node.contains` THROWS on a
    // non-Node argument, and a throw inside a capture listener would break the
    // app's own event handling rather than merely misjudging one move.
    if (to && typeof to.nodeType === 'number' && menu.contains(to)) return false
    // Gone from the window entirely: treated as a leave, because it is one.
    return true
  }

  /**
   * Withhold a menu's pointer-leave from the app, so it cannot close the menu.
   *
   * Cheap by construction: the element test answers "no" for every element that
   * is not inside a menu, which is the overwhelming majority of pointer movement
   * in the app, and one `closest` call is the whole cost.
   *
   * STANDS DOWN IN 原版, for the same reason {@link onContextMenu} does: how a
   * menu is dismissed is the frontend's behaviour, and 原版 means the frontend
   * with none of this project's modifications. The listener stays installed and
   * simply returns, so switching back needs no re-binding.
   *
   * @param {MouseEvent} event - the pointerout event.
   */
  function onPointerOut(event) {
    if (isVanilla()) return
    // A malformed event must not break the app's own handling, so an unexpected
    // shape means "do nothing" rather than a throw inside a capture listener.
    var from = event.target
    if (!from || from.nodeType !== 1) return
    if (!keepsMenuOpen(from, event.relatedTarget)) return
    event.stopPropagation()
  }

  // React's submenu closes on mouseleave (not pointerleave). Keep its active
  // wrapper open across the panel's padding and the gap to the nested surface.
  // Moving to another row still reaches React and switches the active submenu.
  function onSubmenuMouseOut(event) {
    if (isVanilla()) return
    var from = event.target
    var menu = from?.closest?.('[role="menu"]')
    if (!menu) return
    var root = menu
    while (root.parentElement?.closest('[role="menu"]')) root = root.parentElement.closest('[role="menu"]')
    var expanded = root.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')
    if (!expanded || !expanded.parentElement.contains(from)) return
    var to = event.relatedTarget
    if (to && typeof to.nodeType === 'number' && expanded.parentElement.contains(to)) return
    if (to?.closest?.('[role="menuitem"]') && root.contains(to)) return
    event.stopPropagation()
  }

  /**
   * Install the right-click binding.
   *
   * Capture phase: the app's own handlers may call `stopPropagation`, and a
   * right-click must still be seen. Suppressing the native menu is also why the
   * listener is on `document` rather than on each row — rows are created and
   * destroyed constantly, and re-binding per row would both miss new rows and
   * leak listeners.
   *
   * INSTALLED AT MOST ONCE. The toggle-shaped trigger means a second live
   * listener opens the menu and immediately closes it again, which looks exactly
   * like "right-click does nothing". This happens for real: the overlay script
   * can be evaluated more than once in a page (a reload of the injected row, a
   * second evaluation during development), and each evaluation would otherwise
   * add another listener. The flag is on `window`, so it survives across those
   * separate evaluations, unlike a module-scope variable.
   */
  function installContextMenu() {
    if (window.__dshDesktopContextMenu === true) return
    window.__dshDesktopContextMenu = true
    window.__DSH_TEXT_MENU__ = showTextMenu
    document.addEventListener('contextmenu', onContextMenu, true)
    // Registered on `document` in the CAPTURE phase, which is what puts it ahead
    // of the app's handler for the same event — see {@link onPointerOut}.
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('mouseout', onSubmenuMouseOut, true)
  }

  /** Inline file references are buttons upstream. A completed text drag must
   * not run their opener when the browser follows pointerup with click. */
  function installFileReferenceSelection() {
    if (window.__dshFileReferenceSelection) return
    window.__dshFileReferenceSelection = true
    var selector = ':is([data-conversation-region], [data-document-markdown]) button[class*="_fileMention"]'
    var start = null
    document.addEventListener('pointerdown', function (event) {
      var button = event.target.closest && event.target.closest(selector)
      start = !isVanilla() && event.button === 0 && button
        ? { button: button, x: event.clientX, y: event.clientY } : null
    }, true)
    document.addEventListener('pointercancel', function () { start = null }, true)
    document.addEventListener('click', function (event) {
      var drag = start
      start = null
      if (isVanilla() || !drag || event.detail === 0 || event.button !== 0 || !drag.button.contains(event.target)) return
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return
      var selection = window.getSelection()
      if (!selection || selection.isCollapsed) return
      for (var i = 0; i < selection.rangeCount; i++) {
        if (!selection.getRangeAt(i).intersectsNode(drag.button)) continue
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
    }, true)
  }

  /** Image previews reuse the upstream pinch zoom, toolbar and tab-local scale. */
  function installImagePreviewGestures() {
    if (window.__dshImagePreviewGestures || typeof window.WheelEvent !== 'function') return
    window.__dshImagePreviewGestures = true
    var drag = null
    function imageScrollport(target) {
      var node = target.closest && target.closest('[data-textpreview-body] [data-document-zoom-scrollport]')
      if (!node || node.closest('[data-dsh-ghost]')) return null
      var image = node.querySelector('[data-image-preview] [data-document-zoom-surface]:not([hidden]) img')
      return image && image.complete && image.naturalWidth > 0 ? node : null
    }
    function finishDrag() {
      var previous = drag
      drag = null
      if (!previous) return
      previous.node.removeAttribute('data-dsh-image-dragging')
      if (previous.node.hasPointerCapture(previous.id)) previous.node.releasePointerCapture(previous.id)
    }
    document.addEventListener('wheel', function (event) {
      if (isVanilla() || event.defaultPrevented || event.ctrlKey || !event.deltaY) return
      var node = imageScrollport(event.target)
      if (!node) return
      // Forward only to this scrollport's existing Ctrl+wheel handler. It owns
      // pointer anchoring, zoom limits, the percentage display and persistence.
      var pinch = new WheelEvent('wheel', {
        cancelable: true, ctrlKey: true,
        clientX: event.clientX, clientY: event.clientY,
        deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
        deltaMode: event.deltaMode
      })
      node.dispatchEvent(pinch)
      // If an upstream update removes its handler, leave normal scrolling alone.
      if (pinch.defaultPrevented) {
        event.preventDefault()
        event.stopPropagation()
      }
    }, { capture: true, passive: false })
    document.addEventListener('pointerdown', function (event) {
      if (isVanilla() || event.defaultPrevented || event.button !== 0 || event.pointerType !== 'mouse') return
      var node = imageScrollport(event.target)
      if (!node) return
      var rect = node.getBoundingClientRect()
      var scaleX = rect.width / node.offsetWidth
      var scaleY = rect.height / node.offsetHeight
      var x = (event.clientX - rect.left) / scaleX - node.clientLeft
      var y = (event.clientY - rect.top) / scaleY - node.clientTop
      // Native scrollbar thumbs keep their own drag behavior.
      if (x < 0 || y < 0 || x >= node.clientWidth || y >= node.clientHeight) return
      finishDrag()
      node.setPointerCapture(event.pointerId)
      drag = { node: node, id: event.pointerId, x: event.clientX, y: event.clientY, scaleX: scaleX, scaleY: scaleY }
      node.setAttribute('data-dsh-image-dragging', '')
      event.preventDefault()
    }, true)
    document.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.id) return
      if (isVanilla() || !(event.buttons & 1) || !drag.node.isConnected || !drag.node.getClientRects().length) {
        finishDrag()
        return
      }
      drag.node.scrollLeft -= (event.clientX - drag.x) / drag.scaleX
      drag.node.scrollTop -= (event.clientY - drag.y) / drag.scaleY
      drag.x = event.clientX
      drag.y = event.clientY
      event.preventDefault()
    }, true)
    ;['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) {
      document.addEventListener(type, function (event) { if (drag && event.pointerId === drag.id) finishDrag() }, true)
    })
    window.addEventListener('blur', finishDrag)
    document.addEventListener('visibilitychange', function () { if (document.hidden) finishDrag() })
    var mode = new MutationObserver(function () { if (isVanilla()) finishDrag() })
    mode.observe(document.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] })
  }

  /** Reveal the filename when a preview opens, without resetting a user's scroll. */
  function watchPreviewPaths() {
    if (typeof MutationObserver !== 'function' || typeof ResizeObserver !== 'function') return
    if (window.__dshPreviewPathScroll) return
    window.__dshPreviewPathScroll = true
    var paths = new Map(), scheduled = false
    var sizes = new ResizeObserver(schedule)

    function updateShadows(node) {
      var max = node.scrollWidth - node.clientWidth
      var left = node.scrollLeft > 1
      var right = max - node.scrollLeft > 1
      if (node.hasAttribute('data-dsh-path-left-shadow') !== left) node.toggleAttribute('data-dsh-path-left-shadow', left)
      if (node.hasAttribute('data-dsh-path-right-shadow') !== right) node.toggleAttribute('data-dsh-path-right-shadow', right)
    }
    function forget(node, state) {
      sizes.unobserve(node)
      if (state.text) sizes.unobserve(state.text)
      node.removeEventListener('scroll', state.scroll)
      node.removeEventListener('wheel', state.wheel)
      node.removeEventListener('keydown', state.keydown)
      node.removeAttribute('data-dsh-path-left-shadow')
      node.removeAttribute('data-dsh-path-right-shadow')
      if (state.addedTabIndex && node.getAttribute('tabindex') === '0') node.removeAttribute('tabindex')
      paths.delete(node)
    }
    function sync() {
      scheduled = false
      paths.forEach(function (state, node) { if (!node.isConnected || isVanilla()) forget(node, state) })
      if (isVanilla()) return
      document.querySelectorAll('[data-textpreview-path][data-path-label]').forEach(function (node) {
        if (node.closest('[data-dsh-ghost]')) return
        var state = paths.get(node)
        if (!state) {
          state = { atEnd: true, visible: false, path: null, text: null, max: 0, addedTabIndex: !node.hasAttribute('tabindex') }
          state.scroll = function () {
            var max = node.scrollWidth - node.clientWidth
            // A toolbar resize can fire scroll before ResizeObserver catches up.
            // Only a move within the same extent changes the user's end preference.
            if (max === state.max) state.atEnd = max - node.scrollLeft < 1
            updateShadows(node)
          }
          state.wheel = function (event) {
            if (isVanilla() || event.ctrlKey) return
            var delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
            if (event.deltaMode === 1) delta *= 16
            if (event.deltaMode === 2) delta *= node.clientWidth
            var before = node.scrollLeft
            node.scrollLeft += delta
            if (node.scrollLeft !== before) {
              state.atEnd = node.scrollWidth - node.clientWidth - node.scrollLeft < 1
              updateShadows(node)
              event.preventDefault()
            }
          }
          state.keydown = function (event) {
            if (isVanilla() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            if (event.key !== 'Home' && event.key !== 'End') return
            node.scrollLeft = event.key === 'End' ? node.scrollWidth : 0
            state.atEnd = event.key === 'End'
            updateShadows(node)
            event.preventDefault()
          }
          paths.set(node, state)
          if (state.addedTabIndex) node.setAttribute('tabindex', '0')
          node.addEventListener('scroll', state.scroll, { passive: true })
          node.addEventListener('wheel', state.wheel, { passive: false })
          node.addEventListener('keydown', state.keydown)
          sizes.observe(node)
        }
        if (state.text !== node.firstElementChild) {
          if (state.text) sizes.unobserve(state.text)
          state.text = node.firstElementChild
          if (state.text) sizes.observe(state.text)
        }
        var visible = node.clientWidth > 0 && node.getClientRects().length > 0
        var path = node.getAttribute('title')
        if (visible && (!state.visible || state.path !== path || state.atEnd)) node.scrollLeft = node.scrollWidth
        state.max = node.scrollWidth - node.clientWidth
        state.visible = visible
        state.path = path
        updateShadows(node)
      })
    }
    function schedule() {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(sync)
    }
    var observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'hidden', 'data-textpreview-url'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] })
    schedule()
  }

  // ── a surface that closes fades out instead of vanishing ──────────────────
  //
  // THE REPORTED BUG. With the animation preference on, a menu fades in — and
  // then snaps out of existence the instant it closes, and every dialog (设置,
  // the confirmations, the bar's own 关于) pops in and out with no transition at
  // all. The open half was covered by the stylesheet; the close half was not,
  // because CSS cannot animate an element the framework is REMOVING.
  //
  // WHY IT NEEDS THIS TIER. The app's `Menu` and `Modal` unmount through React:
  // one commit takes the node out of the document, and no stylesheet rule can
  // hold a subject that no longer exists. So the exit is replayed here: when the
  // removal is observed, a CLONE of the surface is put back exactly where the
  // original was, marked as a ghost, and faded out by the stylesheet. The clone
  // is a deep `cloneNode`, and that is what makes it safe: React's handles on a
  // node (`__reactFiber$…`) are JavaScript properties, not attributes, so a
  // clone carries none of them — the framework has already unmounted the
  // original and cannot reach the copy, and the copy cannot reach the framework.
  // It is pure painting for the ~120ms it takes to fade.
  //
  // WHAT IS REPLAYED, AND WHAT IS NOT. Only the two surface shapes the animation
  // setting covers:
  //
  //   - a `[role="menu"]`  — the popup list, portalled to `<body>` or inline;
  //   - a full-surface dialog layer — the settings overlay, the modal root, the
  //     lightbox backdrop: the same role/aria candidates the layer tagging uses.
  //
  // Both are decided from the removed node's own ATTRIBUTES, because computed
  // style is not readable on a detached node. The layer's shape test runs AFTER
  // the clone is back in the document; a candidate that turns out not to be a
  // fixed, viewport-covering layer — `role="presentation"` wrappers the app
  // unmounts mid-page — is dropped before the next paint, so it never shows.
  //
  // A ghost is inert by construction: `pointer-events: none` and `inert` keep
  // every pointer and focus path on the live page, `aria-hidden` keeps it out of
  // the tree readers see, and the overlay's own menu lookups skip it so a fading
  // copy can never be mistaken for an open menu.

  /** The attribute marking a fading clone left behind by a removal. */
  var GHOST_ATTRIBUTE = 'data-dsh-ghost'

  /** The ghost value for a popup menu list. */
  var GHOST_MENU = 'menu'

  /** The ghost value for a full-surface dialog layer. */
  var GHOST_LAYER = 'layer'

  /**
   * The ghost value for a collapse body.
   *
   * A third kind rather than part of {@link GHOST_LAYER}, because the exit is a
   * different movement: a layer fades and a collapse body SHRINKS as it fades, so
   * the stylesheet owes it its own keyframes. See the section 6c banner in
   * `theme.css`.
   */
  var GHOST_COLLAPSE = 'collapse'

  /** Client-owned disclosure bodies in the right-sidebar changes view. */
  var CHANGES_COLLAPSE_CLASSES = [
    'dshChanges__detail',
    'dshChanges__records',
    'dshChanges__recordDiff',
  ]

  /**
   * How long a ghost may outlive its animation, in ms.
   *
   * The exit is 160ms and `animationend` retires the ghost, so this backstop
   * exists for the two ways that event can fail to arrive: the animation
   * preference flipping to "off" (or the OS to reduced motion) after the ghost
   * was created, which suppresses the animation and with it the event, and an
   * engine that never fires it. The timeout leaves a short margin, so under
   * normal playback it fires on an already-removed node and does nothing.
   */
  var GHOST_MAX_LIFETIME_MS = 240

  /**
   * Whether exit animations should play at all.
   *
   * The same contract the stylesheet's gates implement, restated for the one
   * decision CSS cannot make (whether to replay a removal at all):
   *
   *   原版      never — the unmodified frontend does not animate
   *   off       never
   *   on        always, reduced motion or not
   *   system    follow the OS, as the stylesheet's media query does
   *
   * Read per event rather than cached: the preference attribute and the OS
   * setting can both change while the page is open, and the next removal must
   * observe the new answer.
   *
   * @returns {boolean} whether a removal should be replayed as a ghost.
   */
  function animationsActive() {
    if (isVanilla()) return false
    var preference = document.documentElement.getAttribute('data-dsh-desktop-animation')
    if (preference === 'off') return false
    if (preference === 'on') return true
    // `system` — the attribute is absent, which is how the client plugin writes
    // "follow the OS". A page whose engine has no matchMedia cannot report a
    // preference either, so the stylesheet's un-suppressed default stands.
    if (typeof window.matchMedia !== 'function') return true
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /** Animate navigation identities, never transcript or terminal output updates.
   * Slots and ARIA selections also cover keyboard/programmatic navigation. Keep
   * React's real nodes in place so drafts, scroll, focus and terminals survive.
   */
  function watchViewMotion() {
    if (typeof MutationObserver !== 'function' || !document.body.animate) return
    if (window.__dshDesktopViewMotion) return
    window.__dshDesktopViewMotion = true
    var identities = new WeakMap()
    var tabSelections = new WeakMap()
    var running = new Map()
    var scheduled = false

    function cancelAll() {
      running.forEach(function (animation) { animation.cancel() })
      running.clear()
    }

    function present(node, identity, axis, enter) {
      // Slot wrappers use display:contents and cannot themselves move.
      while (node && node.style.display === 'contents') node = node.firstElementChild
      if (!node || node.closest('[data-dsh-ghost]')) return
      var previous = identities.get(node)
      identities.set(node, identity)
      if (previous === identity || (previous === undefined && !enter)) return
      if (!animationsActive() || !node.getClientRects().length || node.closest('[hidden]')) return
      // Fixed menus use viewport coordinates. Never turn their ancestor into a
      // temporary containing block; opening one cancels any in-flight motion.
      if (node.querySelector('[role="menu"], [role="tooltip"]')) return
      var old = running.get(node)
      var start = old ? getComputedStyle(node) : null
      var from = { opacity: start ? start.opacity : .65, translate: start ? start.translate : axis === 'x' ? '6px 0' : '0 6px' }
      if (old) old.cancel()
      var animation = node.animate([from, { opacity: 1, translate: '0 0' }], {
        duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)',
      })
      running.set(node, animation)
      animation.onfinish = animation.oncancel = function () {
        if (running.get(node) === animation) running.delete(node)
      }
    }

    function scan() {
      scheduled = false
      if (!animationsActive()) cancelAll()
      running.forEach(function (animation, node) {
        if (!node.isConnected || node.querySelector('[role="menu"], [role="tooltip"]')) {
          animation.cancel()
          running.delete(node)
        }
      })
      document.querySelectorAll('[data-conversation-content]').forEach(function (node) {
        present(node, node.getAttribute('data-conversation-session') || 'new', 'y', true)
      })
      document.querySelectorAll('[data-slot="main"]').forEach(function (node) {
        // The conversation has its own session identity; do not double-animate it.
        if (!node.querySelector('[data-conversation-content]')) present(node, node.firstElementChild, 'y', true)
      })
      document.querySelectorAll('[role="dialog"] [class*="_navList"]').forEach(function (nav) {
        var dialog = nav.closest('[role="dialog"]')
        var active = nav.querySelector('[aria-current="true"]')
        present(dialog.querySelector('[class*="_options"]'), active, 'x', false)
      })
      document.querySelectorAll('[role="tablist"]').forEach(function (list) {
        // Sidebar tabs update in place; only the panel's disclosure owns motion.
        if (list.closest('[data-sidebar-right-panel], [data-dsh-terminal-dock]')) return
        var selected = list.querySelector('[role="tab"][aria-selected="true"]')
        if (!selected || selected === tabSelections.get(list)) return
        // DockKit keeps one content host per tab and toggles aria-hidden below.
        if (selected.hasAttribute('data-dockkit-tab')) return
        var id = selected.getAttribute('aria-controls')
        var panel = id && document.getElementById(id)
        if (!panel && list.hasAttribute('data-conversation-tabs')) {
          var conversation = list.closest('[data-phase], [data-slot="main.conversation"]')
          panel = conversation && conversation.querySelector('[class*="_viewArea"]')
        }
        if (!panel) return
        var changed = tabSelections.has(list)
        tabSelections.set(list, selected)
        // A fresh identity also replays a retained panel when returning to it.
        present(panel, { selected: selected }, 'x', changed)
      })
      document.querySelectorAll('[data-sidebar-right-panel]').forEach(function (node) {
        var open = node.hasAttribute('data-sidebar-right-open')
        var key = open ? node.getAttribute('data-sidebar-right-panel') + ':' + node.getAttribute('data-sidebar-right-session') : 'closed'
        // Existing slide handles open/close. Add a small transition for changing
        // the panel's fullscreen/push mode while it remains visible.
        var old = identities.get(node)
        if (!open || old === 'closed') identities.set(node, key)
        else present(node, key, 'x', false)
      })
    }

    // Stop moving content before an interaction measures a popup anchor.
    document.addEventListener('pointerdown', cancelAll, true)
    document.addEventListener('keydown', cancelAll, true)
    var navigationNodes = '[data-conversation-content], [data-slot="main"], [role="dialog"], [role="menu"], [role="tooltip"], [role="tablist"], [role="tabpanel"], [data-dockkit-content], [data-sidebar-right-panel]'
    var observer = new MutationObserver(function (records) {
      // Text streaming and xterm paints do not require a document-wide scan.
      var relevant = records.some(function (record) {
        if (record.target.closest('[data-dsh-ghost]')) return false
        if (record.type === 'attributes') return true
        return Array.prototype.some.call(record.addedNodes, function (node) {
          return node.nodeType === 1 && (node.matches(navigationNodes) || node.querySelector(navigationNodes))
        }) || Array.prototype.some.call(record.removedNodes, function (node) {
          return node.nodeType === 1 && node.matches(navigationNodes)
        }) || record.target.matches('[data-slot="main"], [data-slot="conversation.view"]')
      })
      if (!relevant) return
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(scan)
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-selected', 'aria-current', 'aria-labelledby', 'aria-hidden', 'hidden',
        'data-conversation-session', 'data-sidebar-right-open', 'data-sidebar-right-panel'] })
    var preferences = new MutationObserver(function () { if (!animationsActive()) cancelAll() })
    preferences.observe(document.documentElement, { attributes: true,
      attributeFilter: ['data-dsh-ui', 'data-dsh-desktop-animation'] })
    if (typeof window.matchMedia === 'function') {
      var reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      if (reduced.addEventListener) reduced.addEventListener('change', function () { if (!animationsActive()) cancelAll() })
    }
    scan()
  }

  /**
   * What a removed node is, for exit-animation purposes.
   *
   * Attribute-only by necessity: the node is already detached when the observer
   * runs, and detached nodes have no usable computed style. The layer candidates
   * mirror {@link LAYER_CANDIDATES}; the shape check that keeps them honest runs
   * later, on the re-inserted clone.
   *
   * The overlay's own injected submenu is skipped: when its parent menu is
   * ghosted, the clone already carries a copy, and ghosting the submenu too
   * would stack a second identical fade on the same pixels.
   *
   * @param {Element} node - the removed element.
   * @returns {string|null} {@link GHOST_MENU}, {@link GHOST_LAYER}, or null.
   */
  function ghostKindFor(node) {
    if (node.getAttribute(GHOST_ATTRIBUTE)) return null
    if (['reveal-submenu', 'copy-submenu'].includes(node.getAttribute('data-dsh-desktop'))) return null
    // Composer command lists and anchored statistics dialogs are not full-screen
    // dialog layers. Preserve their own coordinates for the menu-style exit.
    if (node.hasAttribute('data-trigger-menu') ||
        node.getAttribute('role') === 'dialog' && node.getAttribute('aria-modal') !== 'true' &&
        (node.getAttribute('class') || '').includes('_panel') &&
        node.querySelector('dl, [class*="_percent"]')) return GHOST_MENU
    // Collapse bodies, checked BEFORE the role tests because they
    // carries no role of its own — it is a plain `<div>` the app mounts and
    // unmounts with the card's open state, which is exactly why it needs
    // replaying. Keyed on the tag the overlay itself wrote, so this can only ever
    // fire for a body this overlay has already identified as a card's.
    if (node.getAttribute(COLLAPSE_ATTRIBUTE) === COLLAPSE_BODY) return GHOST_COLLAPSE
    // The changes sidebar owns disclosure bodies of its own. Their wrapper
    // remains mounted, so recognizing the removed child here is enough to
    // replay the close without mounting every detail in advance.
    var classes = (node.getAttribute('class') || '').split(/\s+/)
    if (CHANGES_COLLAPSE_CLASSES.some(function (name) { return classes.includes(name) })) return GHOST_COLLAPSE
    var role = node.getAttribute('role')
    if (role === 'alertdialog') return 'surface'
    if (role === 'menu') return GHOST_MENU
    if (
      role === 'presentation' ||
      role === 'dialog' ||
      role === 'status' ||
      node.getAttribute('aria-modal') === 'true'
    ) {
      return GHOST_LAYER
    }
    return null
  }

  /**
   * Put a fading clone of a removed surface back where it was, then retire it.
   *
   * The position is the removal record's parent and following sibling, which is
   * where the surface lived; a clone of a portal child therefore lands back on
   * `<body>` with the same inline coordinates, and an inline list lands back in
   * the wrapper that positioned it. A parent that is itself gone — the whole
   * page unmounted under an open menu — has no position to preserve, so the
   * removal is left alone rather than re-hosted somewhere arbitrary.
   *
   * @param {Element} node - the removed surface.
   * @param {Node} parent - the parent it was removed from.
   * @param {Node|null} nextSibling - the sibling that followed it, if any.
   * @param {string} kind - {@link GHOST_MENU} or {@link GHOST_LAYER}.
   */
  function replayRemoval(node, parent, nextSibling, kind) {
    if (!parent || typeof parent.appendChild !== 'function') return
    if (typeof node.cloneNode !== 'function') return
    // A parent no longer in the document cannot give the clone its old position
    // back, and re-hosting the fade elsewhere would paint it in the wrong place.
    // `isConnected` is the DOM's own answer, the same one the submenu cleanup uses.
    if (typeof parent.isConnected === 'boolean' && !parent.isConnected) return
    // Dock tabs and document previews already manage their presentation. Do not
    // deep-clone their removed trees just to test whether they were a dialog.
    if (isRemotePage() && typeof parent.closest === 'function' &&
        parent.closest('[data-sidebar-right-panel], [data-sidebar-right-float-host]')) return

    var clone = node.cloneNode(true)
    if (!clone || clone.nodeType !== 1) return
    clone.setAttribute(GHOST_ATTRIBUTE, kind)
    // The ghost is scenery: nothing about it may take input or a reader's
    // attention while it plays. Both are guarded — `inert` is the engine's
    // stronger switch where it exists, and either one alone is sufficient.
    clone.setAttribute('aria-hidden', 'true')
    try {
      clone.inert = true
    } catch (error) {
      /* An engine without `inert` still has `pointer-events: none`. */
    }

    if (typeof parent.insertBefore === 'function' && nextSibling && nextSibling.parentElement === parent) {
      parent.insertBefore(clone, nextSibling)
    } else {
      parent.appendChild(clone)
    }

    // The layer test could not run while the node was detached, so it runs now,
    // on a connected clone with a real computed style. A candidate that is not
    // actually a full-surface layer is dropped before it can paint one frame.
    if (kind === GHOST_LAYER && !isOffsetFullSurfaceLayer(clone)) {
      if (clone.parentElement) clone.parentElement.removeChild(clone)
      return
    }

    var retired = false
    var retire = function () {
      if (retired) return
      retired = true
      if (clone.parentElement) clone.parentElement.removeChild(clone)
    }
    // Child animations bubble: a card finishing must not prematurely remove
    // the entire closing group (which can contain hundreds of cards).
    clone.addEventListener('animationend', function (event) {
      if (event.target === clone) retire()
    })
    setTimeout(retire, GHOST_MAX_LIFETIME_MS)
  }

  /**
   * Replay surface removals as exit animations.
   *
   * INSTALLED AT MOST ONCE. Unlike the coalescing observers above, this one's
   * work is not idempotent: a second live observer would replay each removal
   * twice, stacking two identical clones on the same pixels. The flag is on
   * `window` because the overlay script can be evaluated more than once in a
   * page, and the flag survives those separate evaluations.
   *
   * The gate is checked per batch rather than per record; the common case while
   * the agent streams is a removal of something that is neither a menu nor a
   * layer, and the whole cost of that is one attribute read per removed node.
   */
  function watchRemovalGhosts() {
    if (typeof MutationObserver !== 'function') return
    if (window.__dshDesktopGhostWatcher === true) return
    window.__dshDesktopGhostWatcher = true
    var observer = new MutationObserver(function (records) {
      // A quick reopen replaces the closing scenery in the same microtask.
      // Resume from its visible height rather than rendering both full lists.
      document.querySelectorAll('[data-plugin-scope] > [class*="_groupBody"]:not([data-dsh-ghost]), [data-testid="todo-panel"] > div > ul:not([data-dsh-ghost])').forEach(function (body) {
        var parent = body.parentElement
        var ghosts = parent.querySelectorAll(':scope > [data-dsh-ghost="collapse"]')
        for (var g = 0; g < ghosts.length; g++) {
          if (animationsActive()) {
            body.style.setProperty('--dsh-group-start-height', ghosts[g].getBoundingClientRect().height + 'px')
            body.style.setProperty('--dsh-group-start-gap', getComputedStyle(ghosts[g]).marginBlockStart)
          }
          ghosts[g].remove()
        }
      })
      if (!animationsActive()) return
      for (var i = 0; i < records.length; i++) {
        var removed = records[i].removedNodes
        if (!removed || removed.length === 0) continue
        for (var j = 0; j < removed.length; j++) {
          var node = removed[j]
          if (!node || node.nodeType !== 1) continue
          var kind = ghostKindFor(node)
          if (kind === null) continue
          replayRemoval(node, records[i].target, records[i].nextSibling, kind)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  /**
   * The one open menu, excluding fading ghosts.
   *
   * Every lookup the overlay makes for "the menu that is open" goes through
   * here, because a ghost IS a `[role="menu"]` for the moments it fades: a
   * lookup that found one would place it like a live menu (the right-click
   * placement polls for several frames after the menu has closed), dispatch
   * Escape for it (closing a dialog that happened to be open), or inject the
   * reveal row into it (a flicker of a stale row inside a fading list).
   *
   * @returns {Element|null} the open menu, or null when none is open.
   */
  function openMenuElement() {
    var menus = document.querySelectorAll('[role="menu"]')
    for (var i = 0; i < menus.length; i++) {
      if (!menus[i].getAttribute(GHOST_ATTRIBUTE)) return menus[i]
    }
    return null
  }


  // ── "在资源管理器打开" in the sidebar row menus ────────────────────────────
  //
  // The app builds the workspace and session row menus from its own item arrays,
  // and a client plugin cannot contribute to them: `Menu` receives `items` as a
  // prop from the row component, and no slot exists for a third party to add one.
  // So the item is added to the RENDERED menu instead, as an extra row in the
  // list the app already produced.
  //
  // WHY THIS IS SAFE TO DO, MEASURED RATHER THAN HOPED. The menu's children are
  // React's, so an appended node could be removed by any reconciliation. It was
  // tested against the three re-render paths the component actually has — hovering
  // every item (which sets state on the item wrappers), a `resize`, and a `scroll`
  // (both of which the component listens to and re-positions on) — and the node
  // survived all three, because React only touches the children it manages.
  //
  // WHAT IT DRIVES. The app's own launcher route, not a command of ours — see
  // `openInExplorer` in `title-bar/client.js` for why `dsh-host-open-in-app` is
  // the right seam. The same route the title bar's menus use, so one
  // implementation serves all four menus.

  /**
   * Where a row's directory comes from.
   *
   * A workspace row carries its own: the group object on its React fiber has a
   * `cwd`, which is also what the row's hover card displays and what its
   * copy-text action copies. A SESSION row carries none — its `node` prop holds
   * only id, title, and status flags — because in this app a session's directory
   * IS its workspace's: `dsh-client-ui-workspace` builds each group with
   * `workspace.path`, and its own code compares `summary.cwd === workspace.path`.
   *
   * So a session's directory is found by walking up to the workspace that owns it.
   * The sidebar renders one `groupSection` per workspace containing exactly one
   * project row, verified live — so the first ancestor holding a project row is
   * that workspace and no other. The walk STOPS there even when that row has no
   * path, because the sections share one list container: continuing would reach
   * the container and return a neighbouring workspace's directory. Measured across
   * all 59 rows of a real sidebar: 56 resolved, and the 3 that did not were exactly
   * the 未分组 bucket, which has no directory by definition.
   *
   * THE FIBER IS READ, NOT GUESSED AT. `cwd` is not in the DOM; it is a React prop
   * on the row's ancestors. `__reactFiber$…` is React's own public-ish handle on a
   * DOM node (`__reactInternalInstance$…` on older builds), and walking `.return`
   * is how the value is reached. This is the one part of the overlay that depends
   * on React internals rather than on roles or attributes, so every step degrades
   * to "no path" rather than throwing: a renamed key or a future React makes the
   * item DISABLED, never broken.
   */

  /** How far up the fiber chain to look for a `cwd`, to bound the work. */
  var FIBER_DEPTH = 45

  /** How far up the DOM to look for the owning workspace row. */
  var ANCESTOR_DEPTH = 12

  /**
   * How long a submenu stays open after the pointer leaves it, in ms.
   *
   * This is what makes the pointer able to REACH the list. The list is portalled to
   * `<body>`, so it is not a DOM descendant of the item that opened it: a
   * `mouseleave` fires the instant the pointer steps off the item, even when the
   * destination is the list itself. Waiting briefly and cancelling on the list's
   * own `mouseenter` bridges the gap — the job the app's own `::before` bridge does
   * for a nested list, which cannot span a portal.
   *
   * 220ms matches the app's own `Menu` primitive, which arms its close the same way
   * and waits 200ms.
   */
  var SUBMENU_CLOSE_DELAY_MS = 220

  /**
   * Hide a submenu when the menu that owns it is removed.
   *
   * The menu is a React portal: React unmounts it without any notice reaching this
   * row, and the submenu — being portalled to `<body>` — would otherwise be left
   * behind as an orphan floating over the page. A `MutationObserver` on `body` is
   * the only signal available.
   *
   * @param {Element} menu - the menu the submenu belongs to.
   * @param {Element} submenu - the portalled list.
   * @param {Function} onGone - called once the menu has gone.
   */
  function watchMenuRemoval(menu, submenu, onGone) {
    if (typeof MutationObserver !== 'function') return
    var observer = new MutationObserver(function () {
      // `isConnected` is the DOM's own answer to "is this still in the document",
      // and it is cheaper and more reliable than re-querying for the node.
      if (menu.isConnected) return
      observer.disconnect()
      onGone()
      if (submenu.parentElement) submenu.parentElement.removeChild(submenu)
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  /**
   * The React fiber handle on a DOM node, found by key scan.
   *
   * `__reactFiber$…` is React's own public-ish handle on a DOM node
   * (`__reactInternalInstance$…` on older builds). The suffix is per-build, so
   * the key is found by its prefix, and the scan is the one part of the overlay
   * that depends on React internals rather than on roles or attributes — every
   * consumer must degrade to "not found" when this answers null, never throw.
   *
   * @param {Element} node - a node React has rendered.
   * @returns {string|null} the handle's key, or null when the node has none.
   */
  function fiberHandleOf(node) {
    var keys = Object.keys(node)
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].indexOf('__reactFiber$') === 0 || keys[k].indexOf('__reactInternalInstance$') === 0) {
        return keys[k]
      }
    }
    return null
  }

  /**
   * The `cwd` reachable from a DOM node's React fiber chain.
   *
   * @param {Element} node - a node inside a row.
   * @returns {string|undefined} the absolute directory, or undefined.
   */
  function cwdFromFiber(node) {
    var key = fiberHandleOf(node)
    if (key === null) return undefined

    var fiber = node[key]
    for (var depth = 0; fiber && depth < FIBER_DEPTH; depth++) {
      var props = fiber.memoizedProps
      if (props && typeof props === 'object') {
        // A prop that is itself the value, or holds one. The group object is the
        // second shape: `props.group.cwd`.
        if (isDirectory(props.cwd)) return props.cwd
        var names = Object.keys(props)
        for (var n = 0; n < names.length; n++) {
          var value = props[names[n]]
          if (value && typeof value === 'object' && isDirectory(value.cwd)) return value.cwd
        }
      }
      fiber = fiber.return
    }
    return undefined
  }

  /**
   * Whether a value looks like a directory the shell could open.
   *
   * An absolute Windows (`C:\…`, `\\server\share`) or POSIX (`/…`) path. The test
   * is deliberately about SHAPE only — whether the directory exists is the
   * launcher route's own check, and duplicating it here would be a second source
   * of truth.
   *
   * @param {*} value - the candidate.
   * @returns {boolean} whether it is an absolute path string.
   */
  function isDirectory(value) {
    if (typeof value !== 'string' || value.length === 0) return false
    if (/^[A-Za-z]:[\\/]/.test(value)) return true
    if (value.indexOf('\\\\') === 0) return true
    return value.charAt(0) === '/'
  }

  /**
   * The session id reachable from a SESSION row's React fiber chain.
   *
   * A session row carries no `cwd` (its directory is its workspace's — see
   * {@link openRowDirectory}), but its `node` prop holds the row's data: id,
   * title, and status flags. The id is what the deep-link row copies. The walk
   * is the same grounding {@link cwdFromFiber} uses — innermost fiber first, so
   * the row's own `node` wins over any ancestor's — and every failure degrades
   * to undefined, which leaves the deep-link row DISABLED rather than absent:
   * an item that vanishes reads as a broken menu, an item that sits disabled
   * reads as "this row has no link".
   *
   * @param {Element} row - a session row (`[role="treeitem"]`).
   * @returns {string|undefined} the session id, or undefined.
   */
  function sessionIdFromRow(row) {
    var key = fiberHandleOf(row)
    if (key === null) return undefined

    var fiber = row[key]
    for (var depth = 0; fiber && depth < FIBER_DEPTH; depth++) {
      var props = fiber.memoizedProps
      if (props && typeof props === 'object' && props.node && typeof props.node === 'object') {
        var id = props.node.id
        if (typeof id === 'string' && id !== '') return id
      }
      fiber = fiber.return
    }
    return undefined
  }

  /**
   * Whether a workspace header row is the ungrouped bucket's, decided on its fiber.
   *
   * The sidebar's last section is not a workspace: it is the bucket the app
   * builds for sessions that belong to none (`groupByWorkspace` constructs it
   * with an empty key and no workspace), yet the app renders its header exactly
   * like a real workspace — same folder icon, same title style. The stylesheet
   * gives it a face of its own (see theme.css's ungrouped section), and this is
   * the question that decides where that face applies.
   *
   * WHY THE FIBER, NOT THE LABEL OR THE CLASSES. CSS cannot select on text, the
   * visible label is locale-dependent (`未分组` in zh, `Ungrouped` in en), and
   * the row's class hashes are regenerated per build. The row's React fiber
   * carries the group object the row was rendered from (`props.group` on the
   * row component, reachable by walking `.return` — the same grounding {@link
   * cwdFromFiber} uses), and the bucket is the one group whose `workspaceId` is
   * `undefined`: real workspaces are built with the host's id, the bucket with
   * none. That is locale-independent and survives a relabel. The `sessions`
   * array is the shape guard, so a props object that merely happens to carry a
   * `group` key is not mistaken for a group.
   *
   * Every failure degrades to "not the bucket": a renamed React key, a future
   * React, or a node outside React all answer false, which leaves the app's own
   * folder row — never a wrong tag.
   *
   * @param {Element} row - a workspace header row (`[role="treeitem"]`).
   * @returns {boolean} whether this row is the ungrouped bucket's header.
   */
  function rowIsUngrouped(row) {
    var key = fiberHandleOf(row)
    if (key === null) return false

    var fiber = row[key]
    for (var depth = 0; fiber && depth < FIBER_DEPTH; depth++) {
      var props = fiber.memoizedProps
      if (props && typeof props === 'object') {
        var group = props.group
        if (
          group &&
          typeof group === 'object' &&
          group.workspaceId === undefined &&
          Array.isArray(group.sessions)
        ) {
          return true
        }
      }
      fiber = fiber.return
    }
    return false
  }

  /**
   * Tag the ungrouped bucket's header row so the stylesheet can restyle it.
   *
   * The tag rides the appearance family (`data-dsh-desktop`), so 原版 strips it
   * with everything else and the bucket reverts to the app's own folder row —
   * see {@link clearDecorations}.
   *
   * Like {@link markRelocatedRows}, the tag is RETIRED as well as written: the
   * scan covers every workspace header row, so a row that stops being the
   * bucket — a workspace created where the list used to end — loses the tag on
   * the pass that notices. React re-renders keep the tag for free (an attribute
   * the framework does not own is not touched by reconciliation); a REMOUNTED
   * row is re-tagged by the mutation-driven pass, which is why this runs there
   * and not only on the periodic pass. The scan is a handful of rows with a
   * bounded fiber walk each.
   *
   * @returns {boolean} whether any tag was added or removed.
   */
  function markUngroupedBucket() {
    var rows = document.querySelectorAll('[role="treeitem"][class*="projectRow"]')
    var changed = false
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var wanted = rowIsUngrouped(row) ? 'ungrouped' : null
      var current = row.getAttribute('data-dsh-desktop')
      if (current === wanted) continue
      changed = true
      if (wanted === null) row.removeAttribute('data-dsh-desktop')
      else row.setAttribute('data-dsh-desktop', wanted)
    }
    return changed
  }

  /**
   * The chrome-family attribute carrying the collapse tag.
   *
   * {@link CHROME_ATTRIBUTE} rather than a member of the appearance family, for
   * the reason that split exists: a card's collapse body is a SURFACE WITH ITS OWN
   * SHAPE, and the tag is what lets the ghost watcher recognise a removal. 原版
   * shows the unmodified frontend, so the stylesheet stops animating — but the tag
   * itself is inert there (nothing matches it), and stripping it in
   * {@link clearDecorations} would mean a card opened in 原版 and then switched
   * back had no tag until the next pass. Keeping it in the chrome family makes the
   * tag a statement about the DOM's shape, which is what it is.
   */
  var COLLAPSE_ATTRIBUTE = CHROME_ATTRIBUTE

  /** The value marking a plugin card's expandable body. */
  var COLLAPSE_BODY = 'collapse-body'

  /**
   * Tag the plugin cards' expandable bodies.
   *
   * WHY THIS NEEDS A TAG AT ALL. The app mounts a card's body only while the card
   * is open (`open ? <div class=…_body> : null`), so the OPEN animation needs no
   * help — the stylesheet keys it on the card's own `_cardOpen` class, which React
   * writes in the same commit. What needs help is the CLOSE: an unmounted node
   * cannot be animated, so the ghost watcher has to recognise the removal and
   * replay it. A removed node has no computed style and no class worth trusting,
   * so the recognition is an attribute the overlay wrote while the node was still
   * in the document — this one.
   *
   * The tag is also RETIRED, on the same principle as the layer tag: a body that
   * is no longer inside an open card loses it, so the tag keeps describing the
   * surface's present shape rather than its history.
   *
   * @returns {boolean} whether any tag was added or removed.
   */
  function markCollapseBodies() {
    var changed = false
    // The candidate query is a SINGLE class fragment and the ancestry is asked
    // separately, rather than writing `[class*="_cardOpen"] [class*="_body"]`.
    // Two reasons, and the second is the load-bearing one:
    //
    //   - `_body` is a local name ten of the app's packages use, so the fragment
    //     alone is not a claim about anything;
    //   - the ancestry test is the SAME question the retirement loop already asks
    //     ({@link isInsideOpenCard}), so writing it once means a node cannot be
    //     tagged by one rule and retired by another that disagrees with it.
    var candidates = document.querySelectorAll('[class*="_body"], [data-plugin-module] > [class*="_cardDetails"], [data-plugin-scope] > [class*="_groupBody"], [data-testid="todo-panel"] > div > ul')
    for (var i = 0; i < candidates.length; i++) {
      var body = candidates[i]
      // A ghost is a fading clone of a body that just unmounted. It already
      // carries the GHOST attribute, and re-tagging it here would make the close
      // animation's own keyframes unreachable, because the ghost rules key on the
      // ghost value.
      if (body.getAttribute(GHOST_ATTRIBUTE)) continue
      if (!isInsideOpenCard(body)) continue
      if (body.getAttribute(COLLAPSE_ATTRIBUTE) === COLLAPSE_BODY) continue
      body.setAttribute(COLLAPSE_ATTRIBUTE, COLLAPSE_BODY)
      changed = true
    }

    var tagged = document.querySelectorAll('[' + COLLAPSE_ATTRIBUTE + "='" + COLLAPSE_BODY + "']")
    for (var j = 0; j < tagged.length; j++) {
      var node = tagged[j]
      if (node.getAttribute(GHOST_ATTRIBUTE)) continue
      // Still an open card's body? The same question, asked of the live tree, so a
      // tag cannot outlive the shape it describes.
      if (isInsideOpenCard(node)) continue
      node.removeAttribute(COLLAPSE_ATTRIBUTE)
      changed = true
    }
    return changed
  }

  /**
   * Whether a node is a body inside an open plugin card.
   *
   * @param {Element} node - the candidate.
   * @returns {boolean} whether it still is one.
   */
  function isInsideOpenCard(node) {
    var scope = node.parentElement
    // TodoPanel mounts its list only while expanded. Scope this to the stable
    // upstream marker, not the localized title or a CSS-module hash.
    if (node.tagName === 'UL' && scope && scope.parentElement &&
        scope.parentElement.getAttribute('data-testid') === 'todo-panel') return true
    var nodeClass = typeof node.className === 'string' ? node.className : ''
    if (scope && nodeClass.indexOf('_cardDetails') !== -1 && scope.hasAttribute('data-plugin-module')) {
      return scope.getAttribute('data-open') === 'true'
    }
    if (scope && nodeClass.indexOf('_groupBody') !== -1 && scope.hasAttribute('data-plugin-scope')) {
      return true // The inventory mounts each group's body only while expanded.
    }
    for (var hops = 0; scope && hops < COLLAPSE_DEPTH; hops++) {
      var cls = typeof scope.className === 'string' ? scope.className : ''
      if (cls.indexOf('_cardOpen') !== -1) return true
      // The claim is scoped to the plugin cards, so walking out of them answers
      // "no" rather than searching the whole page for an unrelated `_cardOpen`.
      if (cls.indexOf('_card') !== -1) return false
      scope = scope.parentElement
    }
    return false
  }

  /**
   * How far up to look for the card that owns a body.
   *
   * The app's own tree is `li._card > div._body`, so one hop finds it. The bound
   * exists for the shape a future build might nest differently, and it is small
   * because a larger number would only mean walking further through unrelated
   * ancestors.
   */
  var COLLAPSE_DEPTH = 4

  /**
   * The directory belonging to the row whose menu is open.
   *
   * @returns {string|undefined} the absolute directory, or undefined.
   */
  function openRowDirectory() {
    // The row whose menu is open marks itself, so this needs no memory of which
    // button was clicked: the app sets a `menuOpen` class on the row for exactly
    // as long as its menu is mounted.
    var openRow = document.querySelector('[class*="menuOpen"][role="treeitem"]')
    if (!openRow) return undefined

    var own = cwdFromFiber(openRow)
    if (own !== undefined) return own

    // A session row: its directory is the owning workspace's.
    //
    // THE WALK STOPS AT THE FIRST WORKSPACE ROW IT FINDS, whether or not that row
    // has a path, and that is load-bearing. The sidebar renders one `groupSection`
    // per workspace inside ONE shared list, so "keep walking until a row with a
    // path turns up" would escape the section and pick a NEIGHBOUR's directory:
    // the ungrouped bucket is the last section, its own project row has no path,
    // and the next ancestor up is the container holding all sixteen sections —
    // so an ungrouped session would have opened whatever workspace happens to sort
    // first. Verified live: it resolved to StarFallHub's directory before this
    // stop was added.
    //
    // So the first workspace row is the answer, and its absence of a path is the
    // answer too: no directory, and the item is not injected.
    var node = openRow.parentElement
    for (var hops = 0; node && node !== document.body && hops < ANCESTOR_DEPTH; hops++) {
      var project = node.querySelector && node.querySelector('[class*="projectRow"]')
      if (project) return cwdFromFiber(project)
      node = node.parentElement
    }
    return undefined
  }

  /**
   * Open a directory with one of the host's resolved applications.
   *
   * @param {string} appId - a catalog id the host resolved (`explorer`, `cursor`, …).
   * @param {string} path - the absolute directory.
   */
  function openWithApp(appId, path) {
    var attempt = { source: 'overlay', kind: 'launch', app: appId, path: path }
    try {
      fetch('/open-in-app/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: appId, path: path }),
      }).then(
        function (response) {
          if (response.ok) {
            reportDiag(Object.assign({}, attempt, { ok: true, status: response.status }))
            focusLaunchedFolder(path)
            return
          }
          // The route answers structured JSON for everything it refuses (an
          // unavailable launcher, a relative path, a directory that does not
          // exist), so the body's message is the reason. A response whose body
          // cannot be parsed degrades to the status code.
          //
          // The refusal is REPORTED, not swallowed. Until this was added, a
          // launch that answered 404 — a workspace whose directory was moved or
          // deleted, the most common real failure — did nothing at all anywhere:
          // the menu closed and the page went on as if the click had been lost.
          // What the user reports then is "菜单里无法使用", with nothing to
          // diagnose it by.
          response.json().then(
            function (payload) {
              reportLaunchFailure(path, payload && payload.message)
              reportDiag(
                Object.assign({}, attempt, {
                  ok: false,
                  status: response.status,
                  message: payload && payload.message,
                }),
              )
            },
            function () {
              reportLaunchFailure(path, 'HTTP ' + response.status)
              reportDiag(Object.assign({}, attempt, { ok: false, status: response.status }))
            },
          )
        },
        function (error) {
          reportLaunchFailure(path, error)
          reportDiag(Object.assign({}, attempt, { ok: false, error: String(error) }))
        },
      )
    } catch (error) {
      reportLaunchFailure(path, error)
      reportDiag(Object.assign({}, attempt, { ok: false, error: String(error) }))
    }
  }

  /**
   * The overlay build marker, carried on every diagnostics line.
   *
   * Its job is to answer, from the log alone, WHICH code the page was running
   * when the user clicked — a stale page reporting failures that were fixed
   * hours ago is the first thing to rule out, and a version string in every
   * line is how it is ruled out.
   */
  var DIAG_VERSION = 'overlay-diag1'

  /**
   * Make sure the launched folder's window is actually on screen.
   *
   * The shell's answer to "open an already-open folder" is to focus the
   * EXISTING frame — and frames were measured stuck hidden (`WS_VISIBLE` unset,
   * not minimized, not on another desktop), so a launch that returned
   * `{ok: true}` changed nothing on screen and read as a dead click. The host's
   * `focus_folder_window` finds the frame by the folder's name and shows it;
   * for a fresh window it answers false, and the shell's own new window needs
   * no help. Best-effort by construction: without the host (a plain browser)
   * this is a no-op, and a refusal is only a lost log line.
   *
   * @param {string} path - the directory the launch opened.
   */
  function focusLaunchedFolder(path) {
    try {
      var api = window.__TAURI__
      if (!api || !api.core || typeof api.core.invoke !== 'function') return
      api.core
        .invoke('focus_folder_window', { path: path })
        .then(function (shown) {
          reportDiag({ source: 'overlay', kind: 'focus', path: path, shown: shown === true })
        })
        .catch(function (error) {
          reportQuietly(t('聚焦文件夹窗口失败'), error)
        })
    } catch (error) {
      reportQuietly(t('聚焦文件夹窗口失败'), error)
    }
  }

  /**
   * Append one diagnostics line to the host's log, via `/__dsh-desktop/diag`.
   *
   * Fire-and-forget by construction: a missing route, a refused request, or a
   * failing body are all swallowed, because diagnostics must never become the
   * failure they exist to record. The line is one JSON object per launch
   * attempt — which source acted, on what, and what came back — so a manual
   * click that "does nothing" can be diagnosed from `~/.dsh/desktop-diag.log`
   * without reproducing it.
   *
   * @param {object} payload - the facts about one attempt.
   */
  function reportDiag(payload) {
    try {
      var body = JSON.stringify(
        Object.assign({ v: DIAG_VERSION, at: new Date().toISOString() }, payload),
      )
      fetch('/__dsh-desktop/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
      }).catch(function () {
        /* No route, no fence pass, no log: diagnostics stay silent. */
      })
    } catch (error) {
      reportQuietly(t('诊断上报失败'), error)
    }
  }

  /** Log a handled failure without ever letting the logger itself throw. */
  function reportQuietly(what, error) {
    try {
      if (window.console && window.console.warn) {
        window.console.warn('desktop overlay: ' + what + ': ' + String(error))
      }
    } catch (ignored) {
      /* A console that throws must not turn a handled failure into a crash. */
    }
  }

  // ── a launch failure is VISIBLE, not a silent no-op ─────────────────────────
  //
  // Every directory action ends at the app's launcher route, and every way that
  // route can refuse used to end in a console the user never opens: a non-OK
  // response was not even logged (the `.catch` below fired only for network
  // errors), so a 404 for a directory that no longer exists — the common real
  // failure — was indistinguishable from a dead button. The report is a small
  // self-dismissing toast on the body plane, styled from the app's own tokens.
  //
  // The same channel serves the TITLE BAR: its client dispatches
  // `dsh-desktop:report` for the failures it hits, and this listener renders
  // them. One renderer, so both halves of the feature fail the same way.

  /** How long a report toast stays on screen, in ms. */
  var TOAST_LIFETIME_MS = 5000

  /** How many toasts may stack before the oldest is retired, in nodes. */
  var TOAST_MAX_STACK = 3

  /** The DOM event the title bar dispatches to reach this renderer. */
  var REPORT_EVENT = 'dsh-desktop:report'

  /**
   * Show one failure toast and log the same fact for the console.
   *
   * Every step is guarded: a toast is diagnostics, and a diagnostic that throws
   * would replace the failure it reported with a new one.
   *
   * @param {string} message - the user-facing reason, already composed.
   * @param {*} error - the original reason, for the console.
   */
  function showDesktopToast(message, error, key) {
    reportQuietly(message, error)
    try {
      var host = document.body
      if (!host || typeof document.createElement !== 'function') return
      var toast = document.createElement('div')
      toast.setAttribute('data-dsh-desktop', 'toast')
      if (typeof key === 'string' && key) {
        // Repeated exports update one notice instead of overlapping paths.
        for (var previous of host.querySelectorAll('[data-dsh-toast-key]')) {
          if (previous.getAttribute('data-dsh-toast-key') === key) previous.remove()
        }
        toast.setAttribute('data-dsh-toast-key', key)
      }
      // Inline styles rather than a theme.css rule, for the same reason the
      // unclassed submenu fallback draws itself: this tier must stay self-
      // sufficient on a page whose stylesheet did not load. The surface and
      // border are the app's own tokens, so both palettes read correctly.
      toast.style.cssText =
        'position:fixed;right:16px;bottom:calc(16px + var(--dsh-terminal-dock-height, 0px));z-index:1400;max-width:360px;' +
        'padding:10px 14px;border-radius:8px;color:inherit;font-size:12px;line-height:1.5;overflow-wrap:anywhere;' +
        'background:var(--dsw-specific-menu, #353638);' +
        'border:1px solid var(--dsw-alias-border-l1, rgb(255 255 255 / 12%));' +
        'box-shadow:0 3px 8px 0 rgb(0 0 0 / 4%),0 0 20px 0 rgb(0 0 0 / 5%)'
      toast.textContent = message
      host.appendChild(toast)

      // Bound the stack, oldest first, so a burst of failures (a row whose
      // directory is gone, clicked repeatedly) cannot pile up unbounded.
      var toasts = document.querySelectorAll('[data-dsh-desktop="toast"]')
      while (toasts.length > TOAST_MAX_STACK) {
        var oldest = toasts[0]
        if (oldest.parentElement) oldest.parentElement.removeChild(oldest)
        toasts = document.querySelectorAll('[data-dsh-desktop="toast"]')
      }

      setTimeout(function () {
        try {
          if (toast.parentElement) toast.parentElement.removeChild(toast)
        } catch (ignored) {
          /* A toast already gone is not an error worth reporting. */
        }
      }, TOAST_LIFETIME_MS)
    } catch (reported) {
      reportQuietly(t('显示失败提示'), reported)
    }
  }

  /**
   * Compose one launch failure: what was attempted, and why it refused.
   *
   * @param {string} path - the directory the action tried to open.
   * @param {string|Error} reason - the route's message, a status, or an error.
   */
  function reportLaunchFailure(path, reason) {
    var detail = reason instanceof Error ? reason.message : String(reason || '')
    showDesktopToast(t('打开 ') + path + t(' 失败') + (detail ? '：' + detail : ''), reason)
  }

  /**
   * Render the title bar's failure reports as toasts.
   *
   * INSTALLED AT MOST ONCE, like the context-menu binding: the overlay script can
   * be evaluated more than once in a page, and each evaluation would otherwise
   * add another listener, so one click would toast once per copy. The flag is on
   * `window`, which survives those separate evaluations.
   *
   * The listener is NOT withdrawn in 原版. The mode governs the project's
   * appearance modifications; a launch failure is a fact about the system, and
   * the bar exists in 原版 too, so its reports still deserve a surface.
   */
  function installReportListener() {
    if (window.__dshDesktopReportListener === true) return
    window.__dshDesktopReportListener = true
    document.addEventListener(REPORT_EVENT, function (event) {
      var detail = event && event.detail
      var message = detail && detail.message
      if (typeof message !== 'string' || message === '') return
      showDesktopToast(message, detail.error, detail.key)
    })
  }

  /**
   * The labels this overlay can render for the host's application catalog.
   *
   * MIRRORS THE APP'S `APP_LABEL_KEY` DICTIONARY rather than asking for it, and the
   * duplication is forced: that map is a module-private constant inside the app's
   * own client bundle (`dsh-client-ui-open-in-app`), with no service or slot that
   * publishes it, and this file is a classic script that cannot require it.
   *
   * What the map buys is the app's own behaviour: an id the browser cannot name
   * stays INVISIBLE rather than rendering as a raw id. So an application the app
   * gains and this map lacks degrades to "not offered here", never to a wrong
   * label. Keep in sync with that package.
   */
  var OPEN_APP_LABELS = {
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
   * The host's resolved applications, cached for the page.
   *
   * `null` means "not read yet". A settled cache holds only a NON-EMPTY catalog:
   * a failed read (the server briefly unavailable, the request fence refusing
   * once) or an empty one is NOT remembered, so the next menu open retries. The
   * first version cached every outcome for the page's lifetime, and one transient
   * failure during the first menu open then cost the 打开… submenu for the whole
   * session — the item simply never appeared again, with nothing on screen to
   * say why. A host that genuinely has no applications answers the same empty
   * catalog again, which costs one small GET per menu open and self-heals the
   * moment the capability appears.
   */
  var openApps = null

  /** Whether a read is already in flight, so the first menu open starts only one. */
  var openAppsPending = false

  /** The in-flight read, so callers arriving while it runs can wait on it. */
  var openAppsRead = null

  /**
   * Read the applications the host resolved as installed.
   *
   * The same route the app's own session-header menu reads, so this offers exactly
   * what that menu offers, in the same order (the host's catalog order). Called
   * with a continuation so the caller can inject as soon as the answer lands.
   *
   * Never rejects. A failed or empty read hands the caller an empty list for THIS
   * menu (which then offers no submenu) and leaves the cache unset, so the next
   * open tries again. Callers arriving while a read is in flight join it — the
   * first version returned without answering, and a menu opened while the first
   * read ran got no row at all that time.
   *
   * @param {Function} done - invoked once the catalog is available.
   */
  function loadOpenApps(done) {
    if (openApps !== null) {
      done(openApps)
      return
    }
    if (openAppsPending) {
      // Join the read that is already running. The answer is read back from the
      // cache variable rather than the promise value, because the first caller's
      // `done` already ran inside the chain and may have settled the cache.
      openAppsRead.then(function () {
        done(openApps === null ? [] : openApps)
      })
      return
    }
    openAppsPending = true
    openAppsRead = fetch('/open-in-app/apps', { headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) return null
        return response.json()
      })
      .then(function (payload) {
        var ids = payload && Array.isArray(payload.apps) ? payload.apps : []
        var named = []
        for (var i = 0; i < ids.length; i++) {
          if (Object.prototype.hasOwnProperty.call(OPEN_APP_LABELS, ids[i])) {
            named.push({ id: ids[i], label: OPEN_APP_LABELS[ids[i]] })
          }
        }
        // The in-flight flag settles BEFORE `done` runs, so a caller that arrives
        // during `done` joins the settled read instead of starting a second one,
        // and a retry requested from inside `done` starts fresh.
        openAppsPending = false
        if (named.length > 0) openApps = named
        reportDiag({ source: 'overlay', kind: 'catalog', count: named.length })
        done(named)
        return named
      })
      .catch(function (error) {
        openAppsPending = false
        reportQuietly(t('读取可打开的应用列表失败'), error)
        reportDiag({ source: 'overlay', kind: 'catalog', error: String(error) })
        done([])
        return []
      })
  }

  /**
   * The app's own submenu class, read from the loaded stylesheet.
   *
   * A CSS-module hash cannot be written down, so it is found by the DECLARATION its
   * rule carries — `position:absolute; bottom:-4px; left:calc(100% + 10px)` is what
   * makes a nested list a submenu in this app, and the rule also brings the
   * `::before` bridge that lets the pointer cross from the parent item into the
   * list. Reading it that way survives a hash change.
   *
   * @returns {string} the class name, or '' when no such rule exists.
   */
  function submenuClassName() {
    var sheets = document.styleSheets
    for (var s = 0; s < sheets.length; s++) {
      var rules
      try {
        rules = sheets[s].cssRules
      } catch (error) {
        // A cross-origin sheet: nothing readable, and not an error worth surfacing.
        continue
      }
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r]
        if (!rule.selectorText || !rule.style) continue
        var css = rule.style.cssText || ''
        if (css.indexOf('-4px') === -1 || css.indexOf('100% + 10px') === -1) continue
        var match = /\.([A-Za-z0-9_-]*submenu[A-Za-z0-9_-]*)/i.exec(rule.selectorText)
        if (match) return match[1]
      }
    }
    return ''
  }

  /**
   * Build the injected menu row, styled as the app's own items are.
   *
   * The markup mirrors a `[role=menuitem]` the app renders — same classes, same
   * roles, same icon/label structure — so the stylesheet, the hover behaviour and
   * the keyboard contract all apply unchanged. The classes are CSS-module hashes,
   * so they are READ OFF a real item in the same menu rather than hard-coded; a
   * hash change therefore means "the item looks unstyled", never "the item is
   * wrong".
   *
   * TWO SHAPES, one builder. A WORKSPACE row's entry opens Explorer directly, as it
   * always has. A SESSION row's entry is a 打开… SUBMENU whose entries are the
   * applications the host resolved — the app's own session-header menu reproduced.
   * The caller passes `apps` for the second shape and `null` for the first.
   *
   * @param {Element} menu - the open menu.
   * @param {string} path - the directory this row opens.
   * @param {Array|null} apps - resolved applications, or null for a direct action.
   * @returns {Element} the row.
   */
  function buildRevealRow(menu, path, apps) {
    var sample = menu.querySelector('[role="menuitem"]')

    /**
     * The class of a sample item's icon or label span.
     *
     * Found by CLASS FRAGMENT rather than by position, and that is deliberate. The
     * first version used `firstElementChild`/`lastElementChild`, which silently
     * yields an empty class the moment the app's item markup gains a child before
     * the icon or after the label — the row would render unstyled with no error
     * anywhere. The fragments (`itemIcon`, `itemLabel`) are the same kind of stable
     * hook `[class*="rowActions"]` already relies on, and losing one degrades to an
     * unstyled span rather than to a wrong one.
     *
     * @param fragment - the class fragment to look for.
     * @returns the matching class string, or '' when the app has neither.
     */
    function classOf(fragment) {
      if (!sample) return ''
      var found = sample.querySelector('[class*="' + fragment + '"]')
      return found === null ? '' : found.className
    }

    var itemClass = sample ? sample.className : ''
    var iconClass = classOf('itemIcon')
    var labelClass = classOf('itemLabel')
    var isSubmenu = apps !== null

    var wrap = document.createElement('div')
    if (sample && sample.parentElement && sample.parentElement.className) {
      wrap.className = sample.parentElement.className
    }
    wrap.setAttribute('data-dsh-desktop', 'reveal-item')

    var button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.className = itemClass
    // A tooltip on the direct action tells the user WHERE it opens — the directory
    // — which is what the app's own row hover card shows too. A submenu parent
    // needs no tooltip: its entries name the applications.
    if (!isSubmenu) button.setAttribute('title', path)
    if (isSubmenu) {
      // The app's own accessibility contract for a submenu parent.
      button.setAttribute('aria-haspopup', 'menu')
      button.setAttribute('aria-expanded', 'false')
    }

    var icon = document.createElement('span')
    icon.className = iconClass
    icon.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
      '<path fill="currentColor" d="' + FOLDER_ICON_PATH + '"></path></svg>'

    var label = document.createElement('span')
    label.className = labelClass
    label.setAttribute('data-dsh-desktop', 'reveal-label')
    label.textContent = isSubmenu ? t(OPEN_LABEL) : t(REVEAL_LABEL)

    button.appendChild(icon)
    button.appendChild(label)
    wrap.appendChild(button)

    var submenu = null
    if (isSubmenu) {
      submenu = buildSubmenu(menu, path, apps, itemClass, iconClass, labelClass)

      attachSidebarSubmenu(menu, wrap, button, submenu)
    } else {
      button.addEventListener('click', function (event) {
        // The menu closes itself on a click; stopping here keeps the app's own
        // outside-click handler from treating it as a dismissal of something else.
        event.stopPropagation()
        openWithApp('explorer', path)
        // Close the menu the way the app does, so its own state stays consistent.
        closeOpenMenu()
      })
    }

    return wrap
  }

  function buildSidebarSubmenuSurface(marker) {
    var list = document.createElement('div')
    list.className = submenuClassName()
    list.setAttribute('role', 'menu')
    list.setAttribute('data-dsh-desktop', marker)

    // The app's submenu class supplies the SURFACE (colours, radius, padding,
    // min-width) but its own `position: absolute; left: calc(100% + 10px)` is
    // neutralised here: that rule positions a list relative to the item WRAPPER it
    // sits in, and this list is portalled to `<body>` instead (see the portal note
    // in `buildRevealRow`). `fixed` coordinates are set on each open, which is
    // correct because the parent menu is itself `position: fixed`.
    list.style.position = 'fixed'
    list.style.bottom = 'auto'
    list.style.display = 'none'
    // A z-index above the bar's 1200 and above every app overlay, so the list is on
    // top wherever it is opened from.
    list.style.zIndex = '1300'
    if (!list.className) {
      // The class was not found — a missing stylesheet rule, or a page whose sheets
      // are unreadable. Draw the app's own surface values so the list still looks
      // like a menu rather than an unstyled stack.
      list.style.cssText =
        'position:fixed;bottom:auto;display:none;z-index:1300;width:max-content;min-width:0;' +
        'max-width:min(360px,calc(100vw - 16px));padding:4px;flex-direction:column;' +
        'border-radius:12px;border:1px solid var(--dsw-alias-border-l2);' +
        'background:var(--dsh-menu-surface,var(--dsw-specific-menu));' +
        'box-shadow:var(--dsh-menu-shadow,var(--dsw-elevation-prominent))'
    }

    return list
  }

  // Shared positioning and lifetime for the sidebar’s 打开… and 复制... menus.
  function attachSidebarSubmenu(menu, wrap, button, submenu) {
    // PORTALLED TO `document.body`, NOT NESTED IN THE MENU — and that is a
    // measured requirement, not a stylistic choice.
    //
    // A nested list is what the app's own `Menu` primitive does, and it works
    // there because its menus are opened from the conversation header. A SIDEBAR
    // menu is different: it is inside `#root`, which is `position: fixed` and so
    // creates a stacking context. Everything within it is painted inside that
    // context, and a later-painted sibling inside the same context — the composer
    // — wins regardless of the list's z-index. Measured on the live page:
    //
    //     nested, submenu z-index 1300            -> click lands on the composer
    //     nested, submenu z-index 2147483647      -> still the composer
    //     nested, MENU ALSO 2147483647            -> still the composer
    //     hoisted to <body>, z-index 1300         -> the submenu wins
    //
    // So the entries were visible but NOT CLICKABLE — the pointer passed through
    // them to the app underneath. Hoisting is the only lever that works; a
    // z-index cannot escape an ancestor's stacking context.
    //
    // The positioning is then explicit rather than inherited from the submenu
    // class, because the class positions a list relative to an item WRAPPER and
    // the portal has no such ancestor. The class is still applied for its colours
    // and radius; `position`/`left`/`top` are set here. Fixed coordinates are
    // correct precisely because the parent menu is itself `position: fixed` and
    // placed at viewport coordinates.
    document.body.appendChild(submenu)
    submenu.style.position = 'fixed'
    submenu.style.bottom = 'auto'

    /**
     * Place the list beside the parent item, clamped to the viewport.
     *
     * Recomputed on every open, because the menu moves between opens (a
     * right-click places it at the cursor) and a stale position would put the
     * list next to where the item used to be.
     */
    function placeSubmenu() {
      var itemBox = wrap.getBoundingClientRect()
      var parentBox = menu.getBoundingClientRect()
      var listBox = submenu.getBoundingClientRect()
      var margin = 8

      // Preferred: immediately right of the item, top-aligned with it. If that
      // would overflow, flip to the left of the item; if the list is taller than
      // the space below, lift it so its bottom stays on screen.
      var left = parentBox.right + 4
      if (left + listBox.width > window.innerWidth - margin) {
        left = parentBox.left - listBox.width - 4
      }
      left = Math.max(margin, Math.min(left, window.innerWidth - listBox.width - margin))

      var top = itemBox.top - 6
      if (top + listBox.height > window.innerHeight - margin) {
        top = window.innerHeight - listBox.height - margin
      }
      top = Math.max(margin, Math.min(top, window.innerHeight - listBox.height - margin))

      submenu.style.left = left + 'px'
      submenu.style.top = top + 'px'
    }

    // Hover opens the portalled list. It stays open through the gap and
    // closes when another parent row is selected, the menu dismisses, or
    // an application is chosen. Moving off the parent alone is not dismissal.
    var closeTimer = null

    function cancelClose() {
      if (closeTimer !== null) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
    }

    function openSubmenu() {
      if (button.disabled || isVanilla()) return
      cancelClose()
      submenu.style.display = 'flex'
      // Intrinsic width is only measurable after display:none is lifted.
      // Position synchronously before paint, using the real option widths.
      placeSubmenu()
      button.setAttribute('aria-expanded', 'true')
    }

    function scheduleClose() {
      cancelClose()
      closeTimer = setTimeout(function () {
        closeTimer = null
        submenu.style.display = 'none'
        button.setAttribute('aria-expanded', 'false')
      }, SUBMENU_CLOSE_DELAY_MS)
    }

    wrap.addEventListener('mouseenter', openSubmenu)
    menu.addEventListener('mouseover', function (event) {
      if (!wrap.contains(event.target) && event.target.closest?.('[role="menuitem"]')) scheduleClose()
    })
    submenu.addEventListener('mouseenter', openSubmenu)

    function reposition() {
      if (menu.isConnected && submenu.isConnected && submenu.style.display !== 'none') placeSubmenu()
    }
    function onResize() { requestAnimationFrame(reposition) }
    var submenuSizes = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null
    if (submenuSizes) { submenuSizes.observe(submenu); submenuSizes.observe(menu) }
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', onResize)

    // The list must not outlive the menu that owns it: the menu is a React portal
    // and unmounts without telling this row, so its removal is watched rather
    // than assumed.
    watchMenuRemoval(menu, submenu, function () {
      cancelClose()
      if (submenuSizes) submenuSizes.disconnect()
      if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', onResize)
    })

    // The parent does not act: the app's primitive shows the list instead of
    // calling `onSelect`, and this matches that. The submenu's own entries act.
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      openSubmenu()
    })
  }

  /**
   * Build the 打开… submenu: one entry per application the host resolved.
   *
   * THE APP'S OWN MENU, REPRODUCED. This mirrors what
   * `dsh-client-ui-open-in-app` renders in the session header, because the request
   * is that its menu appear here unchanged:
   *
   *   - the nested list reuses the app's own SUBMENU class (found in the loaded
   *     stylesheet, since it is a per-build hash), so it inherits the app's
   *     positioning, its `::before` pointer bridge, its styling and its shadow;
   *   - each entry carries the app's real application icon from the host's own
   *     icon route, at the same 18px the app's menu uses — the same PNG, not a
   *     substitute glyph;
   *   - the labels and the order come from the host's catalog, as the app's do.
   *
   * @param {Element} menu - the open menu, for the separator/selection classes.
   * @param {string} path - the directory the chosen application will open.
   * @param {Array} apps - the resolved applications.
   * @param {string} itemClass - the app's item class, copied from a real item.
   * @param {string} iconClass - the app's icon wrapper class.
   * @param {string} labelClass - the app's label class.
   * @returns {Element} the submenu list.
   */
  function buildSubmenu(menu, path, apps, itemClass, iconClass, labelClass) {
    var list = buildSidebarSubmenuSurface('reveal-submenu')

    // The chosen entry, marked with the app's own `selection="fill"` treatment so
    // the submenu shows which application a plain click would use — the app marks
    // its remembered choice the same way.
    var selectedClass = ''
    var sampleSelected = menu.querySelector('[class*="selectedFill"]')
    if (sampleSelected) selectedClass = sampleSelected.className

    var chosen = apps.length > 0 ? apps[0].id : null

    // ONE BUILDER PER ENTRY, and the function boundary is load-bearing.
    //
    // `var` is FUNCTION-scoped, so a handler written inline in the loop below would
    // close over the single `entry` binding and see whichever button the loop
    // finished on. Measured live: every entry reported its own `data-app` yet every
    // one launched `intellij` — the last in the list. A factory gives each entry its
    // own scope, so the handler reads the app it was built for.
    //
    // The `appId` is captured as a STRING rather than read back off the element,
    // because the element is what the closure got wrong in the first place and a
    // primitive cannot be shared by accident.
    function buildEntry(app) {
      var entry = document.createElement('button')
      entry.type = 'button'
      entry.setAttribute('role', 'menuitem')
      entry.className = itemClass + (app.id === chosen && selectedClass ? ' ' + selectedClass : '')
      entry.setAttribute('data-dsh-desktop', 'reveal-app')
      entry.setAttribute('data-app', app.id)

      var entryIcon = document.createElement('span')
      entryIcon.className = iconClass
      var img = document.createElement('img')
      img.src = '/open-in-app/icon/' + app.id
      img.width = 18
      img.height = 18
      img.alt = ''
      img.setAttribute('aria-hidden', 'true')
      img.setAttribute('draggable', 'false')
      img.style.cssText = 'object-fit:contain;user-select:none;display:block;flex:none'
      // An icon the host cannot serve would leave an empty slot; hiding the image
      // keeps the label aligned, as the app's own fallback does.
      img.addEventListener('error', function (event) {
        event.target.style.visibility = 'hidden'
      })
      entryIcon.appendChild(img)

      var entryLabel = document.createElement('span')
      entryLabel.className = labelClass
      entryLabel.textContent = app.label

      entry.appendChild(entryIcon)
      entry.appendChild(entryLabel)

      // HANDLED ON `pointerdown`, NOT `click`, AND THAT IS REQUIRED.
      //
      // The app's own `Menu` installs a document-level `pointerdown` listener that
      // closes the menu when the event's target is outside the menu AND outside the
      // anchor wrapper. A portalled submenu is outside both — that is what lets it
      // escape the sidebar's stacking context — so pressing an entry makes the app
      // unmount the menu, and the row is gone before any `click` can fire. Measured
      // live: `pointerdown` reached the entry, `click` never did, and no request was
      // made.
      //
      // Acting on `pointerdown` therefore runs BEFORE the app's dismissal, which is
      // the same ordering the app's own menu items rely on. The click event is still
      // stopped so nothing downstream treats the press as a second action.
      entry.addEventListener('pointerdown', function (event) {
        event.stopPropagation()
        openWithApp(app.id, path)
        // Close the menu the way the app does, so its own state stays consistent.
        closeOpenMenu()
      })
      entry.addEventListener('click', function (event) {
        // The press already acted; this only stops the click from reaching anything
        // that would treat it as an outside click on an already-closed menu.
        event.stopPropagation()
      })

      return entry
    }

    for (var i = 0; i < apps.length; i++) {
      list.appendChild(buildEntry(apps[i]))
    }

    return list
  }

  /**
   * Add the reveal row to an open sidebar menu, once.
   *
   * Idempotent: the menu is re-rendered as the pointer moves, and each render is a
   * chance to add a second copy. The row carries a marker, so this returns
   * immediately when it is already there.
   *
   * TWO MENUS, TWO SHAPES. A WORKSPACE row's menu gets the direct
   * 在资源管理器打开. A SESSION row's menu gets 打开… as a submenu listing every
   * application the host resolved — the app's own session-header menu reproduced.
   * Which one applies is decided by the row whose menu is open, which the app
   * marks with a `menuOpen` class.
   */
  function injectRevealItem() {
    if (isVanilla()) return
    if (!window.__TAURI__?.core?.invoke) return

    var menu = openMenuElement()
    if (!menu) return

    // Only the sidebar's row menus, which is where a directory is known. The
    // guard is structural rather than a class list: a row menu is the only menu
    // whose trigger lives in a row that is marked open.
    var openRow = document.querySelector('[class*="menuOpen"][role="treeitem"]')
    var headerSessionId = menu.getAttribute('data-dsh-header-session-id')
    if (!openRow && !headerSessionId) return

    var isSession = !!headerSessionId || /sessionRow/.test(String(openRow.className))

    // The deep-link row goes in FIRST and synchronously: a session's id is on
    // the row's own fiber, needing no async catalog, and injecting here means
    // the row exists even when the reveal item's own directory walk below comes
    // up empty (the ungrouped bucket has no directory by definition).
    if (isSession) {
      injectDeepLinkItem(menu, headerSessionId || sessionIdFromRow(openRow))
    }

    if (menu.querySelector('[data-dsh-desktop="reveal-item"]')) return

    var path = headerSessionId ? menu.getAttribute('data-dsh-header-session-path') || undefined : openRowDirectory()
    if (path === undefined) return

    if (isSession) {
      // The catalog arrives asynchronously, so the row is built when it lands. The
      // menu may have closed by then, which the build re-checks rather than
      // injecting into a stale node.
      loadOpenApps(function (apps) {
        if (apps.length === 0) return
        if (isVanilla()) return
        var stillOpen = openMenuElement()
        if (!stillOpen || stillOpen !== menu) return
        if (menu.querySelector('[data-dsh-desktop="reveal-item"]')) return
        // The row that opened this menu must STILL be the open one: a fast user can
        // open another menu between the request and its answer.
        var currentOpen = document.querySelector('[class*="menuOpen"][role="treeitem"]')
        if (headerSessionId ? menu.getAttribute('data-dsh-header-session-id') !== headerSessionId : currentOpen !== openRow) return
        reportDiag({
          source: 'overlay',
          kind: 'inject',
          shape: 'submenu',
          path: path,
          apps: apps.map(function (a) {
            return a.id
          }),
        })
        appendRevealRow(menu, buildRevealRow(menu, path, apps))
      })
      return
    }

    reportDiag({ source: 'overlay', kind: 'inject', shape: 'direct', path: path })
    appendRevealRow(menu, buildRevealRow(menu, path, null))
  }

  /**
   * Put an injected row at the end of a menu, below a divider.
   *
   * The row goes after everything, below a divider, so it can never be mistaken for
   * one of the app's own actions — least of all the destructive ones (删除工作区
   * and 归档会话 both sit directly above it).
   *
   * @param {Element} menu - the open menu.
   * @param {Element} row - the built row.
   * @param {string} [dividerMarker] - the divider's `data-dsh-desktop` value,
   *   defaulting to the reveal row's. Each injected row owns its marker
   *   (`reveal-divider`, `link-divider`) so a test — or a future row — can
   *   assert one feature's absence without the other's divider tripping the count.
   */
  function appendRevealRow(menu, row, dividerMarker) {
    if (dividerMarker === undefined) dividerMarker = 'reveal-divider'
    var viewport = menu.querySelector('[data-dsh-header-menu-extras]') || menu.querySelector('[class*="viewport"]') || menu

    var divider = document.createElement('div')
    divider.setAttribute('role', 'separator')
    divider.setAttribute('data-dsh-desktop', dividerMarker)
    var sampleSeparator = menu.querySelector('[role="separator"], div[class*="separator"]')
    divider.className = sampleSeparator ? sampleSeparator.className : ''
    if (!divider.className) {
      // No separator to copy styling from: draw the app's own hairline token
      // rather than shipping an unstyled element.
      divider.style.cssText = 'height:.5px;margin:4px 2px;background:var(--dsw-alias-border-l1)'
    }

    viewport.appendChild(divider)
    viewport.appendChild(row)
  }

  /**
   * Copy one session's deep link, from the sidebar row menu.
   *
   * The host clipboard is the same command the title bar uses (`clipboard_write_text`,
   * granted to this origin), reached through the global `__TAURI__` the shell
   * injects. Every step is guarded like {@link showDesktopToast}: a copy that
   * throws would replace the action with an unhandled error in a menu that is
   * about to unmount.
   *
   * @param {string} sessionId - the session the link names.
   */
  function copySessionDeepLink(sessionId) {
    var link = DEEP_LINK_PREFIX + sessionId
    try {
      var api = window.__TAURI__
      if (!api || !api.core || typeof api.core.invoke !== 'function') {
        showDesktopToast(t('无法复制深度链接：宿主接口不可用'))
        return
      }
      api.core.invoke('clipboard_write_text', { text: link }).then(
        function () {
          showDesktopToast(t('已复制深度链接'))
        },
        function (error) {
          showDesktopToast(t('复制深度链接失败'), error)
        },
      )
    } catch (error) {
      showDesktopToast(t('复制深度链接失败'), error)
    }
  }

  /**
   * Build the SESSION menu's 复制... parent and its three actions.
   * The portalled submenu uses the same surface and positioning as 打开….
   *
   * A row whose id could not be read renders DISABLED, never absent — see
   * {@link sessionIdFromRow}.
   *
   * @param {Element} menu - the open menu, for the item classes to copy.
   * @param {string|undefined} sessionId - the row's session id, when readable.
   * @returns {Element} the row.
   */
  function buildDeepLinkRow(menu, sessionId) {
    var sample = menu.querySelector('[role="menuitem"]')

    function classOf(fragment) {
      if (!sample) return ''
      var found = sample.querySelector('[class*="' + fragment + '"]')
      return found === null ? '' : found.className
    }

    var itemClass = sample ? sample.className : ''
    var iconClass = classOf('itemIcon')
    var labelClass = classOf('itemLabel')

    var wrap = document.createElement('div')
    if (sample && sample.parentElement && sample.parentElement.className) {
      wrap.className = sample.parentElement.className
    }
    wrap.setAttribute('data-dsh-desktop', 'link-item')

    var button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.className = itemClass
    button.disabled = sessionId === undefined
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')

    var icon = document.createElement('span')
    icon.className = iconClass
    var paths = ''
    for (var p = 0; p < LINK_ICON_PATHS.length; p++) {
      paths += '<path fill="currentColor" d="' + LINK_ICON_PATHS[p] + '"></path>'
    }
    var linkIcon =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' + paths + '</svg>'
    icon.innerHTML = COPY_ICON

    var label = document.createElement('span')
    label.className = labelClass
    label.setAttribute('data-dsh-desktop', 'link-label')
    label.textContent = t('复制...')

    button.appendChild(icon)
    button.appendChild(label)
    wrap.appendChild(button)

    if (sessionId !== undefined) {
      var submenu = buildSidebarSubmenuSurface('copy-submenu')
      var actions = [
        { id: 'copy-link', label: t(DEEP_LINK_LABEL), icon: linkIcon },
        { id: 'copy-content', label: t('复制会话内容'), icon: COPY_ICON, method: 'copyContent' },
        { id: 'save-content', label: t('保存会话内容'), icon: DOWNLOAD_ICON, method: 'saveContent' },
      ]
      actions.forEach(function (action) {
        var entry = document.createElement('button')
        entry.type = 'button'
        entry.className = itemClass
        entry.setAttribute('role', 'menuitem')
        entry.setAttribute('data-dsh-desktop', 'copy-action')
        entry.setAttribute('data-action', action.id)
        var entryIcon = document.createElement('span')
        entryIcon.className = iconClass
        entryIcon.innerHTML = action.icon
        var entryLabel = document.createElement('span')
        entryLabel.className = labelClass
        entryLabel.textContent = action.label
        entry.appendChild(entryIcon)
        entry.appendChild(entryLabel)
        function activate(event) {
          event.stopPropagation()
          if (action.id === 'copy-link') copySessionDeepLink(sessionId)
          else {
            var service = window.__DSH_SESSION_ACTIONS__
            if (typeof service?.[action.method] === 'function') service[action.method](sessionId)
            else showDesktopToast(action.label + t('失败：会话服务不可用'))
          }
          closeOpenMenu()
        }
        // Act before the app dismisses the portalled menu on pointerdown.
        entry.addEventListener('pointerdown', function (event) {
          if (event.button != null && event.button !== 0) return
          activate(event)
        })
        entry.addEventListener('click', function (event) { event.stopPropagation() })
        entry.addEventListener('keydown', function (event) {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          activate(event)
        })
        submenu.appendChild(entry)
      })
      attachSidebarSubmenu(menu, wrap, button, submenu)
      button.addEventListener('keydown', function (event) {
        if (!['ArrowRight', 'Enter', ' '].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        button.click()
        submenu.children[0].focus()
      })
      submenu.addEventListener('keydown', function (event) {
        var entries = Array.from(submenu.children)
        var index = entries.indexOf(event.target)
        if (event.key === 'ArrowLeft') {
          submenu.style.display = 'none'
          button.setAttribute('aria-expanded', 'false')
          button.focus()
        } else if (event.key === 'Escape') closeOpenMenu()
        else if (event.key === 'ArrowDown') entries[(index + 1) % entries.length].focus()
        else if (event.key === 'ArrowUp') entries[(index + entries.length - 1) % entries.length].focus()
        else if (event.key === 'Home') entries[0].focus()
        else if (event.key === 'End') entries[entries.length - 1].focus()
        else return
        event.preventDefault()
        event.stopPropagation()
      })
    }

    return wrap
  }

  /**
   * Add the deep-link row to an open SESSION menu, once.
   *
   * Idempotent like {@link injectRevealItem}: the menu re-renders as the pointer
   * moves, and each render is a chance to add a second copy. Only SESSION rows
   * get the item — a workspace row names no single session to link to — so the
   * caller decides, and this only guards against double injection.
   *
   * @param {Element} menu - the open menu.
   * @param {string|undefined} sessionId - the session id, when the row exposed one.
   */
  function injectDeepLinkItem(menu, sessionId) {
    if (menu.querySelector('[data-dsh-desktop="link-item"]')) return
    appendRevealRow(menu, buildDeepLinkRow(menu, sessionId), 'link-divider')
  }

  /**
   * Watch row menus and keep nested menus inside the viewport.
   *
   * The menu is a portal that React mounts and unmounts, so a `MutationObserver`
   * on the body is what catches it. Row injection only runs for a marked row;
   * nested-menu measurement only runs for open submenus. Both stand down in 原版.
   */
  function watchRowMenus() {
    if (typeof MutationObserver !== 'function') return
    if (window.__dshDesktopRowMenuLayout === true) return
    window.__dshDesktopRowMenuLayout = true
    var scheduled = false
    var nested = new Map()
    var sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null

    function fitNestedMenus() {
      nested.forEach(function (anchor, menu) {
        if (menu.isConnected) return
        if (sizes) { sizes.unobserve(menu); sizes.unobserve(anchor) }
        nested.delete(menu)
      })
      if (isVanilla()) return
      var menus = document.querySelectorAll('[role="menu"] [role="menu"]')
      for (var i = 0; i < menus.length; i++) {
        var menu = menus[i]
        if (menu.closest('[data-dsh-ghost]')) continue
        var anchor = menu.parentElement
        var box = menu.getBoundingClientRect()
        if (!anchor || !box.width || !box.height) continue
        // Only take over the app's inline submenus, not future portalled ones.
        if (!nested.has(menu) && getComputedStyle(menu).position !== 'absolute') continue
        if (!nested.has(menu)) {
          nested.set(menu, anchor)
          if (sizes) { sizes.observe(menu); sizes.observe(anchor) }
        }
        var item = anchor.getBoundingClientRect()
        var parentMenu = anchor.closest('[role="menu"]')
        var surface = parentMenu.getBoundingClientRect()
        var left = surface.right + 4
        if (left + box.width > window.innerWidth - MENU_MARGIN) left = surface.left - box.width - 4
        left = Math.max(MENU_MARGIN, Math.min(left, window.innerWidth - box.width - MENU_MARGIN))
        var top = Math.max(MENU_MARGIN, Math.min(item.top - 6, window.innerHeight - box.height - MENU_MARGIN))
        // Custom properties are inert once 原版 removes the tag; React retains
        // ownership of the node, its handlers, and all existing inline styles.
        menu.style.setProperty('--dsh-menu-left', left + 'px')
        menu.style.setProperty('--dsh-menu-top', top + 'px')
        menu.setAttribute('data-dsh-desktop', 'nested-menu')
      }
    }

    function schedule() {
      // Coalesce: one render produces many records, and injecting is idempotent.
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(function () {
        scheduled = false
        injectRevealItem()
        fitNestedMenus()
      })
    }
    var observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] })
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
  }

  /**
   * Apply a mode change at once, instead of waiting for the next poll.
   *
   * The steady-state pass runs every {@link WATCH_MS} (2s), which is fine for
   * surviving re-renders but far too slow to answer a click on 切换成原版 — the
   * user would watch the old styling persist for up to two seconds. So the client
   * plugin announces the change and this listener runs a pass immediately.
   *
   * INSTALLED AT MOST ONCE, like the context-menu binding and for the same
   * reason. The listener is passive: it does not carry the mode itself, it just
   * re-reads the attribute, so a double evaluation can only cause a redundant
   * pass, never an inconsistency.
   */
  function installModeListener() {
    if (window.__dshDesktopModeListener === true) return
    window.__dshDesktopModeListener = true
    document.addEventListener('dsh-desktop:ui-mode', function () {
      pass()
    })
  }

  // ── the remote page's quick actions, in the title bar ──────────────────────
  //
  // On the 远程控制 page the sidebar is a drawer (mobile.css) and its collapsed
  // rail is gone — but the rail carried controls a phone needs direct access
  // to: 新建会话, the workspace search, and the Cordis 插件 trigger. This tier
  // rebuilds them as icon+text buttons inside the title bar's own `dshTb__quick`
  // container, which sits beside the mark — the bar's top-left corner stays the
  // mark's — and which the title-bar plugin renders EMPTY for exactly this
  // purpose: React owns the container element but never its children, so DOM
  // content here survives every bar re-render and dies with the bar.
  //
  // 设置 is deliberately absent from the phone's quick actions and drawer.
  //
  // The rail's OWN drawer toggle is deliberately NOT mirrored. The bar already
  // carries that control as its mark — the logo, which reveals the app's panel
  // glyph on hover and drives `layout.toggleSidebar()` — so a second, text
  // labelled 打开侧边栏 button beside it was the same action twice, and the
  // labelled copy made the bar read as a menu rather than as window chrome.
  // The mark is the drawer's entry point; nothing in this tier opens the drawer.
  //
  // Each rebuilt button re-finds its ORIGINAL at click time and clicks it, so
  // the action is always the app's own handler however many re-renders have
  // passed; nothing is reimplemented, only made reachable from a second place.
  // The steady-state pass re-syncs the cluster (labels, icons, order), which is
  // what absorbs a bar remount (a fresh, empty container) and a panel list that
  // changed shape.

  /**
   * The CSS-module group selectors holding the rail's controls, in rail order.
   *
   * The search entry exists in BOTH sidebar states — the expanded sidebar
   * renders the inline search slot, the collapsed rail a plain search button —
   * and both carry the same aria-label, so one selector covers both and the
   * click always reaches whichever state is live.
   *
   * The rail's own collapse toggle (`button[class*='_toggle']`) is absent on
   * purpose: the bar's mark carries that action, glyph and hover swap included
   * (see `title-bar/client.js`), so mirroring it here would put the same command
   * on screen twice — once as an icon, once as a labelled button.
   *
   * `snap: false` marks an action that must NOT open the drawer first.
   * 新建会话 starts a fresh conversation: snapping the drawer over the composer
   * it just revealed hides the only visible result of the tap. Panel navigation
   * (including 插件) also renders in the main view and needs no open drawer.
   * Search and the legacy footer popover still use their sidebar anchors.
   */
  var RAIL_GROUPS = [
    { selector: "button[class*='_newSession']", snap: false },
    { selector: "button[class*='_searchButton']" },
    { selector: "[class*='_panelList'] button[class*='_panelRow']", snap: false },
    { selector: "[class*='_footerActions'] button" },
  ]

  /**
   * Whether this page is a plain browser — the 远程控制 page.
   *
   * Same read the title bar makes; the attribute is set by the injected
   * `browser-compat.js` before either bundle runs.
   *
   * @returns {boolean} whether the page is not the desktop webview.
   */
  function isRemotePage() {
    return document.documentElement.getAttribute('data-dsh-browser') !== null
  }

  /**
   * Escape a label for use inside an attribute selector's string.
   *
   * Only the two characters that can terminate the literal need care; every
   * other character (CJK included) passes through.
   *
   * @param {string} value - the raw label.
   * @returns {string} the selector-safe literal body.
   */
  function selectorLiteral(value) {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  }

  /**
   * A control's label: its own aria-label, or its text.
   *
   * @param {Element} node - the rail control.
   * @returns {string} the trimmed label, possibly empty.
   */
  function railLabelOf(node) {
    var text = node.getAttribute('aria-label') || node.textContent || ''
    return text.replace(/\s+/g, ' ').trim()
  }

  /**
   * The sidebar root — the element whose buttons the rail shows.
   *
   * The layout's sidebar column hosts exactly one child, the sidebar itself.
   *
   * @returns {Element|null} the sidebar root, or null before the app mounts.
   */
  function sidebarRoot() {
    var column = document.querySelector("[class*='_sidebarCol']")
    return column !== null ? column.firstElementChild : null
  }

  /**
   * Collect the rail's controls as rebuildable handles.
   *
   * Each entry pairs a selector that re-finds the control inside the CURRENT
   * sidebar root with the label and icon to render. Selectors are per-control —
   * the group plus its aria-label — because React re-renders replace the nodes;
   * a stored element would silently stop working on the first sidebar update.
   *
   * @param {Element} root - the sidebar root.
   * @returns {Array<{selector: string, label: string, icon: Element|null, snap: boolean}>} the handles.
   */
  function railActions(root) {
    var actions = []
    for (var g = 0; g < RAIL_GROUPS.length; g++) {
      var group = RAIL_GROUPS[g].selector
      var nodes = root.querySelectorAll(group)
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var label = railLabelOf(node)
        if (label === '') continue
        var selector = group + "[aria-label='" + selectorLiteral(label) + "']"
        // A group whose members share one label (or have none distinguishable)
        // would resolve every entry to the first match; fall back to the group
        // itself, which is correct whenever the group holds exactly one control.
        if (root.querySelectorAll(selector).length === 0) selector = group
        var icon = node.querySelector('svg')
        actions.push({
          selector: selector,
          label: label,
          icon: icon !== null && icon !== undefined ? icon.cloneNode(true) : null,
          snap: RAIL_GROUPS[g].snap !== false,
        })
      }
    }
    return actions
  }

  /** The title-bar container this tier fills, once the bar has mounted. */
  function quickContainer() {
    return document.querySelector('.dshTb__quick')
  }

  /** The visible session's panel; retained sessions can keep hidden panels. */
  function remoteOpenPanel() {
    var panels = document.querySelectorAll('[data-sidebar-right-panel][data-sidebar-right-open]')
    for (var i = 0; i < panels.length; i++) {
      if (!panels[i].closest('[hidden]')) return panels[i]
    }
    return null
  }

  /** The native tab strip owns the phone's collapse button. Cover the session
   * header while open so the tabs and collapse action occupy just one row. */
  function syncRemotePanelChrome() {
    if (!isRemotePage()) return
    var panel = remoteOpenPanel()
    var corner = document.querySelector('[data-conversation-header-corner]')
    var active = panel !== null && corner !== null
    var html = document.documentElement
    if (active) {
      if (!html.hasAttribute('data-dsh-mobile-right-open')) html.setAttribute('data-dsh-mobile-right-open', '')
    } else {
      html.removeAttribute('data-dsh-mobile-right-open')
    }
    if (!active) return
    var header = corner.closest('header')
    if (header) {
      var top = Math.max(44, header.getBoundingClientRect().top)
      var value = top + 'px'
      if (html.style.getPropertyValue('--dsh-mobile-right-top') !== value) {
        html.style.setProperty('--dsh-mobile-right-top', value)
      }
    }
    // Reveal a newly selected/opened tab once. Do not reset a user's swipe on
    // subsequent DOM passes, and never scroll the page or terminal vertically.
    var strips = panel.querySelectorAll('[data-dockkit-strip-tabs]')
    for (var i = 0; i < strips.length; i++) {
      var strip = strips[i]
      var selected = strip.querySelector('[data-dockkit-tab][aria-selected="true"]')
      var id = selected && selected.getAttribute('data-dockkit-tab')
      if (!id || strip.getAttribute('data-dsh-selected-tab') === id) continue
      strip.setAttribute('data-dsh-selected-tab', id)
      var bounds = strip.getBoundingClientRect()
      var tab = selected.getBoundingClientRect()
      if (tab.left < bounds.left) strip.scrollLeft += tab.left - bounds.left
      else if (tab.right > bounds.right) strip.scrollLeft += tab.right - bounds.right
    }
  }

  /**
   * Rebuild — or confirm — the title bar's quick actions.
   *
   * Cheap when nothing changed: the cluster's signature is the button labels,
   * and an equal signature leaves the DOM untouched, so the 2-second pass pays
   * one querySelectorAll per group and nothing else.
   */
  function syncRemoteQuickActions() {
    if (!isRemotePage()) return
    var container = quickContainer()
    if (container === null) return
    var root = sidebarRoot()
    var actions = root !== null ? railActions(root) : []
    var signature = ''
    for (var i = 0; i < actions.length; i++) signature += actions[i].label + '\n'
    if (container.getAttribute('data-dsh-quick-signature') === signature) return

    while (container.firstChild !== null) container.removeChild(container.firstChild)
    for (var j = 0; j < actions.length; j++) {
      container.appendChild(buildQuickButton(actions[j]))
    }
    if (actions.length === 0) {
      container.setAttribute('data-dsh-quick-empty', 'true')
    } else {
      container.removeAttribute('data-dsh-quick-empty')
    }
    container.setAttribute('data-dsh-quick-signature', signature)
  }

  /**
   * Build one icon+text button wired to a rail control.
   *
   * The click re-finds the original through its selector and clicks THAT, so
   * keyboard focus, tooltips and side effects all belong to the app's own
   * handler. Focus is not suppressed on the rebuilt button: unlike the bar's
   * desktop menus there is no clipboard selection to preserve, and a phone tap
   * leaving focus on a control that answers the next tap reads correctly.
   *
   * @param {{selector: string, label: string, icon: Element|null, snap: boolean}} action - the handle.
   * @returns {HTMLButtonElement} the title-bar button.
   */
  function buildQuickButton(action) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'dshTb__quickItem'
    button.setAttribute('aria-label', action.label)
    button.title = action.label
    if (action.icon !== null) {
      var icon = action.icon.cloneNode(true)
      icon.removeAttribute('class')
      var slot = document.createElement('span')
      slot.className = 'dshTb__quickIcon'
      slot.setAttribute('aria-hidden', 'true')
      slot.appendChild(icon)
      button.appendChild(slot)
    }
    var text = document.createElement('span')
    text.className = 'dshTb__quickLabel'
    text.textContent = action.label
    button.appendChild(text)
    button.addEventListener('click', function () {
      // The Cordis trigger's panel is a fixed surface anchored to its own
      // badge, so wait for the drawer to reach its final position before
      // clicking the original control. The drawer uses the same animation
      // preference for quick actions and direct toggles. 新建会话 opts
      // out (`snap: false`): it belongs to the conversation, and the drawer
      // covering the composer it just opened reads as a tap that did nothing.
      // Opening the drawer is never this tier's own action: the bar's mark is
      // the drawer's control, and the toggle that used to sit in this cluster
      // was removed rather than routed there (see `RAIL_GROUPS`).
      var frame = document.querySelector("[class*='_frame']")
      var column = document.querySelector("[class*='_sidebarCol']")
      var closed = action.snap === true && frame !== null && frame.getAttribute('data-sidebar-collapsed') !== null
      if (closed && column !== null) {
        var mark = document.querySelector('.dshTb__mark')
        if (mark !== null) mark.click()
      }
      var activate = function () {
        // Re-resolve root AND control: a re-render replaces both, and a click
        // on a stale node would be a silent nothing.
        var currentRoot = sidebarRoot()
        var current = currentRoot !== null ? currentRoot.querySelector(action.selector) : null
        // A second toggle may have closed the drawer while this action waited.
        if (closed && frame.getAttribute('data-sidebar-collapsed') !== null) return
        if (current !== null) current.click()
      }
      requestAnimationFrame(function () {
        if (closed && animationsActive()) setTimeout(activate, 240)
        else activate()
      })
    })
    return button
  }

  // Model editors unmount on close, while customized settings use native details.
  // Keep React's inputs untouched; only a short-lived inert clone plays the exit.
  function watchModelDisclosures() {
    if (typeof MutationObserver !== 'function' || !document.body.animate || window.__dshModelMotion) return
    window.__dshModelMotion = true
    var selector = '[class*="_rowCard"] > [class$="_editor"], [class*="_addBlock"] > [class$="_addCard"], [class*="_modelEntry"] > [class$="_modelAdvanced"]'
    var listSelector = '[class*="_rows"] > [class$="_rowCard"], [class*="_modelList"] > [class$="_modelEntry"], [class*="_modelCatalog"] > [class$="_modelList"]'
    var running = new Map()
    var ghosts = new Map()
    var detailsTargets = new Map()
    function finish(node) {
      var animation = running.get(node)
      running.delete(node)
      if (animation) animation.cancel()
      ghosts.forEach(function (ghost, parent) { if (ghost === node) ghosts.delete(parent) })
      if (!node.isConnected) detailsTargets.delete(node)
      if (node.hasAttribute('data-dsh-model-exit')) node.remove()
    }
    function cancelAll() {
      detailsTargets.forEach(function (open, node) { node.open = open })
      detailsTargets.clear()
      Array.from(running.keys()).forEach(finish)
      ghosts.clear()
    }
    document.addEventListener('click', function (event) {
      var summary = event.target.closest && event.target.closest('summary')
      var details = summary && summary.parentElement
      if (!details || !details.matches('details[class*="_customized"]') ||
          !details.closest('[data-shortcut-modal="settings"]') || event.defaultPrevented || !animationsActive()) return
      event.preventDefault()
      var open = !(detailsTargets.has(details) ? detailsTargets.get(details) : details.open)
      var from = details.getBoundingClientRect().height
      finish(details)
      detailsTargets.set(details, open)
      details.open = open
      var to = details.getBoundingClientRect().height
      details.open = true // Retain the real fields until the closing frame finishes.
      details.setAttribute('data-dsh-model-motion', '')
      var animation = details.animate([{ height: from + 'px' }, { height: to + 'px' }], {
        duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)'
      })
      running.set(details, animation)
      animation.onfinish = function () {
        details.open = open
        detailsTargets.delete(details)
        running.delete(details)
        details.removeAttribute('data-dsh-model-motion')
      }
      animation.oncancel = function () { details.removeAttribute('data-dsh-model-motion') }
    })
    function animate(node, closing, startHeight) {
      if (!animationsActive()) { if (closing) node.remove(); return }
      var style = getComputedStyle(node)
      var height = node.getBoundingClientRect().height
      var full = { height: height + 'px', opacity: 1, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
        marginTop: style.marginTop, marginBottom: style.marginBottom, borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth }
      var empty = { height: (startHeight || 0) + 'px', opacity: 0, paddingTop: '0px', paddingBottom: '0px',
        marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px' }
      var animation = node.animate(closing ? [full, empty] : [empty, full], {
        duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)'
      })
      node.setAttribute('data-dsh-model-motion', '')
      running.set(node, animation)
      animation.onfinish = function () {
        running.delete(node)
        node.removeAttribute('data-dsh-model-motion')
        if (closing) { if (ghosts.get(node.parentElement) === node) ghosts.delete(node.parentElement); node.remove() }
      }
      animation.oncancel = function () { node.removeAttribute('data-dsh-model-motion') }
    }
    // React reuses the addActions div as addCard and back. Reconstruct its old
    // children from the mutation batch, then cross-fade while the shared block
    // changes height. The outgoing copy stays out of layout and cannot take input.
    function animateProviderToggle(node, oldClass, records) {
      var parent = node.parentElement
      var previous = node.cloneNode(false)
      previous.setAttribute('class', oldClass)
      records.forEach(function (record) {
        if (record.type !== 'childList' || record.target !== node) return
        Array.from(record.removedNodes).forEach(function (child) { previous.appendChild(child.cloneNode(true)) })
      })
      if (!previous.childNodes.length) return
      var interruptedHeight = running.has(parent) ? parent.getBoundingClientRect().height : null
      finish(parent)
      finish(node)
      if (ghosts.has(parent)) finish(ghosts.get(parent))
      previous.removeAttribute('id')
      previous.removeAttribute('data-dsh-model-motion')
      previous.querySelectorAll('[id]').forEach(function (child) { child.removeAttribute('id') })
      previous.setAttribute('data-dsh-model-exit', '')
      previous.setAttribute('aria-hidden', 'true')
      previous.inert = true
      previous.style.position = 'absolute'
      previous.style.inset = '0 0 auto'
      previous.style.boxSizing = 'border-box'
      parent.setAttribute('data-dsh-provider-motion', '')
      parent.appendChild(previous)
      var from = interruptedHeight === null ? previous.getBoundingClientRect().height : interruptedHeight
      var to = node.getBoundingClientRect().height
      parent.setAttribute('data-dsh-model-motion', '')
      var options = { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }
      var height = parent.animate([{ height: from + 'px' }, { height: to + 'px' }], options)
      var enter = node.animate([{ opacity: 0 }, { opacity: 1 }], options)
      var leave = previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })
      running.set(parent, height)
      running.set(node, enter)
      running.set(previous, leave)
      ghosts.set(parent, previous)
      var cleaned = false
      height.onfinish = height.oncancel = function () {
        if (cleaned) return
        cleaned = true
        running.delete(parent)
        finish(node)
        finish(previous)
        parent.removeAttribute('data-dsh-model-motion')
        parent.removeAttribute('data-dsh-provider-motion')
      }
    }
    var observer = new MutationObserver(function (records) {
      if (!animationsActive()) { cancelAll(); return }
      var toggled = new Set()
      records.forEach(function (record) {
        var node = record.target
        if (record.type !== 'attributes' || toggled.has(node) || !node.isConnected ||
            !node.matches('[class*="_addBlock"] > div') || !node.closest('[data-shortcut-modal="settings"]') ||
            node.closest('[data-dsh-model-exit], [data-dsh-ghost]')) return
        var before = record.oldValue || '', after = node.getAttribute('class') || ''
        if (!(/\S+_addActions(?:\s|$)/.test(before) && /\S+_addCard(?:\s|$)/.test(after)) &&
            !(/\S+_addCard(?:\s|$)/.test(before) && /\S+_addActions(?:\s|$)/.test(after))) return
        toggled.add(node)
        animateProviderToggle(node, before, records)
      })
      records.forEach(function (record) {
        if (record.type === 'attributes') return
        var parent = record.target
        if (!parent.isConnected || !parent.closest('[data-shortcut-modal="settings"]') || parent.closest('[data-dsh-model-exit], [data-dsh-ghost]')) return
        Array.from(record.removedNodes).forEach(function (node) {
          if (node.nodeType !== 1 || node.isConnected || node.hasAttribute('data-dsh-model-exit')) return
          // Detached nodes cannot match parent selectors; match a shallow probe.
          var probe = parent.cloneNode(false), clone = node.cloneNode(true)
          probe.appendChild(clone)
          var listItem = clone.matches(listSelector)
          if (!listItem && !clone.matches(selector)) return
          // Multiple deleted rows each retain their own exit. Only disclosures
          // share one ghost per parent for a rapid close/reopen interaction.
          if (!listItem && ghosts.has(parent)) finish(ghosts.get(parent))
          finish(node)
          clone.removeAttribute('data-dsh-model-motion')
          clone.setAttribute('data-dsh-model-exit', '')
          clone.setAttribute('aria-hidden', 'true')
          clone.inert = true
          clone.querySelectorAll('[id]').forEach(function (child) { child.removeAttribute('id') })
          clone.removeAttribute('id')
          parent.insertBefore(clone, record.nextSibling && record.nextSibling.parentNode === parent ? record.nextSibling : null)
          if (!listItem) ghosts.set(parent, clone)
          animate(clone, true)
        })
        Array.from(record.addedNodes).forEach(function (node) {
          if (node.nodeType !== 1 || !node.isConnected || node.hasAttribute('data-dsh-model-exit') || !node.matches(selector + ', ' + listSelector)) return
          // React can move an existing row without adding a new model/provider.
          if (records.some(function (change) { return Array.from(change.removedNodes).includes(node) })) return
          var ghost = node.matches(listSelector) ? null : ghosts.get(parent), startHeight = ghost ? ghost.getBoundingClientRect().height : 0
          if (ghost) { finish(ghost); ghosts.delete(parent) }
          animate(node, false, startHeight)
        })
      })
      Array.from(running.keys()).forEach(function (node) { if (!node.isConnected) finish(node) })
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
    var preferences = new MutationObserver(function () { if (!animationsActive()) cancelAll() })
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dsh-ui', 'data-dsh-desktop-animation'] })
    var media = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')
    if (media && media.addEventListener) media.addEventListener('change', function () { if (!animationsActive()) cancelAll() })
  }

  begin()
  watchRelocatedRows()
  watchRowMenus()
  watchRemovalGhosts()
  watchViewMotion()
  watchModelDisclosures()
  installFileReferenceSelection()
  installImagePreviewGestures()
  watchPreviewPaths()
  installContextMenu()
  installReportListener()
  installModeListener()
})()
