import { t, useLocale } from '../i18n/api.mjs'
const PROFILE_NAMES = { get auto() { return t('自动选择') }, pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'CMD' }

/**
 * The host scope persists across launches even when the local HTTP port changes.
 *
 * ## A SCOPE THAT CANNOT CARRY THE PREFERENCES MUST NOT TAKE THE TERMINAL DOWN
 *
 * DSH binds a settings scope to Host persistence ONLY on a loopback page:
 * `dsh-client-ui-settings` picks `ctx.remote.$host.isLoopback ? "host" : "memory"`,
 * and a memory-mode namespace never loads — its store sits on `unavailable` for
 * the page's life and every write is a no-op. That is upstream's policy for a
 * genuinely remote browser, and THIS APP'S OWN WINDOW USED TO FALL INTO IT
 * whenever remote control had bound the backend to a LAN address: the desktop
 * page is then served from `http://<lan-ip>:<port>`, so it is "not loopback"
 * either. It no longer does — `ui-overlay/browser-compat.js` declares
 * `__DSH_TRANSPORT__.ownsHost` for a page carrying this app's own WebView bridge,
 * which is the same declaration DSH's official desktop host makes, so the desktop
 * window keeps its writable Host scope while a phone's page keeps upstream's
 * memory mode.
 *
 * The degrade below is therefore about a page that genuinely cannot carry the
 * preferences — a plain LAN browser, or one of this app's pages rendered without
 * the compat shim (the overlay assets deleted, or `css`/`dom` disabled). Treating
 * that as fatal is what broke the terminal. `ready()` used to reject on
 * `unavailable`, and the view awaits it before opening a PTY, so such a page got a
 * shell picker, a dead screen and 桌面连接中断 on every attempt — while the native
 * transport underneath answered perfectly (measured: attach and control both
 * succeed at the LAN origin). The preferences are a convenience, not the
 * transport, so an unavailable scope now DEGRADES: the terminal opens with
 * defaults, the settings rows stay usable for the session, and the only thing
 * lost is that a change cannot be persisted.
 *
 * `unavailable` is also not treated as a per-read error: the error sentence is
 * published on every scope notification, and `dsh-client-ui-settings` rewrites
 * that store often. Writing it there left a stale "保存失败" on screen after a
 * change the user could see had taken effect.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param listProfiles - resolves the native shell catalog.
 * @param events - the window carrying `dsh-terminal-ready`.
 * @returns the preferences store the terminal and its settings rows share.
 */
export function createPreferences(scope, listProfiles, events = window) {
  let state = { ready: false, profileId: 'auto', position: 'bottom', profiles: [], saving: false, error: '' }, dead = false, scopeReady = false
  /** Choices made in this session, for a scope that cannot remember them itself. */
  const local = { preference: null }
  const listeners = new Set(), waiters = new Set()
  const publish = patch => { if (!dead) { state = { ...state, ...patch }; listeners.forEach(fn => fn()) } }
  function read() {
    const snap = scope.getSnapshot()
    // A namespace the Host cannot carry is not an error state for this feature:
    // it means "defaults, and changes are session-only". A namespace still
    // loading is not that — it will answer, so a pending open keeps waiting for
    // the saved shell instead of starting the default one.
    if (snap.status !== 'ready') {
      scopeReady = false
      publish(snap.status === 'unavailable' ? { ready: true } : { ready: false, error: '' })
      if (snap.status !== 'unavailable') return
      waiters.forEach(w => w.resolve()); waiters.clear()
      return
    }
    scopeReady = true
    // An injected in-memory preference wins over the Host section: it is the one
    // the user just chose, and the Host would answer with its own stale value.
    if (!local.preference) {
      // The error is cleared only on the transition INTO ready, so a failed write
      // reports itself until the Host actually answers with a new section.
      publish({ ...(state.ready ? {} : { error: '' }), ready: true, profileId: snap.value?.profileId || 'auto', position: snap.value?.position === 'right' ? 'right' : 'bottom' })
    }
    waiters.forEach(w => w.resolve()); waiters.clear()
  }
  async function refreshProfiles() {
    try { publish({ profiles: await listProfiles() }) } catch { /* Retry when the desktop bridge is ready or the settings row mounts. */ }
  }
  const off = scope.subscribe(read)
  events.addEventListener('dsh-terminal-ready', refreshProfiles)
  read(); refreshProfiles()
  return {
    getSnapshot: () => state,
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    ready() {
      if (dead) return Promise.reject(Error(t('终端已卸载。')))
      return state.ready ? Promise.resolve() : new Promise((resolve, reject) => waiters.add({ resolve, reject }))
    },
    refreshProfiles,
    async set(field, value) {
      publish({ saving: true, error: '' })
      if (!scopeReady) {
        // With no Host section behind the scope this is the ONLY record of the
        // choice, so it is applied at once and remembered: `read()` would
        // otherwise overwrite it with the default on the next notification, and
        // the write itself is a no-op the scope cannot acknowledge.
        local.preference = { ...(local.preference || {}), [field]: value }
        publish({ [field]: value, saving: false })
        return
      }
      // A writable Host keeps the synchronous shape it always had: the accepted
      // value is the one the Host answers with, and a refusal is reported
      // instead of being papered over by an optimistic value.
      let failed = false
      try { failed = await scope.set(field, value) === false } catch { failed = true }
      if (dead) return
      if (!failed) read()
      publish({ saving: false, ...(failed ? { error: t('终端设置保存失败，请重试。') } : {}) })
    },
    dispose() {
      if (dead) return
      dead = true; off(); events.removeEventListener('dsh-terminal-ready', refreshProfiles); listeners.clear()
      waiters.forEach(w => w.reject(Error(t('终端已卸载。')))); waiters.clear()
    },
  }
}

/** Two ordinary General rows using the same Menu primitive as the host. */
export function createSettingsRow(React, primitives, preferences, field, label, hint, pillStyle) {
  const h = React.createElement, Menu = primitives?.Menu
  return function TerminalSettingsRow() {
      useLocale(React)
    const [, bump] = React.useReducer(n => n + 1, 0), [open, setOpen] = React.useState(false), trigger = React.useRef(null)
    React.useEffect(() => {
      const off = preferences.subscribe(bump)
      if (field === 'profileId') preferences.refreshProfiles()
      return off
    }, [])
    const state = preferences.getSnapshot(), value = state[field], disabled = !state.ready || state.saving
    const items = field === 'position' ? [{ id: 'bottom', label: t('底部（默认）') }, { id: 'right', label: t('右侧') }]
      : [{ id: 'auto', label: t('自动选择') }, ...state.profiles.map(p => ({ id: p.profileId, label: p.name }))]
    if (!items.some(item => item.id === value)) items.push({ id: value, label: (PROFILE_NAMES[value] || value) + t('（不可用）') })
    const dismiss = () => { setOpen(false); trigger.current?.focus() }
    const select = id => { dismiss(); preferences.set(field, id) }
    const style = { ...pillStyle, maxWidth: '100%' }
    const control = Menu ? h(Menu, {
      open, onClose: dismiss, items, selectedId: value, onSelect: select, align: 'end', portal: true,
      anchor: h('button', { ref: trigger, type: 'button', className: 'dshTerminalSettings__selector', style, disabled,
        'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => setOpen(!open), onKeyDown: e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true) } },
      }, items.find(item => item.id === value)?.label),
    }) : h('select', { className: 'dshTerminalSettings__selector', style, disabled, 'aria-label': label, value, onChange: e => select(e.target.value) },
      items.map(item => h('option', { key: item.id, value: item.id }, item.label)))
    return h('div', { className: 'dshTerminalSettings__row', 'data-dsh-terminal-setting': field },
      h('div', { className: 'dshTerminalSettings__text' }, h('div', { className: 'dshTerminalSettings__title' }, label),
        h('div', { className: 'dshTerminalSettings__hint' }, hint),
        state.error && h('div', { role: 'alert', className: 'dshTerminalSettings__hint' }, state.error)), control)
  }
}

export function isTerminalShortcut(event) {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing
    && (event.code === 'Backquote' || event.key === '`' || event.key === '~')
}

/** Capture before the composer or xterm can turn the shortcut into shell input. */
export function installShortcut(target, open, onError) {
  let opening = false, dead = false
  const keydown = event => {
    if (!isTerminalShortcut(event)) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (event.repeat || opening) return
    opening = true
    Promise.resolve().then(() => { if (!dead) return open() }).catch(onError).finally(() => { opening = false })
  }
  target.addEventListener('keydown', keydown, { capture: true })
  return () => { dead = true; target.removeEventListener('keydown', keydown, { capture: true }) }
}
