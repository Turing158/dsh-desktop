/* Shared by native startup pages and the DSH frontend. The locale service owns
 * the preference; this runtime never writes a second language setting. */
;(function () {
  'use strict'
  if (window.__DSH_I18N__) return
  const english = window.__DSH_I18N_MESSAGES__ || {}
  const chinese = Object.fromEntries(Object.keys(english).map(key => [key, key]))
  const reverse = new Map(Object.entries(english).map(([key, value]) => [value, key]))
  let active = window.__DSH_I18N_INITIAL__ || (navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  let revision = 0, service, translate, unsubscribe
  const listeners = new Set()
  const snapshot = () => revision
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  function publish() {
    revision++
    for (const listener of [...listeners]) listener()
    document.dispatchEvent(new CustomEvent('dsh-desktop:locale', { detail: { locale: active } }))
  }
  function t(source, values) {
    if (typeof source !== 'string') return source
    const key = Object.hasOwn(english, source) ? source : reverse.get(source)
    if (!key) return source.replace(/\{(\w+)\}/g, (match, name) => values?.[name] ?? match)
    const text = translate ? translate(key, values) : active.toLowerCase().startsWith('zh') ? key : english[key]
    return text.replace(/\{(\w+)\}/g, (match, name) => values?.[name] ?? match)
  }
  function connect(locale) {
    if (!locale || service === locale) return () => {}
    unsubscribe?.()
    service = locale
    const unregister = locale.register('desktop', { zh: chinese, en: english })
    translate = locale.bind('desktop')
    const update = () => {
      const next = locale.getLocale().active
      active = next
      publish()
      window.__TAURI__?.core?.invoke('desktop_locale_changed', { locale: next }).catch(() => {})
    }
    const off = locale.subscribe(update)
    unsubscribe = () => { off(); unregister(); service = undefined; translate = undefined }
    update()
    return () => { if (service === locale) { unsubscribe(); unsubscribe = undefined } }
  }
  window.__DSH_I18N__ = { t, connect, subscribe, snapshot,
    use(React) { return React.useSyncExternalStore(subscribe, snapshot, snapshot) },
    get locale() { return active },
    adopt(locale) { if (service || active === locale) return; active = locale; publish() },
  }
})()
