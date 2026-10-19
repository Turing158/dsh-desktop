/** Override only the account launcher seat, retaining its injected store and operations. */
export function mountAccountPopover(slots, createLauncher, root = document.documentElement) {
  if (!slots.entries || !slots.subscribe) return () => {}
  let source, remove, disposed = false, syncing = false
  const replacements = new WeakSet()
  function clear() {
    const off = remove
    remove = source = undefined
    off?.()
  }
  function sync() {
    if (disposed || syncing) return
    syncing = true
    try {
      // Read the ledger, including shadowed entries. The winner projection would
      // hide our source as soon as we register and repeatedly remove/remount us.
      // The separate settings action wraps us; never wrap it back recursively.
      const next = root.getAttribute('data-dsh-ui') === 'vanilla' ? undefined : slots.entries('settings.launcher').find(entry =>
        !replacements.has(entry.component) && !entry.component?.__dshSettingsLauncher && typeof entry.component === 'function'
        && (entry.locale === 'settings.account' || entry.options.locale === 'settings.account'))
      if (next === source) return
      clear()
      if (!next) return
      source = next
      const Launcher = createLauncher(next.component)
      replacements.add(Launcher)
      remove = slots.register({ ...next.options, name: 'settings.launcher',
        priority: (next.options.priority || 0) - 10, inject: next.inject, locale: next.locale, store: next.store,
      }, Launcher)
    } finally { syncing = false }
  }
  const off = slots.subscribe('settings.launcher', sync)
  const observer = new MutationObserver(sync)
  observer.observe(root, { attributes: true, attributeFilter: ['data-dsh-ui'] })
  sync()
  return () => { disposed = true; observer.disconnect(); off(); clear() }
}
