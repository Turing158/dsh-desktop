import { t } from '../i18n/api.mjs'
import { createPreferences, installShortcut } from './preferences.mjs'
import { currentSessionId } from './session-context.mjs'

const aliases = { cmd: 'cmd.exe', powershell: 'powershell.exe', pwsh: 'pwsh.exe' }
const basename = path => path.replace(/\\/g, '/').split('/').pop().toLowerCase()

/** Keep durable desktop preferences, but discover shells from the DSH host. */
export function createUpstreamPreferences(ctx, scope, events = window) {
  let shells = [], dead = false, controller
  const listeners = new Set()
  const resolveProfile = value => aliases[value] ? shells.find(shell => basename(shell.path) === aliases[value])?.path ?? value : value
  const mapped = {
    getSnapshot() {
      const snap = scope.getSnapshot()
      if (!snap.value) return snap
      return { ...snap, value: { ...snap.value, profileId: snap.value.shellPath !== undefined ? snap.value.shellPath || 'auto' : resolveProfile(snap.value.profileId || 'auto') } }
    },
    subscribe(fn) { listeners.add(fn); const off = scope.subscribe(fn); return () => { listeners.delete(fn); off() } },
    set(field, value) { return scope.set(field === 'profileId' ? 'shellPath' : field, field === 'profileId' && value === 'auto' ? '' : value) },
  }
  const preferences = createPreferences(mapped, async () => {
    controller?.abort(); controller = new AbortController()
    const request = controller
    const sessionId = currentSessionId(ctx.sessions.list.getSnapshot())
    if (!sessionId) return []
    const result = await ctx.webTerminals.launchShells(sessionId, request.signal)
    if (dead || request.signal.aborted) return shells.map(shell => ({ profileId: shell.path, name: shell.name }))
    shells = result.shells
    listeners.forEach(fn => fn())
    return shells.map(shell => ({ profileId: shell.path, name: shell.name }))
  }, events)
  let lastSession = currentSessionId(ctx.sessions.list.getSnapshot())
  const offSession = ctx.sessions.list.subscribe(() => {
    const next = currentSessionId(ctx.sessions.list.getSnapshot())
    if (next === lastSession) return
    lastSession = next; preferences.refreshProfiles()
  })
  const shellPath = () => {
    const value = resolveProfile(preferences.getSnapshot().profileId)
    return value === 'auto' || aliases[value] ? undefined : value
  }
  return { ...preferences, shellPath,
    dispose() { dead = true; controller?.abort(); offSession(); preferences.dispose(); listeners.clear() },
  }
}

/** Supply defaults only when the caller did not explicitly choose a shell. */
export function installUpstreamShellDefault(service, preferences) {
  const original = service.view
  function view(sessionId, key, contentId, terminalId, shellPath) {
    return original.call(service, sessionId, key, contentId, terminalId, shellPath ?? preferences.shellPath())
  }
  service.view = view
  return () => { if (service.view === view) service.view = original }
}

/** Consume the chord before DSH's bubble handler to avoid a second terminal. */
export function bindUpstreamShortcut(target, ctx, dock, preferences, onError) {
  return installShortcut(target, async () => {
    await preferences.ready()
    if (!currentSessionId(ctx.sessions.list.getSnapshot())) throw Error(t('请先选择会话'))
    await preferences.refreshProfiles()
    const shellPath = preferences.shellPath()
    if (preferences.getSnapshot().position === 'right') {
      ctx.sidebarRight.openTab('terminal', shellPath ? { params: { shellPath } } : {})
    } else {
      dock.store.openMatching(key => dock.registry.matchesShell(key, shellPath))
      target.querySelector?.('[data-dsh-terminal-dock] .xterm-helper-textarea')?.focus()
    }
  }, onError)
}
