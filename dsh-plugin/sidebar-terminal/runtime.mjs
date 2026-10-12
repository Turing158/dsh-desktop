import { t, useLocale } from '../i18n/api.mjs'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createDockStore, createDockComponent, createDockToggleComponent, createDockWorkspaceSource, createDockFallbackToggle as fallbackToggle } from './dock.mjs'
import { createPreferences, createSettingsRow, installShortcut } from './preferences.mjs'
import { createRemoteState as remoteState, hideDesktopTerminals as hideDesktop } from './remote-state.mjs'
import { selectionText } from './selection.mjs'
import { currentSessionId } from './session-context.mjs'
import { installMobileTerminalInput as mobileInput } from './mobile-input.mjs'
import { installUpstreamTerminalInteractions as upstreamInteractions } from './upstream-interactions.mjs'
import { createUpstreamDock as upstreamDock } from './upstream-dock.mjs'
import { createUpstreamPreferences, installUpstreamShellDefault as upstreamShellDefault, bindUpstreamShortcut as upstreamShortcut } from './upstream-preferences.mjs'
export function installUpstreamShellDefault(...args) { return upstreamShellDefault(...args) }
export function bindUpstreamShortcut(...args) { return upstreamShortcut(...args) }
export function installUpstreamTerminalInteractions(...args) { return upstreamInteractions(...args) }

export function createRemoteState(...args) { return remoteState(...args) }
export function hideDesktopTerminals(...args) { return hideDesktop(...args) }
export function installMobileTerminalInput(...args) { return mobileInput(...args) }
export { selectionText }
export function createUpstreamDock(...args) { return upstreamDock(...args) }
export function createDockFallbackToggle(...args) { return fallbackToggle(...args) }

const PREFIX = 'dsh-resource://desktop-terminal/'
const text = {
  get 'terminal-directory'() { return t('启动目录不存在或不可访问，可选择在主目录重试。') },
  get 'terminal-shell-missing'() { return t('未找到所选 shell，请选择其他 shell。') },
  get 'terminal-start'() { return t('启动失败，请检查 shell 和目录后重试。') },
  get 'terminal-session-limit'() { return t('最多可同时保留 16 个终端，请先关闭其他终端。') },
  get 'terminal-input-limit'() { return t('单次输入不能超过 64 KiB。') },
  get 'terminal-input-busy'() { return t('终端输入繁忙，请稍后重试。') },
  get 'terminal-buffer-full'() { return t('输出缓存已满，已暂停读取。重新启动终端可释放缓存。') },
  get 'terminal-control'() { return t('输入已切换到另一个标签，点击此终端重新取得控制权。') },
  get 'terminal-layout'() { return t('当前 DSH 标签接口不兼容，无法安全启动终端。') },
}
const explain = e => text[String(e)] || t('桌面连接中断，请重新连接。')
const invoke = (command, args = {}) => {
  const identity = window.__DSH_TERMINAL_IDENTITY__
  if (!identity || !window.__TAURI__?.core?.Channel) return Promise.reject('terminal-unavailable')
  return window.__TAURI__.core.invoke(command, { identity, ...args })
}
const wire = info => ({ terminalId: info.terminalId, runId: info.runId })
const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0))
const status = info => ({ get starting() { return t('创建中') }, get running() { return t('运行中') }, get failed() { return t('启动失败') }, exited: t('已退出（') + (info?.exitCode ?? '?') + '）' })[info?.state] || t('重新连接中')

/**
 * The four tones the dot can take.
 *
 * Keyed on the SAME state string {@link status} reads, so the dot and the state
 * word can never disagree about which state the terminal is in — and it takes the
 * state rather than the info object for exactly that reason: `offline` is a state
 * this surface reports with no info behind it at all, so a tone derived from
 * `info` would have had to special-case it and could then drift from the word.
 *
 * `idle` is the settled group (已退出, and a page with no desktop bridge): painting
 * a normal exit red would say a failure happened when none did. A NON-ZERO exit code
 * is deliberately in that group too — the terminal did its job, it is the command
 * that failed, and the code is spelled out in the state word and the tooltip. The
 * dot reports the health of the SURFACE, not the success of what ran inside it.
 */
const TONES = { starting: 'busy', running: 'ok', failed: 'bad', exited: 'idle', offline: 'idle' }

/**
 * The tone for a state, ESCALATED by a live condition.
 *
 * `state` alone cannot colour the dot, and that is the whole reason for the second
 * parameter. It is the protocol's word for WHERE the terminal is, and it stays
 * truthful straight through a mid-run failure: a broken IPC channel, a
 * `terminal_write` refused for a stale epoch, and a session that stopped reading all
 * leave `state: 'running'` and put the reason in `message` instead. A dot keyed on
 * state alone therefore stayed GREEN through exactly the conditions the user has to
 * notice.
 *
 * That was survivable while the reason had a row of its own under the panel. It has
 * none now — see {@link presentation} — so the dot is the only thing left on screen
 * that can say something is wrong, and the tooltip is where the reason lives. A live
 * condition therefore wins over the state, and only ever upward: `bad` is not a
 * claim about the state, it is "look here, and hover for why".
 *
 * AMBER IS DELIBERATELY NOT USED FOR A CONDITION. `busy` already means "in flight,
 * working on it" (创建中 / 重新连接中), so a condition toned `busy` would read as
 * progress at exactly the moment the user has to intervene.
 */
const tone = (state, condition) => condition ? 'bad' : TONES[state] || 'busy'

/**
 * The screen's ink, wearing the terminal style Codex's TUI brings with it.
 *
 * MEASURED, NOT INVENTED. Codex reads the host terminal's palette wherever it
 * can, so what "Codex's terminal" contributes is exactly the set of colours its
 * own source carries. Every value below is transcribed from openai/codex:
 *
 * - The accent is ChatGPT Blue 200 (`UI_ACCENT`, `#63A8F8`) on a dark background
 *   and `LIGHT_BG_ACCENT_RGB` (`#1C64C8`) on a light one
 *   (`codex-rs/tui/src/style.rs`). It becomes the cursor.
 * - A selection fills with the same blues - Blue 200 on dark, Blue 100
 *   (`CHATGPT_BLUE_100`, `#A4CDFB`) on light - and resolves its text to
 *   `(0, 0, 46)` over either fill (`codex-rs/tui/src/style/contrast.rs`,
 *   `selection_style`). Codex also bolds the ink; xterm's theme has no
 *   selection-weight knob, so the fill and the ink carry the look.
 * - The sixteen ANSI cells are Catppuccin Mocha and Latte, the adaptive default
 *   syntax themes Codex falls back to when none is configured
 *   (`codex-rs/tui/src/render/highlight.rs`,
 *   `adaptive_default_theme_selection`: Mocha on a dark background, Latte on a
 *   light one), in the mappings of Catppuccin's own terminal port - its
 *   `purple` lands on xterm's `magenta`, and each bright cell repeats the
 *   normal one except black and white.
 *
 * What Codex does NOT bring stays where it was: the background and default
 * foreground still come from the surface, and the background is the app's own
 * two themes by design - the one thing this style deliberately does not copy.
 */
const CODEX_ACCENT = { dark: '#63a8f8', light: '#1c64c8' }
const CODEX_SELECTION = { dark: '#63a8f8', light: '#a4cdfb', ink: '#00002e' }

/**
 * The cursor is a BAR, and this is how wide it is.
 *
 * xterm's own default is a `block` filled with the accent, so the caret was a
 * solid rectangle covering the whole character cell - the heaviest mark on the
 * screen, sitting on top of the glyph rather than beside it. A bar is the shape
 * the editors in this window already use, and it leaves the character under the
 * caret readable.
 *
 * MEASURED, at `fontSize: 13` in Cascadia Mono in this window's real engine: the
 * cell advances **7.62px** (xterm's own 32-character measurement span, whose
 * rendered row box agrees at 7.61), so the number below is read against that and
 * not guessed. The bar is **4px** - a little over half the cell.
 *
 * WHY NOT THINNER. `cursorWidth` is an inset `box-shadow` spread on the cursor
 * span, so it is a CSS-pixel length that the display's device pixel ratio scales:
 * a literal 1-2px bar lands on 1-3 physical pixels depending on the screen. There
 * is also no finer value to inherit - xterm's own default is 1, and the option
 * throws below that. At 4px the bar is still a bar at 1x, 1.25x, 1.5x and 2x, and
 * stays unambiguously narrower than the 7.62px cell it replaces instead of
 * collapsing into a hairline on a HiDPI panel.
 *
 * `cursorInactiveStyle: 'bar'` is the same decision for the unfocused state, where
 * xterm's `outline` default would box the whole cell - a hollow version of the
 * block the bar exists to remove, and a heavier mark than the bar that replaces it.
 * `cursorBlink` stays at its `false` default: a steady caret, which is what this
 * terminal drew before.
 *
 * `tools/_cursorprobe.mjs` measures all of it against the SHIPPED bundle in a real
 * engine, and reports the block it replaced beside it.
 */
const CURSOR_STYLE = { cursorStyle: 'bar', cursorWidth: 4, cursorInactiveStyle: 'bar' }
// In xterm's ITheme key order: black, red, green, yellow, blue, magenta, cyan, white.
const CATPPUCCIN_MOCHA = ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']
const CATPPUCCIN_LATTE = ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#acb0be', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc']

/**
 * The Shell control's pill, wearing 通用设置's own selector.
 *
 * MEASURED, NOT INVENTED. The app's settings rows render their value selector as
 * a button with `background: var(--dsw-alias-bg-module-platform)`, `height: 36px`,
 * `border: none`, `border-radius: 18px`, `padding: 0 14px`, `gap: 12px` at
 * `font-size: 14px` — the same rule appears verbatim in
 * `dsh-client-ui-permission-presets`, `-locale`, `-theme` and `-chat`, i.e. it is
 * the app's shared selector idiom rather than one row's private styling. So the
 * shell picker reads as a settings control because it IS one, down to the radius
 * and the token, rather than by eye.
 *
 * THE CLOSED CONTROL IS A `<button>`, and its popup is the app's `Menu` — the
 * same pair every settings selector is. This used to be a native `<select>`: the
 * pill looked right, but WebView2 matches `:focus-visible` on a `<select>` even
 * for a plain mouse click (every click drew the thick keyboard ring), and the
 * engine's popup list is a different surface from the menu 通用设置's selectors
 * open. A pill button + `Menu` fixes both, exactly as `ui-client/client.js` does
 * for the font-size selector.
 *
 * THE STYLE IS SHARED BY BOTH PATHS. When the `Menu` primitive is unavailable the
 * control falls back to the native `<select>` it used to be — same pill, the
 * engine's own popup list. `appearance: none` removes the engine's chrome in that
 * path so the pill is the whole control, and the chevron is drawn back in as a
 * background image — the same technique `settings-models` uses for its
 * `selectInput`, with the app's own 12x12 chevron path and its stroke colour.
 */
const SHELL_SELECT = {
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: '14px',
  lineHeight: '22px',
  cursor: 'pointer',
  border: 'none',
  borderRadius: '18px',
  padding: '0 34px 0 14px',
  height: '36px',
  maxWidth: '180px',
  flex: '0 0 auto',
  appearance: 'none',
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 14px center',
  backgroundSize: '12px 12px',
}

// One registry per plugin load, one xterm consumer per native tab occurrence.
// Consumers survive React unmounts. Only removal of the last owner closes a PTY.
export function createRegistry(ctx, preferences) {
  const views = new Map(), stores = new Map(), listeners = new Set(), held = new Set()
  let native = [], references = new Set(), disposed = false, opening = new Map()
  let layoutError = null, generation = 0, nativeReady = false
  const emit = () => listeners.forEach(fn => fn())
  const refresh = async () => {
    if (!window.__DSH_TERMINAL_IDENTITY__) return
    try {
      const listed = await invoke('terminal_list')
      if (!disposed) { native = listed; nativeReady = true; emit() }
    } catch { /* retried on desktop ready */ }
  }
  const reconcile = () => {
    if (disposed) return
    const next = new Set(held)
    for (const { store } of stores.values()) {
      for (const surface of Object.values(store.getSnapshot().bySession || {})) {
        for (const tab of Object.values(surface.layout.tabs || {})) if (tab.contentId.startsWith(PREFIX)) next.add(tab.contentId)
      }
    }
    // Initial emptiness is never permission to delete recovered native sessions.
    for (const key of references) if (!next.has(key)) {
      const close = async () => {
        await opening.get(key)?.catch(() => {})
        if (disposed || references.has(key)) return
        const session = native.find(s => s.resourceKey === key)
        if (session && !disposed && !references.has(key)) {
          await invoke('terminal_close', wire(session)).catch(() => {})
          native = native.filter(s => s.terminalId !== session.terminalId)
        }
        for (const [id, v] of views) if (v.key === key) { v.dispose(); views.delete(id) }
        emit()
      }
      queueMicrotask(close)
    }
    references = next; emit()
  }
  function track() {
    try {
      const entry = ctx.slots.entriesOfSlot('rightbar.session')[0]
      const handle = entry?.store || entry?.options?.store
      if (!handle?.create) throw new Error('terminal-layout')
      const list = ctx.sessions.list.getSnapshot()
      if (list.phase !== 'ready') return
      for (const sessionId of list.ids) if (!stores.has(sessionId)) {
        // resolveStore reuses the framework's live instance; handle.create mints a
        // detached store and also replaces the sidebar controller's adoption.
        const scope = ctx.sessions.scope(sessionId)
        if (!scope) continue
        const store = ctx.slots.resolveStore(handle, { key: sessionId, ctx: scope })
        if (!store?.subscribe || !store?.getSnapshot) throw new Error('terminal-layout')
        stores.set(sessionId, { store, off: store.subscribe(reconcile) })
      }
      for (const [sessionId, held] of stores) if (!list.ids.includes(sessionId)) { held.off(); stores.delete(sessionId) }
      layoutError = null; reconcile()
    } catch { layoutError = 'terminal-layout' }
  }
  function cwd() {
    const sessions = ctx.sessions.list.getSnapshot(), workspaces = ctx.workspaces.list.getSnapshot()
    if (sessions.phase !== 'ready' || workspaces.phase !== 'ready') throw new Error(t('项目列表尚未就绪，请稍后重试。'))
    const current = currentSessionId(sessions)
    return workspaces.items.find(w => w.sessionIds.includes(current))?.path || sessions.byId?.[current]?.cwd || null
  }
  async function open(key, profileId, home = false, recoverOnly = false, directory) {
    if (layoutError) throw layoutError
    if (recoverOnly) {
      const existing = native.find(s => s.resourceKey === key)
      if (!existing) throw 'terminal-unavailable'
      return existing
    }
    // The preferences choose WHICH shell opens and where the panel sits. They are
    // never a reason to refuse a terminal: a scope the Host cannot carry (every
    // non-loopback page — see `createPreferences`) or a disposed one leaves the
    // defaults in place and the PTY still opens.
    await preferences?.ready().catch(() => {})
    if (disposed || !references.has(key)) throw 'terminal-unavailable'
    const preferred = profileId || preferences?.getSnapshot().profileId
    if (!opening.has(key)) {
      const promise = invoke('terminal_open', { resourceKey: key, profileId: preferred === 'auto' ? null : preferred || null, cwd: home ? null : directory === undefined ? cwd() : directory }).then(info => {
        native = native.filter(s => s.resourceKey !== key).concat(info); emit(); return info
      }).finally(() => opening.delete(key))
      opening.set(key, promise)
    }
    return opening.get(key)
  }
  function matchesProfile(key, profileId) {
    if (profileId === 'auto') return true
    const info = native.find(s => s.resourceKey === key)
    const view = [...views.values()].find(v => v.key === key)
    return (info?.profileId || view?.profileId || preferences?.getSnapshot().profileId) === profileId
  }
  function view(tab) {
    let v = views.get(tab.signal)
    if (v) return v
    v = createView(tab.contentId, (key, profile, home, startNew) => open(key, profile, home, tab.recovered && !startNew, tab.cwd), refresh, emit)
    views.set(tab.signal, v)
    return v
  }
  const offSessions = ctx.sessions.list.subscribe(track)
  const ready = () => { generation++; track(); refresh(); views.forEach(v => { if (v.mounted) v.connect() }) }
  window.addEventListener('dsh-terminal-ready', ready)
  track(); refresh()
  const timer = setInterval(() => { track(); refresh() }, 5000)
  return {
    view, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    async snapshotSessions() {
      await Promise.all([...opening.values()]);
      const listed = await invoke('terminal_list')
      if (disposed) throw Error('terminal-unavailable')
      native = listed; nativeReady = true; emit()
      return listed
    },
    matchesProfile,
    focus(key) { for (const v of views.values()) if (v.key === key && v.element?.isConnected) v.focus() },
    /**
     * The live view for a resource key, for the smoke harness only.
     *
     * A selection cannot be made with a pointer in a headless run — xterm takes it
     * from pointer events and `selectAll` has no chord — so the only way to prove
     * what 复制 puts on the clipboard is to reach the view. Guarded by the same
     * smoke flag as `__DSH_TERMINAL_SMOKE__`.
     */
    viewFor(key) { if (!window.__DSH_UI_BOOT__?.smoke) return null; for (const v of views.values()) if (v.key === key) return v; return null },
    openSidebar(profileId) {
      track()
      const sessionId = currentSessionId(ctx.sessions.list.getSnapshot())
      const surface = stores.get(sessionId)?.store.getSnapshot().bySession?.[sessionId]
      const tabs = Object.values(surface?.layout.tabs || {})
      const active = ctx.sidebarRight.active()
      const candidates = [active, ...tabs].filter(tab => tab?.contentId?.startsWith(PREFIX))
      const tab = candidates.find(tab => matchesProfile(tab.contentId, profileId))
      const key = tab?.contentId || PREFIX + 'shortcut-' + crypto.randomUUID()
      ctx.sidebarRight.openResource(key)
      return key
    },
    hold(key) { if (!disposed && key.startsWith(PREFIX)) { held.add(key); reconcile() } },
    release(key) { held.delete(key); reconcile() },
    // null means the bridge has not successfully listed sessions yet. Recovery
    // must wait for a real empty list rather than dropping saved keys offline.
    get sessions() { return nativeReady ? native : null },
    orphans: () => native.filter(s => !references.has(s.resourceKey)),
    restore: info => ctx.sidebarRight.openResource(info.resourceKey, { revealIfOpened: false }),
    close: async info => { await invoke('terminal_close', wire(info)); await refresh() },
    get generation() { return generation },
    dispose() { disposed = true; clearInterval(timer); offSessions(); stores.forEach(s => s.off()); window.removeEventListener('dsh-terminal-ready', ready); views.forEach(v => v.dispose()); views.clear() },
  }
}

function createView(key, open, refresh, emit) {
  const term = new Terminal({
    cols: 80, rows: 24, scrollback: 10000, fontSize: 13, fontFamily: 'Cascadia Mono, Consolas, monospace',
    ...CURSOR_STYLE,
    allowProposedApi: false, allowTransparency: true, windowsPty: { backend: 'conpty' },
  })
  const fit = new FitAddon(); term.loadAddon(fit)
  const element = document.createElement('div'); element.className = 'dshTerminal__screen'
  // open() needs a connected element. The owner mounts it lazily on first render.
  let mounted = false, dead = false, info = null, attachment = null, epoch = null
  let seq = 0, serial = Promise.resolve(), connecting = null, connection = 0, message = '', profiles = [], profileId = null
  let acked = 0, focused = false, replaying = true, queued = 0, input = Promise.resolve(), sizing = false, acquiring = null
  const viewId = crypto.randomUUID()
  const call = (name, args) => invoke(name, { ...wire(info), attachmentId: attachment, ...args })
  const fail = error => { message = explain(error); if (!['terminal-input-limit','terminal-input-busy'].includes(String(error))) epoch = null; emit() }
  /**
   * The selection as the clipboard should hold it: padding stripped.
   *
   * ONE READER, so every copy path agrees — the 复制 item, Ctrl+C, and xterm's own
   * copy handling, which is redirected here by {@link installSelectionTrim}.
   */
  const copyText = () => selectionText(term.getSelection())
  const writeClipboard = text => window.__TAURI__.core.invoke('clipboard_write_text', { text })
  /**
   * Make xterm's OWN copy put the trimmed selection on the clipboard.
   *
   * WHY A REDIRECT AND NOT AN EVENT LISTENER. xterm answers the browser's `copy`
   * event itself, and it does not ask `getSelection()`: its handler reads
   * `selection.selectionText` — a GETTER on the selection service — and writes
   * that padded value with `clipboardData.setData`. A listener of ours that writes
   * the trimmed text first therefore loses, and that is measured rather than
   * assumed: with a capture listener on the screen element (which does run first)
   * the clipboard still held the padded selection, because the transfer commits as
   * the dispatch settles and xterm writes later within it. Overriding
   * `getSelection()` alone changes nothing for the same reason.
   *
   * So the ONE value every reader converges on is that getter. The service is
   * created by `term.open()` (`_selectionService` does not exist before it), so
   * the redirect is installed there, and re-installed if xterm ever replaces the
   * service. The raw text stays reachable for the smoke harness, which is the only
   * reader that wants what xterm itself would have said.
   */
  let service = null
  let rawGetter = () => ''
  const rawSelection = () => rawGetter()
  const redirectSelection = () => {
    const found = term._core?._selectionService
    if (!found || found === service) return
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(found), 'selectionText')
    if (!descriptor?.get) return
    service = found
    // The prototype's own getter, kept for readers that want what xterm itself
    // would have said. Reading `service.selectionText` here would snapshot the
    // (empty) selection instead of reading it through.
    rawGetter = () => descriptor.get.call(found)
    Object.defineProperty(found, 'selectionText', { configurable: true, get: () => selectionText(rawGetter()) })
  }
  /** The 复制 menu item: the same trimmed text, written directly. */
  const copy = () => writeClipboard(copyText())
  const paste = async () => { const value = await window.__TAURI__.core.invoke('clipboard_read_text'); term.paste(value) }
  const theme = () => {
    const surface = element.closest('.dshTerminal')
    if (!element.isConnected || !surface) return
    // xterm needs resolved colours; reading its container also matches the
    // padding and unused space below the last full row in either UI mode.
    // The surface keeps the background (the app's own two themes) and the
    // default foreground; Codex's terminal style supplies the rest - see the
    // CODEX_* / CATPPUCCIN_* tables above.
    const style = getComputedStyle(surface)
    const dark = document.body.hasAttribute('data-ds-dark-theme') || getComputedStyle(document.documentElement).colorScheme.includes('dark') || document.documentElement.getAttribute('data-theme') === 'dark' || document.documentElement.classList.contains('dark')
    const cells = dark ? CATPPUCCIN_MOCHA : CATPPUCCIN_LATTE
    term.options.theme = {
      background: style.backgroundColor, foreground: style.color,
      cursor: dark ? CODEX_ACCENT.dark : CODEX_ACCENT.light,
      // Unused by the bar cursor this view installs - `cursorWidth` paints the bar
      // in `cursor` and there is no glyph underneath to knock out. It is kept
      // because Codex's own intent is on record here and the theme is otherwise
      // transcribed value for value: Codex's composer cursor is a block, and
      // `cursorAccent` is the half of that look which turns the character under a
      // block into background-on-accent. A shell can still select a block for
      // itself with DECSCUSR, which is the case this colour is waiting for.
      cursorAccent: style.backgroundColor,
      selectionBackground: dark ? CODEX_SELECTION.dark : CODEX_SELECTION.light,
      selectionForeground: CODEX_SELECTION.ink,
      black: cells[0], red: cells[1], green: cells[2], yellow: cells[3],
      blue: cells[4], magenta: cells[5], cyan: cells[6], white: cells[7],
      brightBlack: cells[8], brightRed: cells[9], brightGreen: cells[10], brightYellow: cells[11],
      brightBlue: cells[12], brightMagenta: cells[13], brightCyan: cells[14], brightWhite: cells[15],
    }
  }
  const send = data => {
    if (dead || epoch === null || replaying || info?.state !== 'running') return
    const heldEpoch = epoch, heldConnection = connection
    const length = new TextEncoder().encode(data).length
    if (length > 65536 || queued + length > 65536) return fail('terminal-input-limit')
    queued += length
    input = input.then(async () => { if (heldConnection === connection && heldEpoch === epoch) await call('terminal_write', { epoch: heldEpoch, data }) }).catch(fail).finally(() => { queued -= length })
  }
  term.onData(send)
  // OSC 52 and link activation have no native integrations. xterm only renders.
  term.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.isComposing) return true
    // A selection turns Ctrl+C into Copy, and the chord must not ALSO reach the
    // shell as ^C — copying a command would cancel it. With nothing selected the
    // plain chord keeps its shell meaning; the shifted one is still swallowed,
    // because a copy chord with nothing to copy must not interrupt either.
    // AltGr is excluded so layouts that type a letter through AltGr+C keep it.
    if (event.ctrlKey && !event.altKey && event.code === 'KeyC') {
      if (!event.shiftKey && !term.hasSelection()) return true
      event.preventDefault()
      if (term.hasSelection()) copy().catch(fail)
      return false
    }
    if (event.ctrlKey && event.code === 'KeyV') { event.preventDefault(); paste().catch(fail); return false }
    return true
  })
  // The right-click menu (复制/粘贴) is plain DOM rather than the app's `Menu`:
  // views are created without React, and both surfaces share this one element.
  // It is appended INSIDE the screen element on purpose — `focusout` releases
  // input control only when focus leaves THIS element, so a body-portalled menu
  // would drop the grant between the right-click and the paste it serves.
  let context = null
  const dismissContext = () => {
    if (!context) return
    if (context.shared) { const previous = context; context = null; previous.dismiss(false); return }
    const { menu, outside, escape } = context
    context = null
    menu.remove()
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', escape, true)
  }
  const openContext = event => {
    event.preventDefault()
    event.stopPropagation()
    dismissContext()
    if (dead) return
    const selected = copyText()
    const shared = window.__DSH_TEXT_MENU__?.(event, [
      { label: t('复制'), key: 'C', enabled: term.hasSelection(), run: () => writeClipboard(selected) },
      { label: t('粘贴'), key: 'V', enabled: info?.state === 'running', run: async () => { focused = true; await acquire(); await paste() } },
      { label: t('全选'), key: 'A', enabled: true, run: () => term.selectAll() },
    ], {
      scope: element, parent: element, restore: () => term.focus(), onError: fail,
      onDismiss: () => { context = null },
    })
    if (shared) { context = { ...shared, shared: true }; return }
    const menu = document.createElement('div')
    menu.className = 'dshTerminal__context'
    menu.setAttribute('role', 'menu')
    // Paste waits for the input grant instead of trusting this instant: the
    // right-click that opened the menu already asked for one (the pointerdown
    // listener), and pasting before it lands would silently drop the text.
    const items = [
      { label: t('复制'), enabled: term.hasSelection(), run: () => { copy().catch(fail); term.focus() } },
      { label: t('粘贴'), enabled: !dead && info?.state === 'running', run: () => { focused = true; Promise.resolve(acquire()).then(paste).catch(fail); term.focus() } },
    ]
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.disabled = !item.enabled
      button.addEventListener('click', () => { dismissContext(); item.run() })
      menu.append(button)
    }
    element.append(menu)
    // The menu is fixed to the pointer; clamp it into the viewport now that it
    // has been measured.
    const rect = menu.getBoundingClientRect()
    menu.style.left = Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4)) + 'px'
    menu.style.top = Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4)) + 'px'
    const outside = e => { if (!menu.contains(e.target)) dismissContext() }
    const escape = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissContext(); term.focus() } }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    context = { menu, outside, escape }
  }
  element.addEventListener('contextmenu', openContext)
  async function acquire() {
    if (!attachment || dead || info?.state !== 'running') return
    if (acquiring) return acquiring
    if (epoch !== null && !replaying) return
    const heldConnection = connection, heldAttachment = attachment
    // pointerdown, focusin and replay acknowledgements can arrive together.
    // Each native grant advances the epoch, so issuing them concurrently could
    // invalidate input queued with the first grant before the next one returns.
    acquiring = (async () => {
      try {
        const granted = await call('terminal_control')
        if (dead || heldConnection !== connection || heldAttachment !== attachment || !focused) return
        epoch = granted; replaying = false; message = ''; fitSize(); emit()
      } catch (e) { if (String(e) !== 'terminal-syncing') fail(e) }
    })().finally(() => { acquiring = null })
    return acquiring
  }
  function fitSize() {
    if (sizing || epoch === null || replaying || !element.isConnected || !element.getBoundingClientRect().width) return
    sizing = true
    requestAnimationFrame(async () => {
      try {
        const size = fit.proposeDimensions()
        if (size && size.cols >= 2 && size.rows >= 1 && (size.cols !== term.cols || size.rows !== term.rows)) await call('terminal_resize', { epoch, cols: Math.min(size.cols, 500), rows: Math.min(size.rows, 300) })
      } catch (e) { fail(e) } finally { sizing = false }
    })
  }
  async function connect(home = false, startNew = false) {
    if (dead) return
    if (connecting) return connecting
    const attempt = ++connection
    connecting = (async () => {
      message = ''; replaying = true; epoch = null; emit()
      if (attachment && info) await call('terminal_detach').catch(() => {})
      attachment = null
      await serial.catch(() => {}); term.reset(); seq = 0; acked = 0
      profiles = await invoke('terminal_profiles')
      // Closing during profile discovery must not create an ownerless PTY once
      // that asynchronous call completes. In-flight opens are handled by reconcile.
      if (dead || attempt !== connection) return
      info = await open(key, profileId, home, startNew); profileId ||= info.profileId
      if (dead || attempt !== connection) return
      let received = []
      const channel = new window.__TAURI__.core.Channel()
      const consume = packet => {
        serial = serial.then(async () => {
          if (dead || attempt !== connection || packet.terminalId !== info.terminalId || packet.runId !== info.runId || packet.attachmentId !== attachment) return
          if (packet.type === 'data') {
            if (packet.seq !== seq + 1) throw 'terminal-sequence'
            if (packet.record.kind === 'resize') term.resize(packet.record.cols, packet.record.rows)
            else await new Promise(resolve => term.write(bytes(packet.record.data), resolve))
            seq = packet.seq
            await call('terminal_ack', { seq }); acked = seq
            // The server grants control only when all queued output is consumed.
            if (replaying && focused) await acquire()
          } else {
            // AN ORDERED STATE PACKET IS DELIBERATELY EXEMPT FROM THE SEQUENCE
            // GUARD ABOVE, and applying it here is what broke the terminal.
            //
            // `seq` numbers DATA records only. A state packet carries the seq of
            // the last data record sent — see `pump` in `terminal/session.rs`,
            // which stamps `Body::State` with `a.sent` — so it can repeat a
            // number already consumed, and does: a shell reports `starting` and
            // then `running` while the journal still holds only its initial
            // resize record, so the second state packet arrives at the same
            // seq the first one had. Rejecting that as out-of-order threw
            // `terminal-sequence`, which `fail()` renders as 桌面连接中断,
            // and the epoch is never granted — a terminal that paints its chrome
            // and refuses every keystroke.
            info = packet.info; if (info.error) message = explain(info.error); emit()
          }
        }).catch(fail)
      }
      channel.onmessage = packet => { if (!attachment) received.push(packet); else consume(packet) }
      attachment = await invoke('terminal_attach', { ...wire(info), viewId, channel })
      if (dead || attempt !== connection) { await call('terminal_detach').catch(() => {}); return }
      received.forEach(consume); received = null
      message = ''; emit()
    })().catch(fail).finally(() => { connecting = null; emit() })
    return connecting
  }
  const heartbeat = setInterval(async () => {
    if (dead || !attachment || connecting || !info) return
    try { await call('terminal_ack', { seq: acked }); if (focused && epoch === null) await acquire() } catch (e) { epoch = null; message = explain(e); emit() }
  }, 3000)
  const observer = new ResizeObserver(fitSize)
  const themes = new MutationObserver(theme)
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ['class','data-theme','style','data-dsh-ui'] })
  themes.observe(document.body, { attributes: true, attributeFilter: ['class','data-theme','data-ds-dark-theme','style'] })
  element.addEventListener('pointerdown', () => { focused = true; acquire() })
  element.addEventListener('focusin', () => { focused = true; window.__DSH_TERMINAL_EDIT__ = { copy, paste, hasSelection: () => term.hasSelection(), element }; acquire() })
  element.addEventListener('focusout', e => { if (!element.contains(e.relatedTarget)) { focused = false; epoch = null } })
  const clearEdit = event => { if (!element.contains(event.target) && !event.target.closest?.('.dshTb')) { if (window.__DSH_TERMINAL_EDIT__?.element === element) delete window.__DSH_TERMINAL_EDIT__ } }
  document.addEventListener('pointerdown', clearEdit, true)
  return {
    key, element, get info() { return info }, get message() { return message }, get profiles() { return profiles },
    get mounted() { return mounted },
    get readyForInput() { return !dead && epoch !== null && !replaying && !sizing && info?.state === 'running' },
    get profileId() { return profileId }, set profileId(value) { profileId = value },
    focus() { term.focus() },
    /** Select everything on screen — the smoke harness's deterministic drag. */
    selectAll() { term.selectAll() },
    /** A selection dragged from a cell across the rest of the row, for the same
     *  reason: a headless run cannot produce pointer events. Smoke-only. */
    selectRange(column, row, length) { if (window.__DSH_UI_BOOT__?.smoke) term.select(column, row, length) },
    /** Whether xterm is in rectangular (block) selection mode — Alt+drag's mode,
     *  whose text pads every row to the block's right edge. Smoke-only. */
    selectionMode() { return window.__DSH_UI_BOOT__?.smoke ? term._core?._selectionService?._activeSelectionMode : undefined },
    /** The buffer as the harness reads it, so a test can find the line it printed. */
    buffer() {
      if (!window.__DSH_UI_BOOT__?.smoke) return []
      const active = term.buffer.active, lines = []
      for (let index = 0; index < active.length; index++) {
        const line = active.getLine(index)
        if (line) lines.push({ index, text: line.translateToString(true) })
      }
      return lines
    },
    /** Type through the surface's own input path, exactly as a keystroke would. */
    type(data) { send(data) },
    /** The text the surface would copy right now: the selection, padding removed.
     *  Smoke-only, and the same helper the clipboard paths use. */
    copyText() { return window.__DSH_UI_BOOT__?.smoke ? copyText() : '' },
    /** The RAW selection, before trimming: what xterm itself would have put on the
     *  clipboard. Smoke-only, so the harness can prove the two differ. */
    rawSelection() { return window.__DSH_UI_BOOT__?.smoke ? rawSelection() : '' },
    mount(parent) { parent.append(element); if (!mounted) { mounted = true; term.open(element); redirectSelection(); observer.observe(element); theme(); connect() } else { theme(); fitSize() } term.focus() },
    unmount() { focused = false; epoch = null; dismissContext(); if (window.__DSH_TERMINAL_EDIT__?.element === element) delete window.__DSH_TERMINAL_EDIT__; element.remove() },
    clear() { term.clear() }, connect,
    async restart(home = false) {
      try {
        if (info) await invoke('terminal_restart', { ...wire(info), profileId, home })
        info = null; attachment = null; await refresh(); return connect(home, true)
      } catch (e) { fail(e) }
    },
    dispose() { if (dead) return; dead = true; connection++; dismissContext(); clearInterval(heartbeat); observer.disconnect(); themes.disconnect(); document.removeEventListener('pointerdown', clearEdit, true); if (window.__DSH_TERMINAL_EDIT__?.element === element) delete window.__DSH_TERMINAL_EDIT__; if (attachment && info) call('terminal_detach').catch(() => {}); term.dispose(); element.remove() },
  }
}

/** Shared state and controls; each surface chooses where to put them. */
export function createTerminalUI(React, primitives) {
  const h = React.createElement, Menu = primitives?.Menu, Tooltip = primitives?.Tooltip
  function presentation(v, desktop, fallback) {
    const info = v?.info || fallback
    const state = desktop ? (info?.state || (v?.message ? 'failed' : 'offline')) : 'offline'
    const word = desktop ? status(info || { state }) : t('桌面连接不可用')
    // Every reason the terminal can be unwell, in the order they should be read:
    // the live message first (it is the newest fact), then the protocol's own error,
    // then the back-pressure note. `message` is what `fail()` writes, and it is the
    // ONLY place several conditions exist at all — a refused write and a dropped
    // channel never reach `info`.
    const notes = [...new Set([v?.message, info?.error && explain(info.error), info?.paused && text['terminal-buffer-full']].filter(Boolean))]
    // ── THE REASON HAS NO ROW ────────────────────────────────────────────────
    //
    // The user asked for the visible condition line to go: a terminal that has gone
    // wrong should say so with the DOT's colour and spell the reason out in a
    // tooltip on hover, not push a sentence into the layout. So `tip` (the right
    // column's status tooltip) and `description` (the dock's per-tab tooltip, its
    // `aria-label` and its screen-reader span) are the only carriers, and the fields
    // that used to hold the text — `notice` here, `.dshTerminalDock__notice` there —
    // are deleted rather than left as empty strings. A field nothing reads is how a
    // later reader comes to believe a removed surface still exists.
    const tip = [info?.cwd && t('启动目录：') + info.cwd, ...notes].filter(Boolean).join('\n')
    // The tone is escalated by a live condition, not by the state word — see `tone`.
    return { state, word, tone: tone(state, notes.length > 0), tip, description: [word, tip].filter(Boolean).join('\n') }
  }
  // A hook returning the controls directly keeps the two surfaces on the same
  // actions, selected profile and host Menu without imposing a header component.
  function useControls(v, bump, { collapse, dock = false } = {}) {
    const [open, setOpen] = React.useState(false)
    const [shellOpen, setShellOpen] = React.useState(false)
    const triggerRef = React.useRef(null), fallbackRef = React.useRef(null), shellRef = React.useRef(null)
    const dismiss = () => { setOpen(false); triggerRef.current?.focus() }
    const dismissShell = () => { setShellOpen(false); shellRef.current?.focus() }
    React.useEffect(() => { setOpen(false); setShellOpen(false) }, [v])
    React.useEffect(() => {
      if (!open || Menu) return
      const pointer = e => { if (!fallbackRef.current?.contains(e.target)) setOpen(false) }
      document.addEventListener('pointerdown', pointer)
      fallbackRef.current?.querySelector('[role="menuitem"]')?.focus()
      return () => document.removeEventListener('pointerdown', pointer)
    }, [open])
    const items = [
      { id: 'clear', label: t('清空'), hint: t('清空显示'), disabled: !v },
      { id: 'reconnect', label: t('重连'), hint: t('重新连接现有进程'), disabled: !v },
      { id: 'restart', label: t('重启'), hint: t('结束当前进程树并启动新 shell'), disabled: !v },
      ...(/目录/.test(String(v?.message || '')) ? [{ id: 'home', label: t('在主目录重试') }] : []),
      ...(collapse ? [{ id: 'collapse', label: t('收起面板') }] : []),
    ]
    const run = id => {
      if (id === 'collapse') { setOpen(false); collapse(); return }
      if (!v) return
      dismiss()
      const action = { clear: () => v.clear(), reconnect: () => v.connect(), restart: () => v.restart(), home: () => v.restart(true) }[id]
      if (action) Promise.resolve(action()).catch(() => {})
    }
    // The Shell control as 通用设置's selector: a pill button whose popup is the
    // app's `Menu`. The Menu does NOT close on selection — none of the app's own
    // selectors rely on it — so `pickShell` dismisses first, and a stale
    // `profileId` that matches no discovered profile reads as the first one,
    // which is what the fallback `<select>` shows in the same situation.
    const shellItems = v?.profiles.length
      ? v.profiles.map(p => ({ id: p.profileId, label: p.name }))
      : [{ id: '', label: t('默认终端') }]
    const shellLabel = shellItems.find(item => item.id === (v?.profileId || ''))?.label ?? shellItems[0]?.label ?? t('默认终端')
    const pickShell = id => { dismissShell(); if (v) { v.profileId = id; bump() } }
    const shellAnchor = h('button', {
      ref: shellRef, type: 'button', className: 'dshTerminal__shell', style: SHELL_SELECT, disabled: !v,
      'aria-label': t('新建或重新启动时使用的 shell'), title: t('新建或重新启动时使用的 shell'),
      'aria-haspopup': 'menu', 'aria-expanded': shellOpen,
      onClick: () => setShellOpen(!shellOpen),
      onKeyDown: e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setShellOpen(true) } },
    }, shellLabel)
    const shellControl = Menu
      ? h(Menu, {
          open: shellOpen, onClose: dismissShell, items: shellItems, selectedId: v?.profileId || '', onSelect: pickShell,
          // The pill sits at the row's right edge, so the panel hangs from that
          // edge — `align: 'end'`, the choice 通用设置's own selectors make for a
          // pill in the same spot. Portalled, so it is the same surface every
          // other dropdown is.
          portal: true, align: 'end',
          anchor: shellAnchor,
        })
      : h('select', {
          className: 'dshTerminal__shell', style: SHELL_SELECT, disabled: !v,
          'aria-label': t('新建或重新启动时使用的 shell'), title: t('新建或重新启动时使用的 shell'),
          value: v?.profileId || '', onChange: e => { if (v) { v.profileId = e.target.value; bump() } },
        }, v?.profiles.length ? v.profiles.map(p => h('option', { key: p.profileId, value: p.profileId }, p.name)) : h('option', { value: '' }, t('默认终端')))
    const trigger = h('button', {
      ref: triggerRef, type: 'button', className: 'dshTerminal__more', 'data-dsh-terminal-more': true,
      'aria-label': t('更多终端操作'), title: t('更多终端操作'), 'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: () => setOpen(!open), onKeyDown: e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true) } },
    }, '...')
    const keyMenu = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); dismissShell() }
      if (Menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const buttons = [...fallbackRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      e.preventDefault(); buttons[next]?.focus()
    }
    return h('span', { className: 'dshTerminal__actions', onKeyDown: keyMenu },
      (v || dock) && shellControl,
      (v || dock) && (Menu
        ? h(Menu, { open, onClose: dismiss, portal: true, align: 'end', dense: true, items, onSelect: run, anchor: trigger })
        : h('span', { className: 'dshTerminal__moreHost', ref: fallbackRef }, trigger,
            open && h('span', { className: 'dshTerminal__moreList', role: 'menu', style: dock && triggerRef.current ? { position: 'fixed', right: Math.max(4, window.innerWidth - triggerRef.current.getBoundingClientRect().right), bottom: Math.max(4, window.innerHeight - triggerRef.current.getBoundingClientRect().top + 4) } : undefined },
              items.map(a => h('button', { key: a.id, type: 'button', role: 'menuitem', disabled: a.disabled, title: a.hint, onClick: () => run(a.id) }, a.label))))),
      // The dock's own way out, immediately right of "...". Only the DOCK gets one:
      // the right sidebar's panel is closed by the kit's own chrome control in its
      // tab strip, so a second one there would be a duplicate rather than a
      // counterpart. See `collapse` in dock.mjs for why this is an icon button
      // while the panel's other actions stay in the menu.
      dock && collapse && h('button', {
        type: 'button', className: 'dshTerminal__collapse', 'data-dsh-terminal-collapse': true,
        'aria-label': t('收起底部侧边栏'), title: t('收起底部侧边栏'),
        onClick: () => { setOpen(false); collapse() },
      }, h('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'currentColor',
        'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: 'M3.85 5H12.15Q13 5 12.46 5.65L8.54 10.35Q8 11 7.46 10.35L3.54 5.65Q3 5 3.85 5Z' }))))
  }
  function tooltip(content, child) {
    return Tooltip ? h(Tooltip, { content }, child) : child
  }
  return { presentation, useControls, tooltip }
}

export function createBody(React, registry, primitives) {
  const h = React.createElement, ui = createTerminalUI(React, primitives)
  return function LiveTerminal({ tab }) {
      useLocale(React)
    const [, bump] = React.useReducer(n => n + 1, 0)
    const host = React.useRef(null)
    const desktop = Boolean(window.__TAURI__?.core?.Channel)
    const v = React.useMemo(() => desktop ? registry.view(tab) : null, [tab.signal, desktop])
    React.useEffect(() => registry.subscribe(bump), [])
    React.useLayoutEffect(() => { if (v && host.current) v.mount(host.current); return () => { if (v?.unmount) v.unmount(); else v?.element.remove() } }, [v])
    const data = ui.presentation(v, desktop), controls = ui.useControls(v, bump)
    const orphans = registry.orphans()
    return h('section', { className: 'dshTerminal', 'data-dsh-terminal': true, 'aria-label': t('终端') },
      h('header', { className: 'dshTerminal__header' },
        h('span', { className: 'dshTerminal__status', 'data-dsh-terminal-status': data.state, 'data-dsh-terminal-tone': data.tone, title: data.tip || undefined, role: 'status' },
          ' ', h('span', { className: 'dshTerminal__dot', 'aria-hidden': 'true' }), ' ' + data.word), controls),
      orphans.length > 0 && h('details', { className: 'dshTerminal__recovery' }, h('summary', null, t('恢复运行中的终端（') + orphans.length + '）'),
        orphans.map(s => h('div', { key: s.terminalId }, s.profileId + ' · ' + s.cwd, h('button', { onClick: () => registry.restore(s) }, t('恢复')), h('button', { onClick: () => registry.close(s) }, t('关闭'))))),
      h('div', { className: 'dshTerminal__viewport', ref: host }, !desktop && h('p', null, t('请在桌面应用中打开终端。'))))
  }
}

export function createDock(React, registry, primitives, isVanilla, settingsScope, ctx) {
  const store = createDockStore(registry, { settingsScope, workspaceSource: createDockWorkspaceSource(ctx) })
  return {
    store,
    Component: createDockComponent(React, registry, store, createTerminalUI(React, primitives), isVanilla),
    Toggle: createDockToggleComponent(React, store, isVanilla),
    dispose: () => store.dispose(),
  }
}

export function createUpstreamSettings(React, primitives, scope, ctx) {
  return settingsRows(React, primitives, createUpstreamPreferences(ctx, scope))
}

export function createSettings(React, primitives, scope) {
  return settingsRows(React, primitives, createPreferences(scope, () => invoke('terminal_profiles')))
}

function settingsRows(React, primitives, preferences) {
  return {
    preferences,
    ProfileRow: createSettingsRow(React, primitives, preferences, 'profileId', t('默认终端类型'), t('新建终端时使用的终端类型。')),
    PositionRow: createSettingsRow(React, primitives, preferences, 'position', t('终端显示位置'), t('按 Ctrl+~ 打开终端时使用的位置。')),
    dispose: () => preferences.dispose(),
  }
}

export function bindShortcut(registry, dock, preferences, onError) {
  return installShortcut(document, async () => {
    // Same rule as `open`: preferences choose the shell and the seat, so a scope
    // the Host cannot carry must fall back to the defaults rather than swallow
    // the shortcut. Without this the chord did nothing at all on a LAN page.
    await preferences.ready().catch(() => {})
    const { profileId, position } = preferences.getSnapshot()
    if (position === 'right') {
      const key = registry.openSidebar(profileId)
      registry.focus(key)
      return
    }
    dock.openMatching(key => registry.matchesProfile(key, profileId))
    registry.focus(dock.getSnapshot().active)
  }, onError)
}
