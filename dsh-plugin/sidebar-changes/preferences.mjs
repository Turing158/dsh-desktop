import { t, useLocale } from '../i18n/api.mjs'

const FORGE_ID = '@deepseek-ai/dsh-experimental-client-ui-forge'

/** Follow the live Forge UI, including hot enable/disable, rather than package installation. */
export function createChangesPreferences(slots) {
  let scope, offScope, local, dead = false
  let state = { ready: true, enabled: true, forge: false, saving: false, error: '' }
  const listeners = new Set()
  function publish(patch) {
    if (dead || Object.entries(patch).every(([key, value]) => state[key] === value)) return
    state = { ...state, ...patch }; listeners.forEach(fn => fn())
  }
  function read() {
    const forge = slots.entriesOfSlot('sidebar.right.pane.tab').some(entry =>
      entry.options.key === FORGE_ID || entry.options.key === FORGE_ID + '/changes')
    const snap = scope?.getSnapshot()
    const ready = !scope || snap.status === 'ready' || snap.status === 'unavailable'
    const explicit = local ?? (snap?.status === 'ready' ? snap.value?.enabled : undefined)
    publish({ ready, forge, enabled: typeof explicit === 'boolean' ? explicit : !forge })
  }
  const offSlots = slots.subscribe('sidebar.right.pane.tab', read)
  read()
  return {
    getSnapshot: () => state,
    subscribe: fn => (listeners.add(fn), () => listeners.delete(fn)),
    bind(next) {
      offScope?.(); scope = next; local = undefined
      offScope = next.subscribe(read); read()
      return () => { if (scope !== next) return; offScope?.(); offScope = null; scope = null; read() }
    },
    async setEnabled(enabled) {
      if (typeof enabled !== 'boolean' || !state.ready || state.saving || dead) return
      publish({ saving: true, error: '' })
      let failed = false
      if (!scope || scope.getSnapshot().status === 'unavailable') local = enabled
      else {
        try { failed = await scope.set('enabled', enabled) === false } catch { failed = true }
      }
      if (dead) return
      if (!failed) read()
      publish({ saving: false, error: failed ? t('更改功能设置保存失败，请重试。') : '' })
    },
    dispose() { dead = true; offScope?.(); offSlots(); listeners.clear() },
  }
}

export function createChangesSettingsRow(React, Switch, preferences) {
  const h = React.createElement
  return function ChangesSettingsRow() {
    useLocale(React)
    const state = React.useSyncExternalStore(preferences.subscribe, preferences.getSnapshot)
    return h('div', { className: 'dshChangesSettings', 'data-dsh-changes-setting': true },
      h('div', { className: 'dshChangesSettings__text' },
        h('div', { className: 'dshChangesSettings__title' }, t('更改功能')),
        h('div', { className: 'dshChangesSettings__hint' }, t('显示桌面更改面板；启用「变更请求与工作树」时默认隐藏。')),
        state.error && h('div', { role: 'alert', className: 'dshChangesSettings__hint' }, state.error)),
      h(Switch, { checked: state.enabled, disabled: !state.ready || state.saving,
        label: t('更改功能'), onChange: enabled => preferences.setEnabled(enabled) }))
  }
}

export const settingsStyles = `
.dshChangesSettings { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:16px 0; border-bottom:1px solid var(--dsw-alias-border-l3); }
.dshChangesSettings__text { flex:1; min-width:0; }
.dshChangesSettings__title { color:var(--dsw-alias-label-primary); font-size:14px; line-height:1.5; }
.dshChangesSettings__hint { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; margin-top:4px; }
`
