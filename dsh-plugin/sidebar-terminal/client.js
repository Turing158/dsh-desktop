/** Terminal tab registration. The local runtime owns PTY views and transport. */

window.__ModuleLoader__.load({
  id: '@dsh-desktop/sidebar-terminal',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    
  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
  const useLocale = React => window.__DSH_I18N__?.use(React)
var React = require('react')
    var reactDom = require('react-dom')

    /**
     * The app's own UI primitives, for the surface's "..." menu.
     *
     * RESOLVED HERE, IN `client.js`, RATHER THAN IN `runtime.mjs`, and that is a
     * build constraint rather than a preference: `runtime.mjs` is bundled by
     * esbuild into `assets/terminal.js`, which is served as its own `<script>` and
     * is *not* part of the client-module graph — a `require` of an app package
     * inside it would resolve against nothing. This file IS in that graph, so a
     * bare specifier here walks the module table and finds the platform seed word.
     *
     * WHY THE MENU IS WORTH IT. 清空 / 重连 / 重启 were three buttons in the title
     * row; they are now one control whose popup is the SAME surface every other
     * dropdown in the window uses — 通用设置's own selectors included. Matching the
     * menu by eye would mean re-deriving its radius, elevation, click-outside,
     * Escape handling and roving focus; using it means those cannot drift.
     *
     * The read is guarded because a missing primitives module must not fail the
     * whole plugin: `createBody` falls back to a plain list when `Menu` is absent.
     */
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      // Logged rather than swallowed: a silent fallback would look like a styling
      // choice, when it means the menu has degraded to its stand-in.
      console.warn('desktop-sidebar-terminal: UI primitives unavailable: ' + String(error))
    }

    /** `createElement` shorthand; no JSX is available in a hand-built bundle. */
    var h = React.createElement

    /** This implementation's identity in the tab system, and the key its body registers under. */
    var ID = '@dsh-desktop/sidebar-terminal'

    /** The page kind `openTab` names. The column records it at `sidebar://<kind>`. */
    var KIND = 'desktop-terminal'

    /** The address the shipped guide opens this kind at, and the one address this body gives up. */
    var PAGE_ADDRESS = 'sidebar://' + KIND

    /**
     * This type's resource address prefix.
     *
     * `dsh-resource://` IS NOT DECORATION — it is the only scheme `openResource`
     * accepts. `placeResource` refuses anything else outright:
     *
     *     if (!address.startsWith("dsh-resource://")) throw new Error(…)
     *
     * and the resource registry reads the PROTOCOL from the parsed URL's host, so
     * this type's "one protocol" is that host segment and each terminal is a path
     * under it. A private scheme (`dsh-desktop-terminal://…`) parses as a protocol
     * of its own, is claimed by no provider, and is rejected by the very call that
     * opens it — MEASURED, not assumed: the first live run of this plugin failed
     * exactly there, and the terminal silently stayed on the shared page address.
     */
    var PREFIX = 'dsh-resource://desktop-terminal/'

    /** The glob this type recognizes, matched against the whole address. */
    var PATTERN = 'dsh-resource://desktop-terminal/**'

    /**
     * Placement for the adoption: this tab's own slot, and no reveal.
     *
     * `replaceTab` is what makes it invisible — the old record closes and the new
     * one opens at the same index in one commit. `revealIfOpened: false` keeps a
     * resource address from being re-focused instead of opened, which is the only
     * reason a second terminal can exist at all.
     */
    var ADOPT_PLACEMENT = { replaceTab: true, revealIfOpened: false }

    /** Guide position: past every registered entry, so 终端 is the last door on the page. */
    var GUIDE_ORDER = Number.MAX_SAFE_INTEGER

    /** The `<html>` attribute carrying the live UI mode; `ui-client/client.js` owns it. */
    var MODE_ATTRIBUTE = 'data-dsh-ui'

    /** The value meaning "the unmodified frontend". */
    var VANILLA = 'vanilla'

    /**
     * Announcement that a mode was applied. Dispatched on `document` by the
     * appearance plugin, which owns the setting. Keep the name in sync with
     * `CHANGE_EVENT` there.
     */
    var MODE_CHANGE_EVENT = 'dsh-desktop:ui-mode'

    /**
     * The offline copy, in one place.
     *
     * Held as data rather than inline in the tree so a test can assert the page
     * states its condition in words — the acceptance rule this surface is judged
     * by — without depending on where each string sits.
     *
     * Chinese only, deliberately: every other piece of this app's own chrome (the
     * title bar's menus, the 外观 section) is written in the product's language
     * rather than through DSH's locale service, and a single-language desktop
     * overlay needs no dictionary.
     */
    var COPY = {
      get tabTitle() { return t('终端') },
      get guideTitle() { return t('终端') },
      get guideDescription() { return t('在项目目录打开交互式终端。') },
      get panelTitle() { return t('终端') },
      get status() { return t('桌面连接不可用') },
      get message() { return t('桌面连接不可用') },
      get hint() { return t('请在桌面应用中打开终端。') },
    }

    /**
     * The type's glyph: a terminal window with a prompt chevron.
     *
     * Drawn here because the app exports no terminal icon (its primitives stop at
     * `IconCodeOutline16`), and drawn at the guide's own glyph box so it sits with
     * the shipped ones. `size` and `className` are what `EntryBox` passes; the
     * stroke is `currentColor`, so the capsule's hover and disabled inks apply.
     *
     * @param props - `size` (22 beside a description, 26 without) and `className`.
     * @returns the icon element.
     */
    function TerminalGlyph(props) {
      var size = props.size || 22
      return h(
        'svg',
        {
          width: size,
          height: size,
          className: props.className,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 2.75, y: 4.25, width: 18.5, height: 15.5, rx: 3.25 }),
        h('path', { d: 'M7.4 9.6 10.4 12.2 7.4 14.8' }),
        h('path', { d: 'M12.9 15h3.7' }),
      )
    }

    /**
     * Whether the page is currently showing the unmodified frontend.
     *
     * Read from the document every time rather than cached: the attribute is the
     * single value the stylesheet and the DOM tier are gated on, so it is the one
     * answer that cannot disagree with what the user sees.
     *
     * @returns `true` while 原版 is in effect.
     */
    function isVanilla() {
      if (typeof document === 'undefined') return false
      return document.documentElement.getAttribute(MODE_ATTRIBUTE) === VANILLA
    }

    /**
     * The address one terminal is recorded at.
     *
     * @param tabId - the tab record's id, which the column mints and never reuses.
     * @returns the tab's own resource address.
     */
    var addresses = new WeakMap()
    function addressFor(tabId, signal) {
      if (!addresses.has(signal)) addresses.set(signal, PREFIX + encodeURIComponent(String(tabId)) + '-' + crypto.randomUUID())
      return addresses.get(signal)
    }

    /**
     * Report a refused step without breaking the surface.
     *
     * Every call here crosses into another plugin's controller, and a rejection
     * must leave a working page rather than an exception rendered as a slot error.
     *
     * @param ctx - the client context, for the logger.
     * @param what - a short description of the attempted step.
     * @param error - the rejection reason.
     */
    function warn(ctx, what, error) {
      var detail = error instanceof Error ? error.message : String(error)
      try {
        ctx.logger?.warn?.('desktop-sidebar-terminal: could not ' + what + ': ' + detail)
      } catch {
        // A logger that throws must not turn a handled failure into an unhandled one.
      }
    }

    /**
     * Move the tab the guide just opened onto an address of its own.
     *
     * Runs on the body's first paint for each tab record. It is idempotent by
     * construction: once the record carries our address, the guard returns and no
     * further store write happens, so a re-render or a duplicated effect cannot
     * loop.
     *
     * @param ctx - the client context, for the logger.
     * @param tab - the live tab record, with its own actions and abort signal.
     */
    function adoptOwnAddress(ctx, tab) {
      if (tab.contentId !== PAGE_ADDRESS) return
      if (tab.signal.aborted) return
      try {
        tab.actions.openResource(addressFor(tab.id, tab.signal), ADOPT_PLACEMENT)
      } catch (error) {
        // The tab stays on the page address: a terminal that works, shared with
        // any other one, rather than a blank pane.
        warn(ctx, 'give this terminal its own address', error)
        return String(error)
      }
    }

    /**
     * The surface: a title row, and the offline notice under it.
     *
     * Nothing here is interactive and nothing here is simulated — no prompt, no
     * cursor, no output. Deliberately so: this stage has no shell behind it, and a
     * terminal that looks ready but cannot run anything is worse than one that
     * says it is not connected.
     *
     * @returns the terminal element.
     */
    function terminalSurface() {
      return h(
        'section',
        { className: 'dshTerminal', 'data-dsh-terminal': true, 'aria-label': COPY.panelTitle },
        h(
          'header',
          { className: 'dshTerminal__header' },
          h('h2', { className: 'dshTerminal__title' }, COPY.panelTitle),
          h('span', { className: 'dshTerminal__status', 'data-dsh-terminal-status': 'offline' }, COPY.status),
        ),
        h(
          'div',
          { className: 'dshTerminal__content', 'data-dsh-terminal-content': 'offline' },
          h('p', { className: 'dshTerminal__message' }, COPY.message),
          h('p', { className: 'dshTerminal__hint' }, COPY.hint),
        ),
      )
    }

    /**
     * Build the body component bound to its context.
     *
     * The context is closed over rather than read from props, so the component
     * itself takes exactly what the seat passes: the framework-bound
     * `useTabInfo` hook and nothing else.
     *
     * @param ctx - the client root context, for the logger.
     * @returns the component the keyed seat renders.
     */
    var registry = null
    var LiveTerminal = null
    var dock = null
    var settings = null
    function createBody(ctx) {
      return function TerminalBody(props) {
      useLocale(React)
        var tab = props.useTabInfo().tab
        // A layout effect, not a passive one: the store write must land in the
        // same commit the column is already painting, so the guide's own tab is
        // never shown opened under its generic address.
        React.useLayoutEffect(
          function () {
            adoptOwnAddress(ctx, tab)
          },
          [tab.id, tab.contentId, tab.signal, tab.actions],
        )
        if (String(tab.contentId || '').indexOf(PREFIX) !== 0) return h('section', { className: 'dshTerminal', role: 'status' }, t('无法建立独立终端地址，请关闭此标签后重试。'))
        return LiveTerminal ? h(LiveTerminal, { tab: tab }) : terminalSurface()
      }
    }

    /**
     * Dispose a list of registrations, whatever state they are in.
     *
     * Reverse order, and each one guarded: a disposer that throws must not strand
     * the ones behind it, because a stranded type would keep its guide entry (and
     * its id) alive for the rest of the page's life.
     *
     * @param disposers - the registrations to release.
     */
    function release(disposers) {
      for (var i = disposers.length - 1; i >= 0; i -= 1) {
        if (!disposers[i]) continue
        try {
          disposers[i]()
        } catch {
          // Already gone, or a controller that refuses to be released: nothing
          // useful is left to do about it here.
        }
      }
    }

    /**
     * The plugin's live registrations.
     *
     * Three entries, because the mode moves only the type definition:
     *
     *   - `type` is the registry definition. Its `guide` array is what the guide
     *     page draws, so 原版 replaces it with a definition carrying NO guide —
     *     while `id`, `kind`, and `patterns` stay identical.
     *   - `body` is the keyed seat under the same `id`, and it is registered once
     *     and held for the plugin's whole life.
     *   - `dock` is the frame overlay seat; hiding it never releases its sessions.
     *
     * Held at module scope so mount and withdraw cannot each own a copy.
     */
    var held = null

    /**
     * Whether the definition currently registered contributes a guide entry.
     *
     * @type {boolean|null}
     */
    var guideOffered = null

    /**
     * The type's definition, with or without its guide entry.
     *
     * WHY THE TYPE ITSELF SURVIVES 原版. The body is dispatched by the definition's
     * `id`, so unregistering the type would leave a terminal the user already has
     * open rendering the column's "nothing can view this" notice — a broken pane,
     * which is not what "the unmodified frontend" should mean. The entry is this
     * project's addition and is withdrawn; the type that draws an open terminal is
     * not an addition to anything, it is what is already on screen.
     *
     * @param showGuide - whether the guide page should offer the 终端 capsule.
     * @returns the definition to register.
     */
    function definition(showGuide) {
      var base = {
        id: ID,
        kind: KIND,
        patterns: [PATTERN],
        // Cheap and synchronous, as the router's contract requires. The globs have
        // already matched; this only states the invariant the body depends on.
        canOpen: function (address) {
          return address.indexOf(PREFIX) === 0
        },
        title: function () {
          return COPY.tabTitle
        },
      }
      if (!showGuide) return base
      base.guide = [
        {
          order: GUIDE_ORDER,
          title: function () {
            return COPY.guideTitle
          },
          description: function () {
            return COPY.guideDescription
          },
          icon: TerminalGlyph,
        },
      ]
      return base
    }

    /**
     * Bring the registrations in line with the mode the page is actually in.
     *
     * The two are not swapped together. The body is registered once and stays: it
     * has to exist before the first terminal opens, and removing it would blank a
     * tab that is already on screen. Only the TYPE is re-registered, and only when
     * the guide entry's presence actually changes — so a re-announced mode costs
     * nothing, which matters because re-registering an id that is still live throws.
     *
     * @param ctx - the client root context.
     * @returns whether the plugin holds its registrations.
     */
    function mount(ctx, upstream) {
      var wantGuide = !isVanilla()
      try {
        if (held === null) {
          held = { type: null, body: null, dock: null, toggle: null }
          if (!upstream) held.body = ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, createBody(ctx))
          })
          held.dock = ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({ name: 'shell.overlay', id: 'desktop-terminal-dock', order: -1 }, function TerminalDockSlot() {
              return dock ? h(React.Fragment, null, h(dock.Component), dock.FallbackToggle && h(dock.FallbackToggle)) : null
            })
          })
          // The way in and out of the bottom panel, in the conversation header's
          // utilities row — where the user asked for it: immediately left of the
          // shipped 打开侧边栏 control, opening AND closing the dock.
          //
          // WHY THE UTILITIES LIST AND NOT THE CORNER SEAT BESIDE THE SIDEBAR'S OWN
          // BUTTON. That seat is `single`, and the shipped right sidebar already
          // occupies it with its `ExpandButton` (the 打开侧边栏 control). A `single`
          // seat holds ONE occupant and a second registration REPLACES the first, so
          // registering there would silently delete the app's own sidebar control.
          // The utilities list is additive, renders in ascending `order`, and sits
          // immediately left of the corner — so `order: 1` is what actually places
          // this button "to the left of 打开侧边栏" rather than describing an intent
          // the framework cannot express.
          held.toggle = ctx.slots.inject('conversation.session.header.utilities', function () {
            return ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'desktop-terminal-dock', order: 1 }, function TerminalDockToggleSlot() {
              return dock ? h(dock.Toggle) : null
            })
          })
        }
        if (!upstream && (held.type === null || guideOffered !== wantGuide)) {
          // Released first: the registry refuses a second registration of a live id,
          // so the replacement cannot be added until the old one is gone. Both calls
          // are synchronous, so nothing paints in between.
          release([held.type])
          held.type = ctx.sidebarRightTabs.register(definition(wantGuide))
          guideOffered = wantGuide
        }
      } catch (error) {
        release([held?.type, held?.body, held?.dock, held?.toggle])
        held = null
        guideOffered = null
        warn(ctx, 'register the terminal tab type', error)
        return false
      }
      return true
    }

    /** Release everything; safe to call when nothing is registered. */
    function withdraw() {
      if (held === null) return
      var outstanding = held
      held = null
      guideOffered = null
      release([outstanding.type, outstanding.body, outstanding.dock, outstanding.toggle])
    }

    /**
     * Make the registration match the mode the page is actually in.
     *
     * Read from the document rather than from the event's payload: the attribute is
     * what the rest of the overlay is gated on, so this cannot go stale the way a
     * remembered mode can.
     *
     * @param ctx - the client root context.
     */
    function syncMode(ctx) {
      mount(ctx)
    }

    /**
     * Required client services.
     *
     * `sidebarRightTabs` is the type registry the guide reads; `slots` is where the
     * body is registered under the same `id`. Both are declared, because the client
     * facade gates `ctx.<service>` on this list — an undeclared one parks the
     * plugin instead of throwing where it can be read.
     *
     * The primitives module is NOT listed and must not be: it is a platform seed
     * word, resolved through `require` rather than a cordis service, so listing it
     * here would leave the plugin waiting on a service that never publishes.
     */
    var inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'workspaces']

    /**
     * Client plugin body: mount the type, then follow the mode for the page's life.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      if (typeof document === 'undefined') return
      // A browser has no native terminal transport. Do not register its guide,
      // type, settings, shortcuts or dock; remove only old terminal tabs locally.
      if (window.top !== window || !window.__TAURI__?.core?.Channel || !window.__TAURI__?.core?.invoke) {
        ctx.effect(function () { return window.DSHTerminal?.hideDesktopTerminals(ctx) }, 'desktop terminal browser cleanup')
        ctx.inject(['webTerminals', 'sidebarRight'], function (child) {
          child.effect(function () { return window.DSHTerminal?.installMobileTerminalInput(child) }, 'web terminal mobile input')
        })
        return
      }

      ctx.inject(['configForms'], function (child) {
        applySettings(child, child.configForms.get('desktop-terminal-dock'))
      })
      ctx.inject(['settingsScope'], function (child) {
        applySettings(child, child.settingsScope.bind({ namespace: 'desktop-terminal-dock' }))
      })
    }

    function applySettings(ctx, scope) {
      ctx.effect(
        function () {
          var upstream = null, stop = null, syncing = false, disposed = false
          function syncAvailability() {
            if (disposed || syncing) return
            syncing = true
            try {
              // Use the registered capability, not a version threshold. Observe
              // it because the upstream plugin may load after this one or reload.
              var available = ctx.sidebarRightTabs.get('terminal') || false
              if (available === upstream) return
              upstream = available
              stop?.()
              stop = null
              stop = available
                ? activateUpstream(ctx, scope, available.id)
                : activateDesktop(ctx, scope)
            } finally { syncing = false }
          }
          var offTypes = ctx.sidebarRightTabs.subscribe(syncAvailability)
          syncAvailability()
          return function () {
            disposed = true
            offTypes()
            stop?.()
          }
        },
        'desktop-sidebar-terminal: tab type and guide entry',
      )
    }

    function activateUpstream(ctx, scope, typeId) {
      var stopped = false, cleanup = null
      var offCleanup = window.DSHTerminal?.hideDesktopTerminals(ctx)
      var offServices = ctx.inject(['webTerminals', 'theme', 'locale'], function (child) {
        child.effect(function () {
          if (stopped) return function () {}
          var upstreamSettings = window.DSHTerminal.createUpstreamSettings(React, primitives, scope, child)
          var offDefaults = window.DSHTerminal.installUpstreamShellDefault(child.webTerminals, upstreamSettings.preferences)
          var offInteractions = window.DSHTerminal.installUpstreamTerminalInteractions(document, function (error) { warn(child, 'copy or paste terminal text', error) })
          dock = window.DSHTerminal.createUpstreamDock(React, child, scope, isVanilla, typeId, upstreamSettings.preferences, primitives)
          var offRemoteState = window.__DSH_UI_STATE__?.registerProvider('desktop-terminal', window.DSHTerminal.createUpstreamRemoteState(child, dock.registry, dock.store))
          var offSettings = []
          ;[['profile', upstreamSettings.ProfileRow], ['position', upstreamSettings.PositionRow]].forEach(function (entry, index) {
            offSettings.push(child.slots.inject('settings.general.item', function () {
              return child.slots.register({ name: 'settings.general.item', id: 'desktop-terminal-' + entry[0], order: 80 + index }, entry[1])
            }))
          })
          var offShortcut = window.DSHTerminal.bindUpstreamShortcut(document, child, dock, upstreamSettings.preferences, function (error) { warn(child, 'open the default DSH terminal', error) })
          dock.FallbackToggle = window.DSHTerminal.createDockFallbackToggle?.(React, reactDom, dock.Toggle)
          var currentDock = dock
          mount(child, true)
          if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_UPSTREAM_DOCK_SMOKE__ = { ctx: child, dock: dock.store, registry: dock.registry }
          cleanup = function () {
            if (!currentDock) return
            if (dock === currentDock) {
              withdraw()
              dock = null
              delete window.__DSH_UPSTREAM_DOCK_SMOKE__
            }
            offShortcut()
            offRemoteState?.()
            offInteractions()
            release(offSettings)
            offDefaults()
            upstreamSettings.dispose()
            currentDock.dispose()
            currentDock = null
          }
          return cleanup
        }, 'desktop-sidebar-terminal: built-in dock')
      })
      return function () { stopped = true; cleanup?.(); offServices?.dispose(); offCleanup?.() }
    }

    /** Only the fallback owns native PTY views. */
    function activateDesktop(ctx, scope) {
      var offShortcut = null, offRemoteState = null, offSettings = []
      if (window.DSHTerminal && !registry) {
        settings = window.DSHTerminal.createSettings(React, primitives, scope)
        registry = window.DSHTerminal.createRegistry(ctx, settings.preferences)
        LiveTerminal = window.DSHTerminal.createBody(React, registry, primitives)
        dock = window.DSHTerminal.createDock(React, registry, primitives, isVanilla, scope, ctx)
        dock.FallbackToggle = window.DSHTerminal.createDockFallbackToggle?.(React, reactDom, dock.Toggle)
        offRemoteState = window.__DSH_UI_STATE__?.registerProvider('desktop-terminal', window.DSHTerminal.createRemoteState(ctx, registry, dock.store))
        ;[['profile', settings.ProfileRow], ['position', settings.PositionRow]].forEach(function (entry, index) {
          offSettings.push(ctx.slots.inject('settings.general.item', function () {
            return ctx.slots.register({ name: 'settings.general.item', id: 'desktop-terminal-' + entry[0], order: 80 + index }, entry[1])
          }))
        })
        offShortcut = window.DSHTerminal.bindShortcut(registry, dock.store, settings.preferences, function (error) { warn(ctx, 'open the default terminal', error) })
        if (window.__DSH_UI_BOOT__?.smoke) window.__DSH_TERMINAL_SMOKE__ = { ctx: ctx, registry: registry, dock: dock.store }
      }
      syncMode(ctx)
      var onMode = function () { syncMode(ctx) }
      document.addEventListener(MODE_CHANGE_EVENT, onMode)
      return function () {
        document.removeEventListener(MODE_CHANGE_EVENT, onMode)
        offShortcut?.()
        offRemoteState?.()
        release(offSettings)
        settings?.dispose()
        dock?.dispose()
        registry?.dispose()
        registry = null
        LiveTerminal = null
        dock = null
        settings = null
        delete window.__DSH_TERMINAL_SMOKE__
        withdraw()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
