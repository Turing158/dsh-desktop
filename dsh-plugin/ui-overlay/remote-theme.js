/* The remote page owns its palette preference. DSH's ui-theme form can be
   Host-backed (loopback) or unavailable (LAN); neither persists a device choice.
   Adapt only that form's preference field, keeping the upstream theme runtime,
   system media query, token registry, settings rows and presenter as its owners. */
;(function () {
  if (window.__DSH_DESKTOP_BOOT_HOST__ || window.__TAURI__?.core?.invoke || window.__DSH_REMOTE_THEME__) return
  const key = 'dsh.desktop.remote-theme'
  const valid = value => ['system', 'light', 'dark'].includes(value)
  const read = (fallback = 'system') => {
    try { const value = window.localStorage.getItem(key); return valid(value) ? value : 'system' }
    catch { return fallback }
  }
  let preference = read()
  const listeners = new Set(), bindings = new WeakMap()
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')

  // The Host embeds its preference in the initial HTML. Cover that boot canvas
  // until the client presenter takes over, including when a saved choice differs
  // from both the desktop palette and this device's system palette.
  const bootStyle = document.createElement('style')
  let presented = false
  bootStyle.textContent = 'html[data-dsh-remote-theme="light"] body{background-color:#fff!important;--dsh-boot-bg:#fff}html[data-dsh-remote-theme="dark"] body{background-color:#151517!important;--dsh-boot-bg:#151517}'
  document.head.append(bootStyle)
  function boot() {
    if (presented) return
    const dark = preference === 'dark' || (preference === 'system' && media?.matches)
    document.documentElement.setAttribute('data-dsh-remote-theme', dark ? 'dark' : 'light')
    document.documentElement.setAttribute('data-ds-theme-source', preference)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.body?.toggleAttribute('data-ds-dark-theme', !!dark)
  }
  function changed() { boot(); for (const listener of listeners) listener() }
  function save(value) {
    if (!valid(value)) throw new TypeError('Invalid remote theme preference')
    // Storage may be disabled. Still keep the choice for this page's lifetime.
    try { window.localStorage.setItem(key, value) } catch {}
    if (preference !== value) { preference = value; changed() }
  }
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return
    try { if (event.storageArea && event.storageArea !== window.localStorage) return } catch { return }
    const value = read(preference)
    if (value !== preference) { preference = value; changed() }
  })
  // The runtime handles system changes after mounting; this listener also covers
  // the pre-plugin interval and keeps bootstrap metadata consistent.
  media?.addEventListener('change', () => { if (preference === 'system') boot() })
  window.addEventListener('pageshow', () => {
    const value = read(preference)
    if (value !== preference) { preference = value; changed() }
  })

  function bind(ctx, form) {
    let binding = bindings.get(form)
    if (!binding) {
      const theme = ctx.theme
      const names = ['getSnapshot', 'subscribe', 'set', 'unset', 'mutate']
      const descriptors = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(form, name)]))
      const original = Object.fromEntries(names.map(name => [name, form[name].bind(form)]))
      const localListeners = new Set()
      let cachedHost, cachedPreference, snapshot
      form.getSnapshot = () => {
        const host = original.getSnapshot()
        if (host !== cachedHost || preference !== cachedPreference || !snapshot) {
          cachedHost = host; cachedPreference = preference
          snapshot = { ...host, value: { ...host.value, preference,
            fontSize: host.value?.fontSize ?? theme.getTheme().fontSize } }
        }
        return snapshot
      }
      form.subscribe = listener => {
        localListeners.add(listener)
        const dispose = original.subscribe(listener)
        return () => { localListeners.delete(listener); dispose() }
      }
      const sync = () => {
        // Also reaches a runtime that subscribed before this adapter mounted.
        // Its setTheme writes back through the local form and never the Host.
        theme.setTheme(preference)
        for (const listener of localListeners) listener()
      }
      form.set = (field, value) => {
        if (field !== 'preference') return original.set(field, value)
        save(value)
        return Promise.resolve(true)
      }
      form.unset = field => field === 'preference' ? form.set(field, 'system') : original.unset(field)
      form.mutate = (ops, revision) => {
        const local = ops.filter(op => op.path[0] === 'preference')
        for (const op of local) {
          if (op.path.length !== 1 || !['set', 'unset'].includes(op.op) || (op.op === 'set' && !valid(op.value))) {
            throw new TypeError('Invalid remote theme preference operation')
          }
        }
        for (const op of local) save(op.op === 'unset' ? 'system' : op.value)
        const rest = ops.filter(op => op.path[0] !== 'preference')
        return rest.length ? original.mutate(rest, revision) : Promise.resolve(true)
      }
      listeners.add(sync)
      sync()
      presented = true
      bootStyle.remove()
      binding = { users: 0, dispose() {
        listeners.delete(sync)
        localListeners.clear()
        for (const name of names) {
          if (descriptors[name]) Object.defineProperty(form, name, descriptors[name])
          else delete form[name]
        }
        bindings.delete(form)
      } }
      bindings.set(form, binding)
    }
    ctx.effect(() => {
      binding.users++
      return () => { if (--binding.users === 0) binding.dispose() }
    })
  }
  window.__DSH_REMOTE_THEME__ = { boot, bind }
  boot()
})()
