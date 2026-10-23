/**
 * Browser half of the desktop appearance settings plugin.
 *
 * Adds an **外观** section to DSH's settings, holding the theme, font-size, and
 * animation controls. Loaded from the desktop app's own directory by
 * `dsh-client-modules`, which scans Loader rows whose manifest declares
 * `dsh.client` — so it ships with the app and touches no DSH file.
 *
 * ## Why this is not compiled
 *
 * This is a **hand-authored client bundle**, not build output. The esbuild/tsdown
 * step `dsh-client-modules` normally expects exists to turn TypeScript and JSX
 * into the shape below; writing that shape directly removes a bundler from the
 * desktop app's toolchain. The cost is that JSX and TypeScript are unavailable
 * here, so components are built with `React.createElement`, aliased to `h`, and
 * the file must stay a classic-style factory rather than using module syntax.
 *
 * ## How state and updates work
 *
 * The app's own appearance row reads through a slot *store* and subscribes to the
 * client context's `theme/change` event; `ThemeRuntime` deliberately exposes no
 * subscription of its own (its reads are `getTheme()`, and continuous sync is
 * documented as going only through that event). This file follows the same
 * contract, using `useSyncExternalStore` over a local store so React re-renders
 * exactly when the theme revision changes.
 */

window.__ModuleLoader__.load({
  id: '@dsh-desktop/appearance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    
  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
  const useLocale = React => window.__DSH_I18N__?.use(React)
var React = require('react')

    /**
     * The app's own UI primitives, for the font-size selector's menu.
     *
     * 通用设置 renders a settings row's value selector as the `Menu` primitive
     * wrapping a pill button, and this section's font-size control now does the
     * same, so its popup is the same surface every other selector in the window
     * opens rather than the engine's native list — see {@link FontSizeRow}.
     *
     * RESOLVED GUARDED, and the guard must catch rather than propagate: the word is
     * a platform seed resolved through `require`, not a cordis service (see
     * `sidebar-terminal/client.js` for the same read), and a page whose module
     * table lacks it must still get the section — with the font-size control
     * degraded to the native `<select>` fallback — rather than the plugin failing
     * to load at all.
     */
    var Menu = null
    var Tooltip = null
    try {
      var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives && typeof primitives.Menu === 'function') Menu = primitives.Menu
      if (primitives && typeof primitives.Tooltip === 'function') Tooltip = primitives.Tooltip
    } catch (error) {
      // Logged rather than swallowed: a silent fallback would look like a styling
      // choice, when it means the selector's menu has degraded to the native list.
      console.warn('desktop-appearance: UI primitives unavailable: ' + String(error))
    }

    /** `createElement` shorthand; no JSX is available in a hand-built bundle. */
    var h = React.createElement

    /** Attach DSH's Tooltip to upstream-owned rows without replacing their DOM
     * or handlers. The native component owns the bubble, delay and positioning. */
    function createTriggerMenuTooltips() {
      var selector = '[data-trigger-menu] [role="option"]'
      var Anchor = React.forwardRef(function Anchor(props, ref) {
        var row = props.row
        var handlers = React.useRef(props)
        handlers.current = props
        React.useLayoutEffect(function () {
          ref(row)
          var events = { mouseenter: 'onMouseEnter', mouseleave: 'onMouseLeave', click: 'onClick', focus: 'onFocus', blur: 'onBlur' }
          var listeners = Object.entries(events).map(function (entry) {
            var listener = function (event) { handlers.current[entry[1]]?.(event) }
            row.addEventListener(entry[0], listener)
            return function () { row.removeEventListener(entry[0], listener) }
          })
          // A menu can finish mounting while the pointer is already over a row.
          if (row.matches(':hover')) handlers.current.onMouseEnter?.()
          return function () { listeners.forEach(function (off) { off() }); ref(null) }
        }, [row, ref])
        return null
      })

      return function TriggerMenuTooltips() {
        var state = React.useState([]), rows = state[0], setRows = state[1]
        React.useEffect(function () {
          var keys = new WeakMap(), nextKey = 0
          function sync() {
            var next = document.documentElement.getAttribute('data-dsh-ui') === 'vanilla' ? [] :
              Array.from(document.querySelectorAll(selector)).filter(function (row) {
                return !row.closest('[data-dsh-ghost]') && !row.hasAttribute('title') && !row.hasAttribute('aria-describedby')
              }).map(function (row) {
                if (!keys.has(row)) keys.set(row, ++nextKey)
                var label = Array.from(row.querySelectorAll('[class*="_itemName"], [class*="_itemAlias"], [class*="_itemDescription"]'))
                  .map(function (node) { return node.textContent.trim() }).filter(Boolean).join('\n')
                return { row: row, key: keys.get(row), label: label }
              }).filter(function (entry) { return entry.label })
            setRows(function (previous) {
              return previous.length === next.length && previous.every(function (entry, i) {
                return entry.row === next[i].row && entry.label === next[i].label
              }) ? previous : next
            })
          }
          var observer = new MutationObserver(function (records) {
            if (records.some(function (record) {
              var target = record.target.nodeType === 1 ? record.target : record.target.parentElement
              if (target?.closest('[data-trigger-menu]')) return true
              return Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(function (node) {
                return node.nodeType === 1 && (node.matches('[data-trigger-menu]') || node.querySelector('[data-trigger-menu]'))
              })
            })) sync()
          })
          observer.observe(document.body, { childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ['data-dsh-ghost', 'title', 'aria-describedby'] })
          document.addEventListener('dsh-desktop:ui-mode', sync)
          sync()
          return function () { observer.disconnect(); document.removeEventListener('dsh-desktop:ui-mode', sync) }
        }, [])
        return h(React.Fragment, null, rows.map(function (entry) {
          return h(Tooltip, { key: entry.key, label: entry.label, portal: true, side: 'top', delayMs: 500, focusDelayMs: 500 },
            h(Anchor, { row: entry.row }))
        }))
      }
    }

    /** Settings services differ across DSH versions and are acquired in apply. */
    var inject = ['slots', 'theme']

    /**
     * The font-size choices the select offers, in px.
     *
     * The range is wider than the theme runtime's own on both ends — see
     * {@link FONT_NATIVE_MIN} — which is why this plugin, not the runtime, owns
     * the two ends of it.
     */
    var FONT_MIN = 10
    var FONT_MAX = 18

    /**
     * The bounds the legacy `theme.setFontSize(px)` accepts.
     *
     * The runtime throws outside 12..17 — its guard and the `ui-theme` schema
     * (`Schema.number().step(1).min(12).max(17)`) agree on the pair — so a choice
     * below the floor or above the ceiling cannot be routed through it. Those
     * choices are applied by this plugin directly to the CSS variable the app's
     * own presenter writes, and persisted in this plugin's settings namespace;
     * see {@link isFontSizeOverride}.
     */
    var FONT_NATIVE_MIN = 12
    var FONT_NATIVE_MAX = 17

    /** The fallback when neither the runtime nor an override names a size. */
    var FONT_DEFAULT = 14

    /** New runtimes expose content size as fontSizes.text; older ones use fontSize. */
    function readThemeFontSize(snapshot) {
      var value = snapshot && (snapshot.fontSizes ? snapshot.fontSizes.text : snapshot.fontSize)
      return Number.isFinite(value) && value > 0 ? value : FONT_DEFAULT
    }

    /**
     * The body variable carrying the user's content font size.
     *
     * The app's ThemePresenter writes it from every theme snapshot it applies
     * (`body.style.setProperty('--dsh-content-font-size', …)`), and every content
     * surface reads it (`var(--dsh-content-font-size, 14px)`), so writing it here
     * is exactly the application path the app itself uses — which is what makes
     * an out-of-bounds choice indistinguishable from a native one once written.
     */
    var CONTENT_FONT_SIZE_VARIABLE = '--dsh-content-font-size'

    /**
     * Whether a size must bypass the theme runtime and be applied by this plugin.
     *
     * True exactly for the integer choices inside {@link FONT_MIN}..{@link
     * FONT_MAX} that fall outside the runtime's own 12..17 — 10, 11, and 18 today.
     *
     * @param px - the candidate size.
     * @returns whether {@link writeContentFontSize}, not `theme.setFontSize`, owns it.
     */
    function isFontSizeOverride(px) {
      return (
        Number.isInteger(px) &&
        px >= FONT_MIN &&
        px <= FONT_MAX &&
        (px < FONT_NATIVE_MIN || px > FONT_NATIVE_MAX)
      )
    }

    /**
     * The `<html>` attribute carrying the live UI mode.
     *
     * This is the single value the CSS tier (`ui-overlay/theme.css`) and the DOM
     * tier (`ui-overlay/dom.js`) both read, so it is the one thing that has to
     * agree across all three files. The host half of the overlay
     * (`desktop-ui.mjs`) publishes it before first paint; this plugin owns it
     * afterwards.
     */
    var MODE_ATTRIBUTE = 'data-dsh-ui'

    /** The value meaning "the unmodified frontend". */
    var VANILLA = 'vanilla'

    /** The value meaning "apply this app's overlay". */
    var DESKTOP = 'desktop'

    /**
     * Event naming a mode the user asked for. Detail: `{ mode }`.
     *
     * Dispatched on `document` by the title bar's 更多 menu. Two independent
     * listeners care, and neither may depend on the other:
     *
     *   - this plugin, which persists the choice in the settings document, and
     *   - `ui-overlay/dom.js`, which re-runs its pass at once rather than waiting
     *     for its 2s steady-state poll.
     *
     * A document event rather than a shared service because the two consumers
     * live in different worlds: the title bar is a client plugin, and the DOM
     * tier is an injected classic script with no access to cordis at all.
     */
    var REQUEST_EVENT = 'dsh-desktop:set-ui-mode'

    /**
     * Event announcing a mode that was applied. Detail: `{ mode }`.
     *
     * Dispatched by this plugin — the persistence owner — whenever the mode
     * changes, from any cause: the startup read, a write from the settings
     * document, or a handled {@link REQUEST_EVENT}. The title bar listens so its
     * menu label follows, and `dom.js` listens so it can re-pass immediately.
     */
    var CHANGE_EVENT = 'dsh-desktop:ui-mode'

    /**
     * Theme options, with the OS-following choice first.
     *
     * Order is a deliberate departure from the app's own row, which lists
     * Light, Dark, System.
     */
    var THEME_OPTIONS = [
      { id: 'system', get label() { return t('跟随系统') } },
      { id: 'light', get label() { return t('浅色') } },
      { id: 'dark', get label() { return t('深色') } },
    ]

    var COLOR_SCHEME_ATTRIBUTE = 'data-dsh-color-scheme'
    var COLOR_SCHEME_OPTIONS = [
      { id: 'default', get label() { return t('默认') }, swatch: '#4176E6' },
      { id: 'blue', get label() { return t('经典蓝') }, swatch: '#3F5D9C' },
      { id: 'teal', get label() { return t('雾海青') }, swatch: '#31675D' },
      { id: 'moss', get label() { return t('苔原绿') }, swatch: '#4E6544' },
      { id: 'violet', get label() { return t('暮光紫') }, swatch: '#6B5681' },
      { id: 'amber', get label() { return t('纸墨琥珀') }, swatch: '#765D3A' },
      { id: 'rose', get label() { return t('玫瑰灰') }, swatch: '#845665' },
    ]
    function colorScheme(value) {
      return COLOR_SCHEME_OPTIONS.some(function (option) { return option.id === value }) ? value : 'default'
    }
    function applyColorScheme(value) {
      document.documentElement.setAttribute(COLOR_SCHEME_ATTRIBUTE, colorScheme(value))
    }

    /** The animation preference this overlay owns. */
    var ANIMATION_OPTIONS = [
      { id: 'system', get label() { return t('跟随系统') } },
      { id: 'on', get label() { return t('开启') } },
      { id: 'off', get label() { return t('关闭') } },
    ]

    var REASONING_CONTROL_OPTIONS = [
      { id: 'select', get label() { return t('选择列表') } },
      { id: 'slider', get label() { return t('滑块') } },
    ]
    function reasoningControl(section) { return section?.reasoningControl === 'slider' ? 'slider' : 'select' }

    // Replace the root menu's effort row with an inline panel. Read and write
    // through the same session directory as the original model picker.
    function installReasoningMenu(store, ctx) {
      if (typeof MutationObserver === 'undefined') return function () {}
      var entry = null, disposed = false, frame = 0, directory = null, offDirectory = function () {}
      var triggerSelector = '[data-slot="conversation.input.model"] button[aria-expanded="true"][aria-controls]'
      function activeSessionId() {
        var list = ctx.sessions.list.getSnapshot()
        if (list.current != null) return list.current
        return Object.keys(list.byId || {}).find(function (id) { return (list.byId[id].retainedBy?.mainView || 0) > 0 })
      }
      function modelState() {
        var sessionId = activeSessionId()
        if (!sessionId || ctx.sessions.subagentAddress?.(sessionId) !== undefined) return null
        var owner = ctx.modelDirectories.directoryFor(sessionId)
        var state = owner.store.getSnapshot(), selection = state.current
        if (!selection) return null
        var group = state.groups.find(function (group) { return group.id === selection.provider })
        var model = group?.models.find(function (model) { return model.id === selection.model })
        if (!model?.reasoning) return null
        var reasoning = model.reasoning
        var options = reasoning.efforts.map(function (level) { return { id: level.id, name: level.name } })
        if (reasoning.defaultEffort === undefined) options.unshift({ id: undefined, name: t('提供商默认') })
        var effective = selection.reasoningEffort ?? reasoning.defaultEffort
        return { owner: owner, sessionId: sessionId, selection: selection, options: options,
          selected: options.findIndex(function (option) { return option.id === effective }),
          // Like the native effort rows, a background catalog refresh must not
          // discard a drag while the current model's known levels remain valid.
          busy: state.pending !== null }
      }
      function watchDirectory(next) {
        if (directory === next) return
        offDirectory()
        directory = next
        offDirectory = next ? next.store.subscribe(schedule) : function () {}
      }
      function element(tag, className, text) {
        var node = document.createElement(tag)
        if (className) node.className = className
        if (text !== undefined) node.textContent = text
        return node
      }
      function clear() {
        if (!entry) return
        var previous = entry
        entry = null
        previous.menu.removeEventListener('focusin', previous.onFocus)
        previous.menu.removeEventListener('keydown', previous.onKeyDown, true)
        previous.menu.removeAttribute('data-dsh-reasoning-slider')
        previous.effortRow.removeAttribute('data-dsh-reasoning-row')
        previous.modelRow.removeAttribute('data-dsh-reasoning-model')
        previous.modelRow.setAttribute('role', 'menuitem')
        if (!previous.menu.querySelector(':scope > [role="menu"]')) previous.menu.setAttribute('role', previous.role)
        if (previous.root.contains(document.activeElement) && previous.effortRow.isConnected) {
          previous.effortRow.focus({ preventScroll: true })
        }
        previous.root.remove()
        if (previous.menu.isConnected) previous.menu.dispatchEvent(new Event('scroll'))
      }
      function attach(menu, trigger, rows) {
        clear()
        var root = element('div', 'dshReasoning')
        root.setAttribute('role', 'group')
        var heading = element('div', 'dshReasoning__heading')
        var title = element('span', 'dshReasoning__title', t('推理等级'))
        var value = element('output', 'dshReasoning__value')
        var track = element('div', 'dshReasoning__track')
        track.setAttribute('aria-hidden', 'true')
        var range = element('div', 'dshReasoning__range')
        var thumb = element('div', 'dshReasoning__thumb')
        thumb.setAttribute('aria-hidden', 'true')
        var input = element('input')
        input.type = 'range'
        input.min = '0'
        input.step = '1'
        input.setAttribute('aria-label', t('推理等级'))
        input.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home End')
        var labels = element('div', 'dshReasoning__labels')
        labels.setAttribute('aria-hidden', 'true')
        var error = element('p', 'dshReasoning__error')
        error.setAttribute('role', 'alert')
        error.hidden = true
        heading.append(title, value)
        range.append(track, input, thumb)
        root.append(heading, range, labels, error)
        menu.append(root)
        entry = { menu: menu, trigger: trigger, root: root, modelRow: rows[0], effortRow: rows[1],
          input: input, value: value, title: title, error: error,
          track: track, labels: labels, selected: -1, signature: '', editing: false, saving: false,
          role: menu.getAttribute('role') || 'menu' }
        var current = entry
        function preview() {
          var index = Number(input.value)
          var name = current.options[index]?.name || ''
          if (value.textContent !== name) {
            var text = element('span', 'dshReasoning__valueText', name)
            if (current.previewIndex !== undefined) {
              text.setAttribute('data-changing', '')
              text.style.setProperty('--dsh-reasoning-value-offset', index < current.previewIndex ? '-6px' : '6px')
            }
            value.replaceChildren(text)
          }
          current.previewIndex = index
          input.setAttribute('aria-valuetext', name)
          // Match the native 28px thumb's center, including both endpoints.
          var progress = index / Math.max(1, current.options.length - 1)
          root.style.setProperty('--dsh-reasoning-position', String(progress))
          root.style.setProperty('--dsh-reasoning-progress', 'calc(' + (progress * 100) + '% + ' + (14 - 28 * progress) + 'px)')
          Array.from(track.children).forEach(function (tick, i) { tick.dataset.filled = i <= index ? 'true' : 'false' })
          Array.from(labels.children).forEach(function (label, i) { label.dataset.selected = i === index ? 'true' : 'false' })
        }
        current.preview = preview
        function beginEditing(event) {
          // A save can settle before its scheduled paint. Start from the live
          // selection so that paint cannot mistake a new drag for stale input.
          var latest = modelState()
          if (!latest || latest.owner !== current.owner || latest.busy || current.saving
            || latest.selection.provider !== current.selection.provider || latest.selection.model !== current.selection.model) {
            event.preventDefault()
            schedule()
            return false
          }
          current.selected = latest.selected
          current.busy = false
          current.editing = true
          return true
        }
        async function commit() {
          current.editing = false
          root.removeAttribute('data-dragging')
          if (entry !== current || input.disabled || current.saving) return
          var latest = modelState(), option = current.options[Number(input.value)]
          if (!latest || latest.owner !== current.owner || latest.busy || !option
            || latest.selection.provider !== current.selection.provider || latest.selection.model !== current.selection.model
            || !latest.options.some(function (item) { return item.id === option.id })) { schedule(); return }
          if (latest.options[latest.selected]?.id === option.id) return
          current.saving = true
          current.error.hidden = true
          root.setAttribute('aria-busy', 'true')
          input.setAttribute('aria-disabled', 'true')
          try {
            var selection = { provider: latest.selection.provider, model: latest.selection.model }
            if (option.id !== undefined) selection.reasoningEffort = option.id
            var result = await latest.owner.select(selection)
            if (!result?.ok) throw new Error(result?.error?.message || 'Reasoning selection refused')
          } catch (error) {
            if (entry === current) {
              current.error.textContent = t('推理等级保存失败，请重试。')
              current.error.hidden = false
            }
          } finally {
            current.saving = false
            schedule()
          }
        }
        input.addEventListener('pointerdown', function (event) {
          if (!beginEditing(event)) return
          root.setAttribute('data-dragging', '')
          input.setPointerCapture(event.pointerId)
        })
        input.addEventListener('input', preview)
        // Native change fires once on pointer release; keyboard commits on keyup.
        input.addEventListener('change', function () { if (!current.editing) commit() })
        input.addEventListener('pointerup', commit)
        input.addEventListener('pointercancel', function () {
          current.editing = false
          root.removeAttribute('data-dragging')
          input.value = String(current.selected)
          preview()
        })
        input.addEventListener('keydown', function (event) {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            event.stopPropagation()
            beginEditing(event)
          } else if (event.key === 'Escape') {
            current.editing = false
          } else if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation(); commit()
          }
        })
        input.addEventListener('keyup', function () { if (current.editing) commit() })
        input.addEventListener('blur', function () { if (current.editing) commit() })
        current.onFocus = function (event) {
          if (event.target === current.effortRow && !input.disabled) input.focus({ preventScroll: true })
        }
        current.onKeyDown = function (event) {
          if (event.target === current.modelRow && ['Tab', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); input.focus({ preventScroll: true })
          } else if (event.target === input && event.key === 'Tab') {
            event.preventDefault(); event.stopPropagation()
            if (event.shiftKey) current.modelRow.focus({ preventScroll: true })
            else trigger.click()
          }
        }
        menu.addEventListener('keydown', current.onKeyDown, true)
        menu.addEventListener('focusin', current.onFocus)
        current.effortRow.setAttribute('data-dsh-reasoning-row', '')
        current.modelRow.setAttribute('data-dsh-reasoning-model', '')
        current.modelRow.setAttribute('role', 'button')
        menu.setAttribute('data-dsh-reasoning-slider', '')
        menu.setAttribute('role', 'group')
      }
      function sync() {
        frame = 0
        if (disposed) return
        var state = store.getState()
        if (state.ui === VANILLA || state.reasoningControl !== 'slider') { clear(); watchDirectory(null); return }
        var trigger = document.querySelector(triggerSelector)
        var menu = trigger && document.getElementById(trigger.getAttribute('aria-controls'))
        var rows = menu && !menu.closest('[data-dsh-ghost]') ? Array.from(menu.querySelectorAll(':scope > button[role="menuitem"], :scope > button[data-dsh-reasoning-model]')) : []
        var model = menu && rows.length === 2 ? modelState() : null
        watchDirectory(model?.owner || null)
        // Keep the native list for unknown selections or unsupported upstream
        // shapes; the model submenu is left entirely to the original picker.
        if (!model || model.selected < 0 || !model.options.length) { clear(); return }
        if (!entry || entry.menu !== menu || entry.effortRow !== rows[1] || entry.owner !== model.owner) attach(menu, trigger, rows)
        var current = entry
        var signature = JSON.stringify([model.selection.provider, model.selection.model, model.options])
        if (signature !== current.signature) {
          current.editing = false
          current.signature = signature
          current.error.hidden = true
          current.track.replaceChildren()
          current.labels.replaceChildren()
          model.options.forEach(function (option, i) {
            var tick = element('span', 'dshReasoning__tick')
            var progress = i / Math.max(1, model.options.length - 1)
            tick.style.left = 'calc(' + (progress * 100) + '% + ' + (14 - 28 * progress) + 'px)'
            current.track.append(tick)
            current.labels.append(element('span', '', option.name))
          })
        }
        if (current.selected !== model.selected) current.editing = false
        current.owner = model.owner
        current.options = model.options
        current.selection = model.selection
        current.busy = model.busy
        current.title.textContent = t('推理等级')
        current.root.setAttribute('aria-label', t('推理等级'))
        current.input.setAttribute('aria-label', t('推理等级'))
        current.selected = model.selected
        current.input.max = String(Math.max(1, model.options.length - 1))
        current.input.disabled = trigger.disabled || model.options.length < 2
        current.input.setAttribute('aria-disabled', String(current.input.disabled || model.busy || current.saving))
        current.root.setAttribute('aria-busy', String(model.busy || current.saving))
        if (!current.editing && !current.saving) current.input.value = String(model.selected)
        current.preview()
        // Upstream positioning measures the native list before we adapt it.
        // Its capturing scroll listener remeasures this menu after the swap.
        var measure = signature + current.error.hidden
        if (current.measured !== measure) {
          current.measured = measure
          menu.dispatchEvent(new Event('scroll'))
        }
      }
      function schedule() {
        if (!disposed && !frame) frame = requestAnimationFrame(sync)
      }
      var observer = new MutationObserver(function (records) {
        if (records.some(function (record) {
          var target = record.target.nodeType === 1 ? record.target : record.target.parentElement
          if (target?.closest('.dshReasoning')) return false
          if (target?.closest('[data-slot="conversation.input.model"]')) return true
          if (target === entry?.menu && record.type === 'childList') return true
          return Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(function (node) {
            return node.nodeType === 1 && (node === entry?.menu || node.matches('[role="menu"], [role="menuitemradio"]') || node.querySelector('[role="menu"]'))
          })
        })) schedule()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['aria-expanded', 'aria-controls', 'aria-checked', 'aria-label', 'disabled'] })
      var off = store.subscribe(schedule)
      var offSessions = ctx.sessions.list.subscribe(schedule)
      schedule()
      return function () { disposed = true; observer.disconnect(); off(); offSessions(); offDirectory(); cancelAnimationFrame(frame); clear() }
    }

    var COMPOSER_MATERIAL_ATTRIBUTE = 'data-dsh-composer-material'
    var COMPOSER_MATERIAL_OPTIONS = [
      { id: 'glass', get label() { return t('毛玻璃') } },
      { id: 'frosted', get label() { return t('纯磨砂') } },
      { id: 'transparent', get label() { return t('透明') } },
      { id: 'opaque', get label() { return t('不透明') } },
    ]
    var COMPOSER_MATERIAL_NOTES = {
      get glass() { return t('模糊背景，搭配柔和高光与阴影，呈现玻璃质感。') },
      get frosted() { return t('只模糊背景，保留平面磨砂质感，没有立体高光或阴影。') },
      get transparent() { return t('调节底色透明度，不添加模糊效果；文字和按钮保持清晰。') },
      get opaque() { return t('使用主题纯色底板，完整遮住后方的背景。') },
    }
    function composerMaterial(value) {
      return COMPOSER_MATERIAL_OPTIONS.some(function (option) { return option.id === value }) ? value : 'opaque'
    }
    var COMPOSER_TUNING = {
      transparent: { field: 'composerTransparency', get label() { return t('底色透明度') }, defaultValue: 20, variable: '--dsh-composer-transparent-tint' },
      frosted: { field: 'composerFrostedIntensity', get label() { return t('纯磨砂效果程度') }, defaultValue: 50, variable: '--dsh-composer-frosted-strength' },
      glass: { field: 'composerGlassIntensity', get label() { return t('毛玻璃效果程度') }, defaultValue: 50, variable: '--dsh-composer-glass-strength' },
    }
    var DIALOG_TUNING = {
      transparent: { field: 'dialogTransparency', get label() { return t('底色透明度') }, defaultValue: 20, variable: '--dsh-dialog-transparent-tint' },
      frosted: { field: 'dialogFrostedIntensity', get label() { return t('纯磨砂效果程度') }, defaultValue: 50, variable: '--dsh-dialog-frosted-strength' },
      glass: { field: 'dialogGlassIntensity', get label() { return t('毛玻璃效果程度') }, defaultValue: 50, variable: '--dsh-dialog-glass-strength' },
    }
    var MATERIAL_SURFACES = [
      { field: 'composerMaterial', attribute: COMPOSER_MATERIAL_ATTRIBUTE, tuning: COMPOSER_TUNING,
        get error() { return t('输入框/面板效果设置保存失败，请重试。') } },
      { field: 'dialogMaterial', attribute: 'data-dsh-dialog-material', tuning: DIALOG_TUNING,
        get error() { return t('Dialog 效果设置保存失败，请重试。') } },
    ]
    function materialSurface(field) {
      return MATERIAL_SURFACES.find(function (surface) {
        return surface.field === field || Object.values(surface.tuning).some(function (control) { return control.field === field })
      })
    }
    function validComposerSetting(field, value) {
      var surface = materialSurface(field)
      if (!surface) return false
      if (field === surface.field) return composerMaterial(value) === value
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    }
    function composerSettings(section) {
      var result = {}
      MATERIAL_SURFACES.forEach(function (surface) {
        result[surface.field] = composerMaterial(section && section[surface.field])
        Object.values(surface.tuning).forEach(function (control) {
          var value = section && section[control.field]
          result[control.field] = validComposerSetting(control.field, value) ? value : control.defaultValue
        })
      })
      return result
    }
    function ComposerMaterialSlider(props) {
      var surface = props.surface || MATERIAL_SURFACES[0]
      var material = props.state[surface.field]
      var control = surface.tuning[material]
      if (!control) return null
      var value = props.state[control.field]
      function save(event) { return props.save(control.field, Number(event.target.value)) }
      return h('div', { className: 'dshAppearance__materialTuning' },
        h('label', { className: 'dshAppearance__materialSlider' },
          h('span', null, control.label),
          h('input', { type: 'range', min: 0, max: 100, step: 1, value: value,
            'aria-label': control.label, 'aria-valuetext': value + '%',
            onChange: function (event) { props.preview(control.field, Number(event.target.value)) },
            onPointerUp: save, onPointerCancel: save, onKeyUp: save, onBlur: save }),
          h('output', { 'aria-live': 'off' }, value + '%')),
        h('p', null, material === 'transparent'
          ? t('数值越高，底色越透明；100% 完全透出背景。')
          : t('程度越高，背景越模糊，底色透明度同步降低；0% 完全透出背景。')))
    }

    /**
     * A tiny external store, the same shape the app's rows receive from a slot.
     *
     * Kept local rather than supplied through the slot's `store` option because
     * the theme and animation values live in two different places: the theme
     * comes from `ctx.theme`, the animation from this plugin's own settings
     * namespace. One store over both keeps the component a pure projection.
     *
     * @param initial - the first state.
     * @returns the store handle: `getState`, `update`, `subscribe`.
     */
    function createStore(initial) {
      var state = initial
      var listeners = []

      /**
       * Merge a partial state, notifying only when a field actually changed.
       *
       * The merge rule matters more here than it looks. Callers update one field
       * while preserving the rest, so every handler would otherwise allocate a
       * fresh object — and `setState`'s identity check would then see a change on
       * every settings event, re-rendering the section and, with the UI mode as a
       * field, potentially re-running the mode application. Comparing per field
       * keeps "nothing changed" from looking like a change.
       *
       * @param patch - the fields to replace.
       */
      function update(patch) {
        var changed = false
        var next = {}
        for (var key in state) {
          if (!Object.prototype.hasOwnProperty.call(state, key)) continue
          next[key] = Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : state[key]
          if (next[key] !== state[key]) changed = true
        }
        if (!changed) return
        state = next
        for (var i = 0; i < listeners.length; i += 1) listeners[i]()
      }

      return {
        getState: function () {
          return state
        },
        update: update,
        subscribe: function (listener) {
          listeners.push(listener)
          return function () {
            var at = listeners.indexOf(listener)
            if (at !== -1) listeners.splice(at, 1)
          }
        },
      }
    }

    /**
     * Apply the animation preference to the document.
     *
     * The overlay stylesheet keys off this attribute, so the setting takes effect
     * immediately and covers every element that stylesheet targets.
     *
     * @param preference - `system`, `on`, or `off`.
     */
    function applyAnimation(preference) {
      var root = document.documentElement
      if (preference === 'system') {
        // Absent means "follow the OS", which is what the stylesheet's media
        // query expects. Removing it keeps that single meaning.
        root.removeAttribute('data-dsh-desktop-animation')
        return
      }
      root.setAttribute('data-dsh-desktop-animation', preference)
    }





    /**
     * Write one content font size to the document, the way the app's presenter
     * does.
     *
     * Never throws: a page without a `body` (headless runs, the mode test's DOM
     * stub) or one whose style object is missing is skipped, and a rejecting
     * engine is contained — a font size that fails to apply degrades to the
     * previous size, never to a broken plugin.
     *
     * @param px - the size to write, in px.
     */
    function writeContentFontSize(px) {
      var body = document.body
      if (!body || !body.style || typeof body.style.setProperty !== 'function') return
      try {
        body.style.setProperty(CONTENT_FONT_SIZE_VARIABLE, px + 'px')
      } catch (error) {
        /* A page that refuses the write keeps its current size. */
      }
    }

    /**
     * Apply the UI mode to the document.
     *
     * The attribute is left on `<html>` in BOTH modes rather than being removed
     * for `desktop`. The stylesheet's gate is `html:not([data-dsh-ui='vanilla'])`,
     * so an absent attribute already behaves as `desktop` — but writing it
     * explicitly means the page states which mode it is in, which is what the
     * host half publishes before first paint and what makes the two halves
     * diffable when something looks wrong.
     *
     * @param mode - `desktop` or `vanilla`.
     */
    function applyUiMode(mode) {
      var next = mode === VANILLA ? VANILLA : DESKTOP
      var root = document.documentElement
      if (root.getAttribute(MODE_ATTRIBUTE) !== next) {
        root.setAttribute(MODE_ATTRIBUTE, next)
      }
      return next
    }



    /**
     * Announce an applied mode.
     *
     * Never throws: a listener is third-party code from this plugin's point of
     * view, and a throwing one must not abort the settings write that follows.
     *
     * @param mode - the mode now in effect.
     */
    function announceUiMode(mode) {
      try {
        document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { mode: mode } }))
      } catch (error) {
        // No logger is reachable from a module-scope helper; the failure is
        // cosmetic (a stale menu label) and the next pass corrects it.
      }
    }

    /**
     * One labelled group of mutually exclusive options.
     *
     * Rendered as real buttons carrying `aria-pressed`, so the state is exposed
     * to assistive technology and the control is keyboard reachable — the same
     * semantics the app's own appearance cubes use.
     *
     * @param props - title, note, options, value, change handler, and `compact`.
     * @returns the group element.
     */
    function OptionGroup(props) {
      var selected = props.value
      var compact = props.compact === true

      var buttons = props.options.map(function (option) {
        var isSelected = option.id === selected
        return h(
          'button',
          {
            key: option.id,
            type: 'button',
            // The overlay's own hook. The button is styled inline here, so the
            // stylesheet cannot key on a CSS-module hash the way it does for the
            // app's components — and inline styles win over a stylesheet rule, so
            // `theme.css` must reach the hover state through a class it owns. This
            // is that class; it is deliberately not an app class name, so the rule
            // in `theme.css` can never collide with a component's own styling.
            className: 'dshAppearance__option',
            'data-color-scheme': props.colorSchemes ? option.id : undefined,
            'aria-pressed': isSelected ? 'true' : 'false',
            onClick: function () {
              props.onChange(option.id)
            },
            style: {
              boxSizing: 'border-box',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '14px',
              lineHeight: '22px',
              color: 'var(--dsw-alias-label-primary)',
              background: isSelected ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
              border: isSelected && props.colorSchemes ? '1px solid var(--dsw-alias-link)' : isSelected
                ? '1px solid var(--dsw-alias-border-l4)'
                : '0.5px solid var(--dsw-alias-border-l4)',
              borderRadius: '12px',
              // Compact rows are shorter than the theme cubes, as requested,
              // while keeping the same width behaviour so the groups align.
              padding: compact ? '8px 20px' : '14px 24px',
              minWidth: '88px',
              flex: '0 0 auto',
            },
          },
          option.swatch ? h('span', { 'aria-hidden': 'true', style: { display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', background: option.swatch, marginRight: '8px', verticalAlign: 'middle' } }) : null,
          option.label,
        )
      })

      return h(
        'div',
        {
          role: 'group',
          'aria-label': props.title,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '16px 0',
            borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h(
            'div',
            {
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '14px',
                lineHeight: '22px',
              },
            },
            props.title,
          ),
          props.note
            ? h(
                'div',
                {
                  style: {
                    color: 'var(--dsw-alias-label-tertiary)',
                    fontSize: '12px',
                    lineHeight: '18px',
                  },
                },
                props.note,
              )
            : null,
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: '8px' } },
          buttons,
        ),
        props.control,
      )
    }

    /**
     * The font-size control: the app's own selector, offering every size the row
     * supports.
     *
     * THE SHAPE IS 通用设置'S OWN SELECTOR, not a form field. The app renders a
     * settings row's value selector as the `Menu` primitive wrapping a pill
     * button — a button with `background: var(--dsw-alias-bg-module-platform)`,
     * `height: 36px`, `border: none`, `border-radius: 18px`, `padding: 0 14px` at
     * `font-size: 14px`/`line-height: 22px` — and that rule appears verbatim in
     * `dsh-client-ui-permission-presets`, `-locale`, `-theme` and `-chat`, so it is
     * the app's shared selector idiom rather than one row's private styling. The
     * popup is the Menu primitive, so what opens here is the same menu every other
     * selector in the window opens — the current value check-marked — rather than
     * the engine's native list, which is what made this control stand apart from
     * 通用设置's.
     *
     * THE ROW ITSELF IS 通用设置'S SETTING-CELL TOO. The app lays a settings row
     * out as one horizontal flex — title and description in a left text column,
     * the value selector on the right, a hairline under the row — and this row
     * now does the same, where it used to stack the selector under the text and
     * read as a form field between rows that keep their control to the right.
     *
     * THE CLOSED CONTROL IS A `<button>`, AND THAT IS WHAT FIXES THE FOCUS RING.
     * This used to be a native `<select>`, and WebView2 matches `:focus-visible`
     * on a `<select>` even for a plain mouse click, so every click drew the thick
     * keyboard ring. A button only matches `:focus-visible` from the keyboard, so
     * a click draws nothing — the behaviour the app's own pill already shows.
     *
     * Styled inline like the option buttons, so `theme.css` reaches its hover
     * state through the `dshAppearance__selector` class for the same reason.
     *
     * THE RANGE STAYS WHOLE. The point of this control is to show all of 10..18 at
     * once — including the three sizes the theme runtime refuses and this plugin
     * applies itself — and a menu of nine items shows them as well as a select
     * ever did, with the current one marked.
     *
     * DEGRADED PATH. Without the primitives module the Menu is unavailable, and the
     * control falls back to the native `<select>` it used to be — same pill, same
     * values, the engine's own popup list.
     *
     * @param props - current size in px and the change handler.
     * @returns the row element.
     */
    function FontSizeRow(props) {
      var value = props.value

      var options = []
      for (var px = FONT_MIN; px <= FONT_MAX; px += 1) options.push(px)

      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var triggerRef = React.useRef(null)

      /**
       * Close the menu and put focus back on the pill.
       *
       * The Menu closes itself on an outside pointer-down and on Escape, but it
       * does NOT close on a selection — every one of the app's own selectors
       * closes in its own `onSelect` — and after Escape the item that had focus
       * unmounts with the menu. Refocusing the trigger covers both, and is what
       * keeps a keyboard user on the control they were using.
       */
      var dismiss = function () {
        setOpen(false)
        if (triggerRef.current && typeof triggerRef.current.focus === 'function') triggerRef.current.focus()
      }

      // WEARS 通用设置'S OWN SELECTOR, down to the numbers — see the header
      // comment for where the rule comes from. The chevron is drawn as a
      // background image using the app's own 12x12 path and stroke colour, the
      // same technique `settings-models` uses for its `selectInput`, so the pill
      // reads finished in both paths.
      //
      // THE ROW IS A ROW FLEX NOW, so the pill needs no anti-stretch patch: the
      // app's Setting-Cell is a horizontal flex whose text column carries
      // `flex: 1` and `minWidth: 0`, which is what keeps this control
      // intrinsic-width and right-placed — the `align-self` the old column
      // layout needed is gone with that layout.
      var pillStyle = {
        boxSizing: 'border-box',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-module-platform)',
        border: 'none',
        borderRadius: '18px',
        // The right padding clears the chevron: 14px inset + 12px glyph +
        // 8px of breathing room, matching the app's own `gap: 12px`
        // spacing between a label and its chevron.
        padding: '0 34px 0 14px',
        height: '36px',
        flex: '0 0 auto',
        appearance: 'none',
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 14px center',
        backgroundSize: '12px 12px',
      }

      var pill = h(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          className: 'dshAppearance__selector',
          'aria-label': t('字号大小'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: function () {
            setOpen(!open)
          },
          onKeyDown: function (event) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
            }
          },
          style: pillStyle,
        },
        value + 'px',
      )

      var control
      if (Menu) {
        control = h(
          'div',
          {
            // The Menu's span is the row's flex child on this path; keeping the
            // wrapper unsizable (`flex: 0 0 auto`) makes the pill's own width
            // the measurement, exactly as the bare pill is on the fallback.
            style: { flex: '0 0 auto' },
          },
          h(Menu, {
            open: open,
            onClose: dismiss,
            // The Menu does not close on selection — the app's own selectors close
            // in their own `onSelect` — so `dismiss` leads here too.
            onSelect: function (id) {
              dismiss()
              props.onChange(Number(id))
            },
            // 通用设置's selector passes the current id and nothing else: the
            // Menu's default `selection: 'check'` marks it, `align: 'start'` drops
            // the panel from the pill's left edge, and `portal: true` renders it
            // as the same surface every other dropdown uses.
            items: options.map(function (px) {
              return { id: String(px), label: px + 'px' }
            }),
            selectedId: String(value),
            portal: true,
            align: 'start',
            anchor: pill,
          }),
        )
      } else {
        control = h(
          'select',
          {
            'aria-label': t('字号大小'),
            className: 'dshAppearance__selector',
            value: String(value),
            onChange: function (event) {
              props.onChange(Number(event.target.value))
            },
            style: pillStyle,
          },
          options.map(function (px) {
            return h('option', { key: px, value: String(px) }, px + 'px')
          }),
        )
      }

      return h(
        'div',
        {
          style: {
            // THE APP'S SETTING-CELL, not a stacked field: title and note in a
            // left text column, the selector on the right of the same line, a
            // hairline under the row — the layout every 通用设置 row wears.
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '16px 0',
            borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
          },
        },
        h(
          'div',
          {
            // `flex: 1` hands the row's remaining width to the text and
            // `minWidth: 0` lets a long note wrap instead of shoving the pill;
            // without the pair the selector would drift to the text rather
            // than the row's right edge.
            style: { display: 'flex', flex: 1, flexDirection: 'column', gap: '2px', minWidth: 0 },
          },
          h(
            'div',
            {
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '14px',
                lineHeight: '22px',
              },
            },
            t('字号大小'),
          ),
          h(
            'div',
            {
              style: {
                color: 'var(--dsw-alias-label-tertiary)',
                fontSize: '12px',
                lineHeight: '18px',
              },
            },
            t('仅影响会话内容的字号'),
          ),
        ),
        control,
      )
    }

    /**
     * Build the section component bound to its dependencies.
     *
     * @param deps - the theme owner, the store, and the theme/animation/font-size
     *   setters the option rows call.
     * @returns a component taking only slot props.
     */
    var BACKGROUND_REGIONS = [['Navigation', t('标题栏与左边导航栏')], ['Right', t('侧边栏区域')], ['Chat', t('中间会话区域')]]
    var BACKGROUND_TARGETS = { Navigation: ['titlebar', 'left'], Right: ['right'], Chat: ['chat'] }
    function backgroundSettings(section) {
      var result = { backgroundImage: '', backgroundTransparency: 40, backgroundBlur: 0 }
      var surfaceDefaults = { Right: 15, Chat: 40 }
      BACKGROUND_REGIONS.forEach(function (region) {
        result['background' + region[0]] = true
        if (region[0] === 'Navigation') return
        var previous = section && section['background' + region[0] + 'Transparency']
        result['background' + region[0] + 'SurfaceTransparency'] = typeof previous === 'number' ? 100 - previous : surfaceDefaults[region[0]]
      })
      // Missing legacy switches were enabled. Keep the merged region enabled
      // whenever either old region was enabled; the shared field takes priority.
      result.backgroundNavigation = !section || section.backgroundTitlebar !== false || section.backgroundLeft !== false
      // Prefer the sidebar's saved tint when migrating separate controls. Only
      // fall back to the title bar when the sidebar has no saved preference.
      result.backgroundNavigationSurfaceTransparency = 15
      if (section) {
        for (var region of ['Left', 'Titlebar']) {
          var surface = section['background' + region + 'SurfaceTransparency']
          var legacy = section['background' + region + 'Transparency']
          if (typeof surface === 'number' || typeof legacy === 'number') {
            result.backgroundNavigationSurfaceTransparency = typeof surface === 'number' ? surface : 100 - legacy
            break
          }
        }
      }
      Object.keys(result).forEach(function (key) {
        if (section && typeof section[key] === typeof result[key]) result[key] = section[key]
      })
      return result
    }

    function BackgroundSettings(props) {
      useLocale(React)
      var state = props.state
      var input = React.useRef(null)
      var selection = React.useRef(0)
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
      function slider(label, field, disabled) {
        return h('label', { className: 'dshAppearance__backgroundSlider' },
          h('span', null, label),
          h('input', { type: 'range', min: 0, max: 100, step: 1, value: state[field], disabled: disabled,
            'aria-label': label, onChange: function (event) { props.preview(field, Number(event.target.value)) },
            onPointerUp: function (event) { props.save(field, Number(event.target.value)) },
            onKeyUp: function (event) { props.save(field, Number(event.target.value)) },
            onBlur: function (event) { props.save(field, Number(event.target.value)) } }),
          h('output', null, state[field] + '%'))
      }
      async function choose(event) {
        var file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        var token = ++selection.current
        setBusy(true)
        props.error('')
        try {
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error(t('请选择 PNG、JPG、WebP 或 GIF 图片'))
          if (file.size > 5 * 1024 * 1024) throw new Error(t('图片不能超过 5 MB，请压缩后重试'))
          var data = await new Promise(function (resolve, reject) {
            var reader = new FileReader()
            reader.onload = function () { resolve(reader.result) }
            reader.onerror = function () { reject(new Error(t('无法读取图片，请重新选择'))) }
            reader.readAsDataURL(file)
          })
          await new Promise(function (resolve, reject) {
            var img = new Image()
            img.onload = resolve
            img.onerror = function () { reject(new Error(t('图片无法解码，请选择其他图片'))) }
            img.src = data
          })
          if (token === selection.current) props.save('backgroundImage', data)
        } catch (error) { if (token === selection.current) props.error(error.message) }
        finally { if (token === selection.current) setBusy(false) }
      }
      return h('section', { className: 'dshAppearance__background', 'aria-label': t('背景图片') },
        h('h3', null, t('背景图片')),
        h('p', null, t('从下到上依次为纯黑（深色）／纯白（浅色）、背景图片、界面底色。底色透明度越高，图片越清晰：0% 遮住图片，100% 完全透出图片。')),
        h('input', { ref: input, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: choose }),
        h('div', { className: 'dshAppearance__backgroundActions' },
          h('button', { type: 'button', disabled: busy, onClick: function () { input.current.click() } }, busy ? t('正在读取…') : state.backgroundImage ? t('更换图片') : t('选择图片')),
          h('button', { type: 'button', disabled: !state.backgroundImage && !busy, onClick: function () { selection.current++; setBusy(false); props.save('backgroundImage', '') } }, t('移除图片')),
          h('span', null, t('PNG / JPG / WebP / GIF，最大 5 MB'))),
        state.backgroundImage ? h('img', { className: 'dshAppearance__backgroundPreview', src: state.backgroundImage, alt: t('当前背景图片预览') }) : null,
        state.backgroundError ? h('p', { role: 'alert' }, state.backgroundError) : null,
        slider(t('图片总透明度'), 'backgroundTransparency', !state.backgroundImage),
        slider(t('图片模糊程度'), 'backgroundBlur', !state.backgroundImage),
        h('p', null, t('0% 保持原图清晰，100% 模糊最强。')),
        BACKGROUND_REGIONS.map(function (region) {
          var field = 'background' + region[0]
          var navigation = region[0] === 'Navigation'
          return h('div', { key: field, className: 'dshAppearance__backgroundRegion' },
            h('label', null, h('input', { type: 'checkbox', checked: state[field], disabled: !state.backgroundImage,
              onChange: function (event) { props.save(field, event.target.checked) } }), t('在{region}显示', { region: t(region[1]) })),
            slider(
              navigation ? t('标题栏与左边导航栏底色透明度') : t('{region}底色透明度', { region: t(region[1]) }),
              navigation ? 'backgroundNavigationSurfaceTransparency' : field + 'SurfaceTransparency',
              !state.backgroundImage || !state[field]))
        }))
    }

    function createSection(deps) {
      return function AppearanceSection() {
      useLocale(React)
        // The store is the single source the component projects. `useSyncExternalStore`
        // is the supported way to read an external store without tearing, and it
        // is what the app's own rows use through their slot store.
        var state = React.useSyncExternalStore(
          deps.store.subscribe,
          deps.store.getState,
          deps.store.getState,
        )

        return h(
          'div',
          {
            // The overlay's scope for this section's own controls. The section is
            // rendered by this plugin, so its class names are ours to choose — and
            // `theme.css` needs one stable hook for all three controls rather than
            // three separate rules keyed on inline styles.
            className: 'dshAppearance',
            style: {
              display: 'flex',
              flexDirection: 'column',
              padding: '0 0 8px',
              maxWidth: '640px',
            },
          },
          h(OptionGroup, {
            title: t('主题'),
            note: window.__DSH_REMOTE_THEME__
              ? t('主题选择仅保存在当前浏览器；跟随系统会随当前设备的外观自动切换')
              : t('选择界面配色；跟随系统会随 Windows 外观自动切换'),
            options: THEME_OPTIONS,
            value: state.preference,
            onChange: function (id) {
              deps.setTheme(id)
            },
          }),
          h(OptionGroup, {
            title: t('配色方案'),
            note: t('默认保留原有配色；其他方案以主题色区分侧边栏和标题栏，内容区域保持柔和的中性色，并随浅色或深色主题切换。'),
            options: COLOR_SCHEME_OPTIONS,
            value: state.colorScheme,
            onChange: deps.setColorScheme,
            compact: true,
            colorSchemes: true,
          }),
          state.colorSchemeError ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, state.colorSchemeError) : null,
          h(OptionGroup, {
            title: t('输入框/面板效果'),
            note: t('应用于输入框和账号面板。') + COMPOSER_MATERIAL_NOTES[state.composerMaterial],
            options: COMPOSER_MATERIAL_OPTIONS,
            value: state.composerMaterial,
            onChange: deps.setComposerMaterial,
            compact: true,
            control: h(ComposerMaterialSlider, { key: state.composerMaterial, state: state,
              preview: deps.previewComposerSetting, save: deps.saveComposerSetting }),
          }),
          state.composerMaterialError ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, state.composerMaterialError) : null,
          h(OptionGroup, {
            title: t('Dialog 效果'),
            note: t('独立应用于设置、确认等对话框。') + COMPOSER_MATERIAL_NOTES[state.dialogMaterial],
            options: COMPOSER_MATERIAL_OPTIONS,
            value: state.dialogMaterial,
            onChange: deps.setDialogMaterial,
            compact: true,
            control: h(ComposerMaterialSlider, { key: state.dialogMaterial, state: state, surface: MATERIAL_SURFACES[1],
              preview: deps.previewComposerSetting, save: deps.saveComposerSetting }),
          }),
          state.dialogMaterialError ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, state.dialogMaterialError) : null,
          h(OptionGroup, {
            title: t('推理等级控件'),
            note: t('选择列表保留二级菜单；滑块直接在模型菜单中调整，档位和配色跟随当前模型与主题。'),
            options: REASONING_CONTROL_OPTIONS, value: state.reasoningControl, onChange: deps.setReasoningControl, compact: true,
          }),
          state.reasoningControlError ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, state.reasoningControlError) : null,
          h(BackgroundSettings, { state: state, preview: deps.previewBackground, save: deps.saveBackground, error: deps.backgroundError }),
          h(FontSizeRow, {
            // The override leads: it is what the page is actually showing. The
            // runtime's size shows while no out-of-bounds choice is active,
            // which keeps the select honest with the native stepper's value.
            value:
              state.fontSizeOverride !== null && state.fontSizeOverride !== undefined
                ? state.fontSizeOverride
                : state.fontSize,
            onChange: function (px) {
              deps.setFontSize(px)
            },
          }),
          h(OptionGroup, {
            title: t('动画'),
            note: t('控制界面过渡与悬停效果；关闭后所有动画停止'),
            options: ANIMATION_OPTIONS,
            value: state.animation,
            onChange: function (next) {
              deps.setAnimation(next)
            },
            compact: true,
          }),
        )
      }
    }

    /**
     * Register the section and wire the animation preference.
     *
     * @param ctx - the client root context.
     */
    // Keep native React instances and searchable text resident, while excluding
    // distant transcript bodies from layout. A normal `display:none` would make
    // history unsearchable; until-found lets Chromium reveal it before scrolling.
    function bindTranscriptViewport(ctx) {
      if (!window.IntersectionObserver || !window.ResizeObserver || !('onbeforematch' in document.documentElement)
        || typeof ctx.slots.entries !== 'function') return
      var slot = 'conversation.chat.node'
      ctx.slots.inject(slot, function () {
        var states = new Map(), mounted = new Map(), wrappers = new Set(), syncing = false
        function reveal(node) { node.removeAttribute('hidden') }
        function reconcile(node, state) {
          if (!node.isConnected || !state.height) return
          var selection = window.getSelection()
          var selected = selection && !selection.isCollapsed && selection.rangeCount
            && selection.getRangeAt(0).intersectsNode(node)
          if (state.visible || selected || node.contains(document.activeElement)) { reveal(node); return }
          node.style.containIntrinsicBlockSize = state.height + 'px'
          if (!node.hasAttribute('hidden')) node.setAttribute('hidden', 'until-found')
        }
        var sizes = new ResizeObserver(function (entries) {
          entries.forEach(function (entry) {
            var state = states.get(entry.target)
            if (!state || entry.target.hasAttribute('hidden')) return
            if (entry.contentRect.height > 0) state.height = entry.contentRect.height
            reconcile(entry.target, state)
          })
        })
        var visibility = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            var state = states.get(entry.target)
            if (!state) return
            state.visible = entry.isIntersecting
            reconcile(entry.target, state)
          })
        }, { rootMargin: '400px 0px' })
        function attach(node) {
          states.set(node, { visible: true, height: 0 })
          // Native find-in-page removes until-found after this event; keep the
          // wrapper visible until the resulting intersection notification.
          function found() { states.get(node).visible = true; reveal(node) }
          node.addEventListener('beforematch', found)
          sizes.observe(node); visibility.observe(node)
          return function () {
            sizes.unobserve(node); visibility.unobserve(node); states.delete(node)
            node.removeEventListener('beforematch', found); reveal(node)
          }
        }
        function sync() {
          if (syncing) return
          syncing = true
          try {
            var entries = ctx.slots.entries(slot).filter(function (entry) {
              return !wrappers.has(entry.component) && ['assistant-step', 'unknown'].includes(entry.options.key)
            }).slice().sort(function (a, b) { return (a.options.priority || 0) - (b.options.priority || 0) })
            var chosen = new Map()
            entries.forEach(function (entry) { if (!chosen.has(entry.options.key)) chosen.set(entry.options.key, entry) })
            mounted.forEach(function (value, key) { if (chosen.get(key) !== value.entry) { value.remove(); mounted.delete(key) } })
            chosen.forEach(function (entry, key) {
              if (mounted.has(key)) return
              function ViewportBody(props) {
                var root = React.useRef(null)
                return React.createElement('div', { ref: root, 'data-dsh-chat-viewport': '', style: { display: 'flow-root', contentVisibility: 'auto', containIntrinsicBlockSize: 'auto 80px' } },
                  React.createElement(entry.component, props))
              }
              ViewportBody.__dshTranscriptViewport = true
              wrappers.add(ViewportBody)
              mounted.set(key, { entry: entry, remove: ctx.slots.register(Object.assign({}, entry.options, {
                name: slot, priority: (entry.options.priority || 0) - 10,
                inject: entry.inject, store: entry.store, locale: entry.locale,
              }), ViewportBody) })
            })
          } finally { syncing = false }
        }
        var off = ctx.slots.subscribe(slot, sync)
        sync()
        return function () {
          off(); sizes.disconnect(); visibility.disconnect()
          states.forEach(function (_, node) { reveal(node) }); states.clear()
          mounted.forEach(function (value) { value.remove() }); mounted.clear(); wrappers.clear()
        }
      })
    }

    /** Keep the account launcher intact and add a separate settings action beside it. */
    function bindSettingsLauncher(ctx) {
      var IconSettings = primitives && (primitives.IconSettingsOutline16 || primitives.IconSettingsOutlineRegular || primitives.IconSettingsOutlineMedium)
      if (!IconSettings || typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return
      var slot = 'settings.launcher'
      ctx.slots.inject(slot, function () {
        var original, remove, syncing = false, disposed = false
        function SettingsLauncher(props) {
          useLocale(React)
          var button = h('button', {
            type: 'button',
            className: 'dshSidebarSettings__button',
            'aria-label': t('设置'),
            'aria-haspopup': 'dialog',
            'aria-expanded': props.settingsOpen,
            'aria-keyshortcuts': props.settingsShortcut?.aria,
            onClick: props.openSettings,
          }, h(IconSettings, { size: 18 }))
          return h(React.Fragment, null,
            h(original.component, Object.assign({}, props, { hasDesktopSettingsLauncher: !!props.wide })),
            props.wide && h('span', { className: 'dshSidebarSettings' }, Tooltip
              ? h(Tooltip, { label: t('设置'), shortcutKeys: props.settingsShortcut?.keys, disabled: props.settingsOpen }, button)
              : button))
        }
        SettingsLauncher.__dshSettingsLauncher = true
        function sync() {
          if (disposed || syncing) return
          syncing = true
          try {
            var next = document.documentElement.getAttribute(MODE_ATTRIBUTE) === VANILLA ? undefined :
              ctx.slots.entries(slot).filter(function (entry) { return entry.component !== SettingsLauncher })
                .sort(function (a, b) { return (a.options.priority || 0) - (b.options.priority || 0) })[0]
            if (next === original) return
            if (remove) { var off = remove; remove = undefined; off() }
            original = next
            if (!next) return
            remove = ctx.slots.register(Object.assign({}, next.options, {
              name: slot, priority: (next.options.priority || 0) - 1,
              inject: next.inject, locale: next.locale, store: next.store,
            }), SettingsLauncher)
          } finally { syncing = false }
        }
        var unsubscribe = ctx.slots.subscribe(slot, sync)
        var modeObserver = new MutationObserver(sync)
        modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [MODE_ATTRIBUTE] })
        sync()
        return function () {
          disposed = true
          modeObserver.disconnect()
          unsubscribe()
          if (remove) remove()
        }
      })
    }

    function apply(ctx) {
      bindSettingsLauncher(ctx)
      bindTranscriptViewport(ctx)
      if (Tooltip) {
        var TriggerMenuTooltips = createTriggerMenuTooltips()
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'desktop-trigger-tooltips' }, TriggerMenuTooltips)
        })
      }
      ctx.inject(['configForms'], function (child) {
        // Settings still owns the same device preference if the title bar's
        // client contribution is temporarily unmounted or reloaded.
        window.__DSH_REMOTE_THEME__?.bind(child, child.configForms.get('ui-theme'))
        applySettings(child, child.configForms.get('desktop-appearance'))
      })
      ctx.inject(['settingsScope'], function (child) {
        applySettings(child, child.settingsScope.bind({ namespace: 'desktop-appearance' }))
      })
    }

    function applySettings(ctx, scope) {
      var theme = ctx.theme

      // configForms returns false for refused writes; the old scope resolves void.
      function checkSaved(accepted) {
        if (accepted === false && scope.getSnapshot().mode !== 'memory') {
          throw new Error('settings write was not accepted')
        }
      }

      /**
       * The scope's resolved section, but only once the mirror has actually
       * loaded it.
       *
       * WHY THIS GUARD EXISTS. A bound scope starts with `status: 'loading'` and
       * `value: undefined`, and `derive()` ignores snapshots that arrive before
       * the document does. So a listener can fire while the value is still
       * unknown, and a reader that folded that into `desktop`/`system` would
       * overwrite a correct value with a default.
       *
       * That is not hypothetical for the UI mode: the host half applies
       * `data-dsh-ui="vanilla"` before first paint, so the page IS in vanilla
       * while this scope is still loading. Treating "not loaded" as "desktop"
       * would flip the page back to the overlay for as long as the load took —
       * exactly the flash the head script exists to prevent.
       *
       * `unavailable` is equally non-authoritative: it means the namespace is not
       * registered host-side, about which this side has nothing to say.
       *
       * @returns the resolved section, or `undefined` when not yet known.
       */
      var loadedSection = function () {
        var snap = scope.getSnapshot()
        if (!snap || snap.status !== 'ready') return undefined
        var section = snap.value
        return section && typeof section === 'object' ? section : undefined
      }

      /**
       * Read the persisted animation preference.
       *
       * Falls back to `system` when the document has not loaded, matching the
       * schema's own default, so the first render has a defined value.
       *
       * @returns `system`, `on`, or `off`.
       */
      var readAnimation = function () {
        var section = loadedSection()
        var value = section && typeof section.animation === 'string' ? section.animation : 'system'
        return value === 'on' || value === 'off' ? value : 'system'
      }

      /**
       * Read the persisted font-size override.
       *
       * Falls back to `null` when the document has not loaded or carries
       * nothing valid, so the first render shows the runtime's own size and the
       * application path stays the runtime's.
       *
       * @returns an out-of-bounds size (10, 11, 18), or `null` when the runtime owns the size.
       */
      var readFontSizeOverride = function () {
        var section = loadedSection()
        var value = section && typeof section.fontSizeOverride === 'number' ? section.fontSizeOverride : null
        return isFontSizeOverride(value) ? value : null
      }

      var first = theme.getTheme()
      var store = createStore({
        preference: first && first.preference ? first.preference : 'system',
        fontSize: readThemeFontSize(first),
        fontSizeOverride: readFontSizeOverride(),
        animation: readAnimation(),
        colorScheme: colorScheme(loadedSection()?.colorScheme ?? document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)),
        colorSchemeError: '',
        reasoningControl: reasoningControl(loadedSection()),
        reasoningControlError: '',
        ...composerSettings(loadedSection()),
        composerMaterialError: '',
        dialogMaterialError: '',
        ...backgroundSettings(loadedSection()),
        backgroundError: '',
        // The host half publishes the mode before first paint, so the attribute
        // is the more current of the two on a fresh load: it was read from the
        // same settings document, and it is what the page is actually showing.
        ui: document.documentElement.getAttribute(MODE_ATTRIBUTE) === VANILLA ? VANILLA : DESKTOP,
      })

      // Sync from the theme owner. `ThemeRuntime` has no subscription of its own
      // by design: continuous updates are documented to arrive only as this event.
      var sync = function (snapshot) {
        if (!snapshot) return
        // Only the two theme-owned fields: the animation and UI mode are
        // overlay-owned, and the theme snapshot cannot know them.
        store.update({
          preference: snapshot.preference,
          fontSize: readThemeFontSize(snapshot),
        })
        // Every emit ends with the app's presenter writing the snapshot's size
        // into the CSS variable — which would erase an active override. The
        // microtask runs after ALL handlers of this emit have returned, whoever
        // registered first, so the override lands after the presenter's write
        // instead of racing it. No task is queued when no override is active, so
        // a native-size page pays nothing here.
        if (isFontSizeOverride(store.getState().fontSizeOverride)) {
          Promise.resolve().then(assertFontSize)
        }
      }
      ctx.on('theme/change', sync)

      // Upstream canvas consumers read resolved CSS only when theme/change fires.
      // Publish a fresh snapshot for a palette change without writing ui-theme.
      ctx.effect(function () {
        var root = document.documentElement
        function signature() {
          return root.getAttribute(MODE_ATTRIBUTE) === VANILLA ? 'vanilla' : root.getAttribute(COLOR_SCHEME_ATTRIBUTE)
        }
        var previous = signature()
        var observer = new MutationObserver(function () {
          var next = signature()
          if (next === previous) return
          previous = next
          ctx.emit?.('theme/change', Object.assign({}, theme.getTheme()))
        })
        observer.observe(root, { attributes: true, attributeFilter: [MODE_ATTRIBUTE, COLOR_SCHEME_ATTRIBUTE] })
        return function () { observer.disconnect() }
      }, 'desktop-appearance: notify theme consumers')

      // Serialize writes; older acknowledgements must not replace a newer choice.
      var colorSchemeVersion = 0, colorSchemePending = false, colorSchemeDisposed = false
      var colorSchemeQueue = Promise.resolve()
      function syncColorScheme() {
        var section = loadedSection()
        if (colorSchemeDisposed || colorSchemePending || section === undefined) return
        var next = colorScheme(section.colorScheme)
        store.update({ colorScheme: next })
        applyColorScheme(next)
      }
      function setColorScheme(next) {
        if (colorSchemeDisposed || !COLOR_SCHEME_OPTIONS.some(function (option) { return option.id === next })) return
        var version = ++colorSchemeVersion
        colorSchemePending = true
        store.update({ colorScheme: next, colorSchemeError: '' })
        applyColorScheme(next)
        colorSchemeQueue = colorSchemeQueue.then(function () {
          if (!colorSchemeDisposed) return scope.set('colorScheme', next)
        }).then(checkSaved).catch(function () {
          if (!colorSchemeDisposed && version === colorSchemeVersion) store.update({ colorSchemeError: t('配色方案保存失败，请重试。') })
        }).finally(function () {
          if (colorSchemeDisposed || version !== colorSchemeVersion) return
          colorSchemePending = false
          syncColorScheme()
        })
        return colorSchemeQueue
      }
      applyColorScheme(store.getState().colorScheme)
      ctx.effect(function () {
        var off = scope.subscribe(syncColorScheme)
        syncColorScheme()
        return function () { colorSchemeDisposed = true; off() }
      }, 'desktop-appearance: color scheme preference')

      var reasoningVersion = 0, reasoningPending = false, reasoningDisposed = false
      var reasoningQueue = Promise.resolve()
      function setReasoningControl(next) {
        if (!REASONING_CONTROL_OPTIONS.some(function (option) { return option.id === next }) || reasoningDisposed) return
        var version = ++reasoningVersion
        reasoningPending = true
        store.update({ reasoningControl: next, reasoningControlError: '' })
        reasoningQueue = reasoningQueue.then(function () { return scope.set('reasoningControl', next) }).then(checkSaved).catch(function () {
          if (!reasoningDisposed && version === reasoningVersion) store.update({ reasoningControlError: t('推理控件设置保存失败，请重试。') })
        }).finally(function () {
          if (reasoningDisposed || version !== reasoningVersion) return
          reasoningPending = false
          store.update({ reasoningControl: reasoningControl(loadedSection()) })
        })
        return reasoningQueue
      }
      ctx.effect(function () {
        var off = scope.subscribe(function () {
          if (!reasoningPending && loadedSection() !== undefined) store.update({ reasoningControl: reasoningControl(loadedSection()) })
        })
        return function () { reasoningDisposed = true; off() }
      }, 'desktop-appearance: reasoning control preference')
      ctx.inject(['sessions', 'modelDirectories'], function (child) {
        child.effect(function () { return installReasoningMenu(store, child) }, 'desktop-appearance: inline reasoning panel')
      })

      // Keep each field's preview until its own save settles. Other settings
      // acknowledgements must not reset an active drag or a newer selection.
      var materialQueue = Promise.resolve()
      var materialDrafts = {}
      var materialVersions = {}
      var materialQueued = {}
      var materialDisposed = false
      function applyComposerSettings() {
        if (materialDisposed) return
        store.update(Object.assign(composerSettings(loadedSection()), materialDrafts))
        var state = store.getState()
        MATERIAL_SURFACES.forEach(function (surface) {
          document.documentElement.setAttribute(surface.attribute, state[surface.field])
          Object.keys(surface.tuning).forEach(function (material) {
            var control = surface.tuning[material]
            var value = state[control.field]
            document.body.style.setProperty(control.variable, material === 'transparent' ? (100 - value) + '%' : String(value / 100))
          })
        })
      }
      function previewComposerSetting(field, value) {
        if (materialDisposed || !validComposerSetting(field, value)) return
        if (materialDrafts[field] !== value) {
          materialDrafts[field] = value
          materialVersions[field] = (materialVersions[field] || 0) + 1
        }
        store.update({ [materialSurface(field).field + 'Error']: '' })
        applyComposerSettings()
      }
      function saveComposerSetting(field, value) {
        if (materialDisposed || !validComposerSetting(field, value)) return
        previewComposerSetting(field, value)
        var version = materialVersions[field]
        if (materialQueued[field] === version) return materialQueue
        if (materialQueued[field] === undefined && loadedSection()?.[field] === value) {
          delete materialDrafts[field]
          applyComposerSettings()
          return Promise.resolve()
        }
        materialQueued[field] = version
        materialQueue = materialQueue.then(function () { return scope.set(field, value) }).then(checkSaved).catch(function () {
          if (!materialDisposed && materialVersions[field] === version) {
            var surface = materialSurface(field)
            store.update({ [surface.field + 'Error']: surface.error })
          }
        }).finally(function () {
          if (materialQueued[field] === version) delete materialQueued[field]
          if (materialVersions[field] === version) delete materialDrafts[field]
          applyComposerSettings()
        })
        return materialQueue
      }
      function setComposerMaterial(next) { return saveComposerSetting('composerMaterial', next) }
      function setDialogMaterial(next) { return saveComposerSetting('dialogMaterial', next) }
      applyComposerSettings()
      ctx.effect(function () {
        var dispose = scope.subscribe(function () {
          var section = loadedSection()
          if (section !== undefined) applyComposerSettings()
        })
        return function () {
          materialDisposed = true
          dispose()
          MATERIAL_SURFACES.forEach(function (surface) {
            document.documentElement.removeAttribute(surface.attribute)
            Object.values(surface.tuning).forEach(function (control) { document.body.style.removeProperty(control.variable) })
          })
        }
      }, 'desktop-appearance: composer material')

      var setAnimation = function (next) {
        if (next !== 'on' && next !== 'off' && next !== 'system') return
        // Apply before persisting so the UI responds immediately; the settings
        // subscription re-asserts the durable value afterwards.
        applyAnimation(next)
        store.update({ animation: next })
        // `set` takes the field name and its value, not a section object, and
        // returns a promise: a rejection is the host refusing the write, so it
        // must be caught rather than escaping as an unhandled rejection.
        try {
          var pending = scope.set('animation', next)
          if (pending && typeof pending.catch === 'function') {
            pending.then(checkSaved).catch(function (error) {
              ctx.logger?.warn?.(
                'desktop-appearance: could not persist animation preference: ' + String(error),
              )
            })
          }
        } catch (error) {
          ctx.logger?.warn?.(
            'desktop-appearance: could not persist animation preference: ' + String(error),
          )
        }
      }

      // Re-read when the document changes, so an edit made elsewhere is honoured.
      ctx.effect(function () {
        return scope.subscribe(function () {
          var next = readAnimation()
          applyAnimation(next)
          store.update({ animation: next })
          syncFontSize()
        })
      }, 'desktop-appearance: animation preference')

      // ---- the font size (10..18, with the runtime's 12..17 inside it) -----

      /**
       * The size the runtime currently holds, for writes that must hand the
       * variable back to the app.
       *
       * @returns the snapshot's size, or the schema default when none is numeric.
       */
      var nativeFontSize = function () {
        return readThemeFontSize(theme.getTheme())
      }

      /**
       * Re-apply an active override to the document.
       *
       * Idempotent and cheap: one CSS property, written with the value already
       * held in the store. A page in 原版 is skipped — there the app's own
       * presenter governs the variable, and an override is this plugin's
       * modification, which that mode must not show.
       */
      var assertFontSize = function () {
        var px = store.getState().fontSizeOverride
        if (!isFontSizeOverride(px)) return
        if (currentUiMode === VANILLA) return
        writeContentFontSize(px)
      }

      /**
       * Hand the variable back to the app by writing the runtime's own size.
       *
       * Used when an override is lifted: the presenter's value is what the page
       * would show had this plugin never written, so restoring it directly
       * leaves no overlay-owned value behind and no frame at the CSS fallback.
       */
      var withdrawFontSize = function () {
        writeContentFontSize(nativeFontSize())
      }

      /**
       * Converge the document with the persisted override.
       *
       * Runs on every settings event for this namespace. An override that
       * appeared (another window chose 10) is asserted; one that disappeared
       * (another window returned to the runtime's range) is withdrawn, because
       * nothing else will rewrite the variable — the theme runtime only
       * publishes on its own changes, which a pure document edit does not cause.
       */
      var syncFontSize = function () {
        var wanted = readFontSizeOverride()
        var previous = store.getState().fontSizeOverride
        if (previous !== wanted) store.update({ fontSizeOverride: wanted })
        if (isFontSizeOverride(wanted)) assertFontSize()
        else if (isFontSizeOverride(previous)) withdrawFontSize()
      }

      /**
       * Persist one override field write, or its removal.
       *
       * `set` and `unset` take a field name and return a promise: a rejection is
       * the host refusing the write, so it must be caught rather than escaping
       * as an unhandled rejection. The page keeps the applied value either way —
       * the next settings event re-asserts the durable one.
       *
       * @param px - the override to store, or `null` to remove the field.
       */
      var persistFontSize = function (px) {
        try {
          var pending = px === null ? scope.unset('fontSizeOverride') : scope.set('fontSizeOverride', px)
          if (pending && typeof pending.catch === 'function') {
            pending.then(checkSaved).catch(function (error) {
              ctx.logger?.warn?.('desktop-appearance: could not persist font size: ' + String(error))
            })
          }
        } catch (error) {
          ctx.logger?.warn?.('desktop-appearance: could not persist font size: ' + String(error))
        }
      }

      /**
       * The select's write path.
       *
       * Inside the runtime's bounds the value goes to `theme.setFontSize`, which
       * persists it in `ui-theme` and publishes — the native path, with the
       * presenter applying it. Any override is cleared BEFORE that call: the
       * publish runs this plugin's `theme/change` handler, which must already
       * see the override gone or its microtask would restore the old value.
       *
       * Legacy runtimes reject 10, 11, and 18, so those use a desktop override.
       * Role-based runtimes accept the entire selector range through the text role.
       *
       * @param px - the chosen size.
       */
      var setFontSize = function (px) {
        if (!Number.isInteger(px) || px < FONT_MIN || px > FONT_MAX) return
        var snapshot = theme.getTheme()
        var roleBased = snapshot && snapshot.fontSizes
        if (isFontSizeOverride(px) && !roleBased) {
          store.update({ fontSizeOverride: px })
          writeContentFontSize(px)
          persistFontSize(px)
          return
        }
        if (store.getState().fontSizeOverride !== null) {
          store.update({ fontSizeOverride: null })
          // Choosing the runtime's existing size emits no change event.
          withdrawFontSize()
          persistFontSize(null)
        }
        if (roleBased) theme.setFontSize('text', px)
        else theme.setFontSize(px)
      }

      // ---- the UI mode (原版 switch) --------------------------------------

      var backgroundDisposed = false
      var backgroundImageApplied
      var backgroundObjectUrl = ''
      var backgroundRequest = 0
      function applyBackground() {
        if (backgroundDisposed) return
        var state = store.getState()
        var root = document.documentElement
        if (backgroundImageApplied !== state.backgroundImage) {
          backgroundImageApplied = state.backgroundImage
          var request = ++backgroundRequest
          if (!state.backgroundImage) {
            if (backgroundObjectUrl) URL.revokeObjectURL(backgroundObjectUrl)
            backgroundObjectUrl = ''
            document.body.style.setProperty('--dsh-background-image', 'none')
          } else {
            // Chromium rejects very large custom-property values. Persist the
            // portable data URL, but paint using a short, per-page blob URL.
            var candidate = ''
            var source = state.backgroundImage
            Promise.resolve().then(function () {
              var comma = source.indexOf(',')
              var binary = atob(source.slice(comma + 1))
              var bytes = Uint8Array.from(binary, function (char) { return char.charCodeAt(0) })
              candidate = URL.createObjectURL(new Blob([bytes], { type: source.slice(5, comma).split(';')[0] }))
              var probe = new Image()
              probe.src = candidate
              return probe.decode()
            }).then(function () {
              if (backgroundDisposed || request !== backgroundRequest) { URL.revokeObjectURL(candidate); return }
              var previous = backgroundObjectUrl
              backgroundObjectUrl = candidate
              document.body.style.setProperty('--dsh-background-image', 'url(' + JSON.stringify(candidate) + ')')
              if (previous) URL.revokeObjectURL(previous)
              applyBackground()
            }).catch(function () {
              if (candidate) URL.revokeObjectURL(candidate)
              if (!backgroundDisposed && request === backgroundRequest) {
                store.update({ backgroundError: t('背景图片加载失败，请重新选择图片。') })
              }
            })
          }
        }
        document.body.style.setProperty('--dsh-background-image-opacity', String(1 - state.backgroundTransparency / 100))
        document.body.style.setProperty('--dsh-background-navigation-opacity', String(1 - state.backgroundNavigationSurfaceTransparency / 100))
        document.body.style.setProperty('--dsh-background-blur', (state.backgroundBlur * 0.4) + 'px')
        if (backgroundObjectUrl && state.backgroundImage && state.backgroundBlur > 0) root.setAttribute('data-dsh-background-blur', '')
        else root.removeAttribute('data-dsh-background-blur')
        BACKGROUND_REGIONS.forEach(function (region) {
          var field = 'background' + region[0]
          BACKGROUND_TARGETS[region[0]].forEach(function (target) {
            var attr = 'data-dsh-background-' + target
            if (backgroundObjectUrl && state.backgroundImage && state[field]) root.setAttribute(attr, '')
            else root.removeAttribute(attr)
          })
          if (region[0] !== 'Navigation') {
            var opacity = 1 - state[field + 'SurfaceTransparency'] / 100
            document.body.style.setProperty('--dsh-background-' + region[0].toLowerCase() + '-opacity', String(opacity))
          }
        })
      }
      function previewBackground(field, value) {
        store.update({ [field]: value, backgroundError: '' })
        applyBackground()
      }
      var backgroundQueue = Promise.resolve()
      var backgroundPending = 0
      function saveBackground(field, value) {
        previewBackground(field, value)
        if (!backgroundPending && loadedSection()?.[field] === value) return Promise.resolve()
        backgroundPending++
        backgroundQueue = backgroundQueue.then(function () { return scope.set(field, value) }).then(checkSaved).catch(function () {
          store.update({ backgroundError: t('背景设置保存失败，请重试。') })
        }).finally(function () {
          backgroundPending--
          if (!backgroundPending) {
            store.update(backgroundSettings(loadedSection()))
            applyBackground()
          }
        })
        return backgroundQueue
      }
      applyBackground()
      ctx.effect(function () {
        var dispose = scope.subscribe(function () {
          if (loadedSection() === undefined || backgroundPending) return
          store.update(backgroundSettings(loadedSection()))
          applyBackground()
        })
        return function () {
          backgroundDisposed = true
          backgroundRequest++
          if (backgroundObjectUrl) URL.revokeObjectURL(backgroundObjectUrl)
          dispose()
          BACKGROUND_REGIONS.forEach(function (region) {
            BACKGROUND_TARGETS[region[0]].forEach(function (target) {
              document.documentElement.removeAttribute('data-dsh-background-' + target)
              document.body.style.removeProperty('--dsh-background-' + target + '-opacity')
            })
          })
          document.body.style.removeProperty('--dsh-background-image-opacity')
          document.body.style.removeProperty('--dsh-background-navigation-opacity')
          document.body.style.removeProperty('--dsh-background-blur')
          document.documentElement.removeAttribute('data-dsh-background-blur')
          document.body.style.removeProperty('--dsh-background-image')
        }
      }, 'desktop-appearance: background preference')

      var Section = createSection({
        store: store,
        setTheme: function (id) {
          theme.setTheme(id)
        },
        setFontSize: setFontSize,
        setAnimation: setAnimation,
        setReasoningControl: setReasoningControl,
        setColorScheme: setColorScheme,
        setComposerMaterial: setComposerMaterial,
        setDialogMaterial: setDialogMaterial,
        previewComposerSetting: previewComposerSetting,
        saveComposerSetting: saveComposerSetting,
        previewBackground: previewBackground,
        saveBackground: saveBackground,
        backgroundError: function (message) { store.update({ backgroundError: message }) },
      })

      /**
       * Read the persisted UI mode.
       *
       * Fails closed to `desktop` only when the document says nothing either —
       * see {@link loadedSection} for why an unloaded scope must not be read as a
       * value. This reader is only used for persisted-value changes, where the
       * scope is by definition loaded.
       *
       * @returns `desktop` or `vanilla`.
       */
      var readUi = function () {
        var section = loadedSection()
        return section && section.ui === VANILLA ? VANILLA : DESKTOP
      }

      /**
       * The mode currently in effect.
       *
       * Held so {@link syncSectionVisibility} can read it when the settings slot
       * is declared, which can happen before or after the mode is first applied.
       *
       * @type {string}
       */
      var currentUiMode = DESKTOP

      /**
       * Register or withdraw the 外观 section to match the current mode.
       *
       * A hoisted DECLARATION rather than a `var` assignment, because
       * {@link adoptUi} calls it and may run before this point in the body: the
       * early return covers exactly that window, and the slot-injection callback
       * finishes the job once the slot exists.
       */
      function syncSectionVisibility() {
        if (sectionSlotReady !== true) return
        if (currentUiMode === VANILLA) unmountSection()
        else mountSection()
      }

      /**
       * Put one mode into effect everywhere it matters.
       *
       * The attribute is the whole mechanism for the page's appearance: the
       * stylesheet stops matching and the DOM tier cleans up after itself. The
       * event then tells the two listeners that cannot see this plugin's state —
       * the title bar's menu label, and the DOM tier's pass — so neither has to
       * poll for it. The settings section is this plugin's own surface, so it is
       * handled here rather than through the event.
       *
       * @param mode - the mode to apply.
       */
      var adoptUi = function (mode) {
        var applied = applyUiMode(mode)
        currentUiMode = applied
        // 原版 must not carry the plugin's own font size: an active override is
        // overwritten with the runtime's value, so the frontend shows only what
        // it would show unmodified. Returning to desktop re-asserts it.
        if (applied === VANILLA) withdrawFontSize()
        else assertFontSize()
        syncSectionVisibility()
        announceUiMode(applied)
        return applied
      }

      /**
       * Switch modes on the user's request, persisting the choice.
       *
       * Applied BEFORE the write, so the page responds at once and does not wait
       * on a round trip to the host. It is deliberately not reverted on failure:
       * the settings subscription re-asserts the durable value, so a rejected
       * write corrects the page by itself — the same shape the animation
       * preference uses.
       *
       * @param next - the requested mode.
       */
      var setUi = function (next) {
        if (next !== DESKTOP && next !== VANILLA) return
        var applied = adoptUi(next)
        store.update({ ui: applied })
        try {
          var pending = scope.set('ui', applied)
          if (pending && typeof pending.catch === 'function') {
            pending.then(checkSaved).catch(function (error) {
              ctx.logger?.warn?.('desktop-appearance: could not persist ui mode: ' + String(error))
            })
          }
        } catch (error) {
          ctx.logger?.warn?.('desktop-appearance: could not persist ui mode: ' + String(error))
        }
      }

      // The title bar's 更多 menu asks for a mode; persisting and applying it is
      // this plugin's job, because it owns the settings scope.
      ctx.effect(function () {
        var onRequest = function (event) {
          var detail = event && event.detail ? event.detail : {}
          setUi(detail.mode)
        }
        document.addEventListener(REQUEST_EVENT, onRequest)
        return function () {
          document.removeEventListener(REQUEST_EVENT, onRequest)
        }
      }, 'desktop-appearance: ui mode requests')

      // Re-read when the document changes, so an edit made elsewhere — or a
      // change made while another window was open — is honoured.
      ctx.effect(function () {
        return scope.subscribe(function () {
          // An unloaded scope reports no value, and must not be read as
          // "desktop": on a page the host pre-seeded with vanilla that would
          // switch the overlay back on. See {@link loadedSection}.
          if (loadedSection() === undefined) return
          var next = readUi()
          if (store.getState().ui === next) return
          adoptUi(next)
          store.update({ ui: next })
        })
      }, 'desktop-appearance: ui mode preference')

      // Apply the persisted values at startup, before the user opens settings.
      // The mode attribute may already be set by the host half's head script;
      // re-asserting it here is what makes the two halves agree when the client
      // plugin loads into a page the host did not pre-seed.
      applyAnimation(store.getState().animation)
      adoptUi(store.getState().ui)
      // The presenter's first apply may land after this module (load order is
      // the loader's, not ours) and would write the runtime's size over an
      // active override. One microtask after every module has evaluated puts
      // the override back; a no-op when none is active.
      Promise.resolve().then(assertFontSize)

      /**
       * The live registration for the 外观 section, or `null` when withdrawn.
       *
       * @type {undefined | (() => void) | null}
       */
      var sectionEntry = null

      /**
       * Whether the `settings.section` slot has been declared yet.
       *
       * Registration is deferred until it has. Registering early is inert rather
       * than harmful — an undeclared slot keeps its entries without rendering
       * them — but waiting keeps one code path (`the slot exists`) instead of two.
       */
      var sectionSlotReady = false

      /**
       * Register the 外观 section.
       *
       * WHY THIS IS WITHDRAWN IN 原版. The section is this app's own addition to
       * the settings navigation, so leaving it in place would mean 原版 still
       * shows a project modification. It would also be actively confusing: the
       * theme and font-size rows return to 通用设置 the moment section 8 of the
       * stylesheet stops hiding them, and the animation control would govern
       * transitions that are no longer applied.
       *
       * Withdrawing is safe for the settings shell: it resolves the active
       * section as `rows.find(id) ?? rows[0]`, so a section that disappears while
       * it is open falls back to the first one rather than rendering blank.
       */
      function mountSection() {
        if (sectionSlotReady !== true || sectionEntry !== null) return
        sectionEntry = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'appearance',
            // After General (0), before the sections that follow it, so the list
            // reads general → appearance → models → plugins.
            order: 5,
            label: function () {
              return t('外观')
            },
            children: {},
          },
          Section,
        )
      }

      /**
       * Withdraw the 外观 section.
       *
       * Safe to call when it is not registered, so callers need no state check of
       * their own.
       */
      function unmountSection() {
        if (sectionEntry === null) return
        var dispose = sectionEntry
        sectionEntry = null
        try {
          dispose()
        } catch (error) {
          ctx.logger?.warn?.(t('desktop-appearance: could not withdraw the 外观 section: ') + String(error))
        }
      }

      ctx.slots.inject('settings.section', function () {
        sectionSlotReady = true
        syncSectionVisibility()
        // The plugin's own teardown: the slot fiber disposes this on unload.
        return function () {
          sectionSlotReady = false
          unmountSection()
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
