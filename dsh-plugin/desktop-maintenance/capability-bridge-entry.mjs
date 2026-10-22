import { terminalObservation, createClientReporter, createSessionReporter } from '../compatibility/selectors.mjs'
// Reports originate from execution selectors, with a bounded feature set.
if (window.top === window && !window.__DSH_CAPABILITIES__) {
  let disposed = false
  const send = report => {
    if (disposed || !window.__DSH_REMOTE_IDENTITY__ || !window.__TAURI__?.core?.invoke) return
    return window.__TAURI__.core.invoke('desktop_capabilities_report', { identity: window.__DSH_REMOTE_IDENTITY__, report }).catch(() => {})
  }
  const reporter = createClientReporter(send)
  const sessions = createSessionReporter(reporter,()=>typeof window.__TAURI__?.core?.invoke==='function')
  window.__DSH_CAPABILITIES__ = { ...reporter, ...sessions, terminal: registered => reporter.report(terminalObservation(registered)) }
  const timer = setInterval(() => reporter.refresh(), 60_000)
  window.addEventListener('beforeunload', () => { disposed = true; clearInterval(timer); reporter.clear() }, { once: true })
}
