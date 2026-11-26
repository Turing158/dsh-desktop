// A subscription represents a mounted settings view. Hidden pages retain the
// last snapshot and refresh once when shown, without keeping an idle timer alive.
export function createVisibleRefresh({ refresh, document, repeat = setInterval,
  cancel = clearInterval, intervalMs = 2000, onIdle = () => {},
  schedule = setTimeout, unschedule = clearTimeout, idleMs = 60000 }) {
  let subscribers = 0, timer = null, disposed = false, expiry = null
  const active = () => !disposed && subscribers > 0 && !document.hidden
  function sync() {
    if (!active()) { if (timer !== null) cancel(timer); timer = null; return }
    if (timer !== null) return
    void refresh()
    timer = repeat(() => { if (active()) void refresh() }, intervalMs)
  }
  document.addEventListener('visibilitychange', sync)
  return {
    acquire() {
      if (disposed) return () => {}
      if (expiry !== null) unschedule(expiry)
      expiry = null
      subscribers++; sync()
      let released = false
      return () => {
        if (released || disposed) return
        released = true; subscribers--; sync()
        if (!subscribers) expiry = schedule(() => { expiry = null; if (!disposed && !subscribers) onIdle() }, idleMs)
      }
    },
    changed() { if (active()) void refresh() },
    dispose() {
      disposed = true; sync()
      if (expiry !== null) unschedule(expiry)
      expiry = null; document.removeEventListener('visibilitychange', sync)
    },
  }
}
