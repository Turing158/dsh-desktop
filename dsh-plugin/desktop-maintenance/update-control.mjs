import { readFileSync, writeFileSync, watch } from 'node:fs'
import { join } from 'node:path'

// Atomic writes replace request.json, so watch its parent rather than an inode.
// The fallback also handles missed notifications and unavailable directory watches.
export function watchUpdateControl({ directory, flush, exit = () => process.exit(0),
  read = readFileSync, write = writeFileSync, observe = watch,
  repeat = setInterval, cancel = clearInterval, fallbackMs = 2000 }) {
  const requestFile = join(directory, 'request.json'), replyFile = join(directory, 'reply.json')
  let disposed = false, working = false, last, watcher
  const current = () => JSON.parse(read(requestFile, 'utf8'))
  async function check() {
    if (disposed || working) return
    let request
    try { request = current() } catch { return }
    if (!request || typeof request.id !== 'string' || request.id === last) return
    working = true; last = request.id
    try {
      await flush()
      if (disposed || current().id !== request.id) return
      write(replyFile, JSON.stringify({ id: request.id, flushed: true }))
      exit()
    } catch {
      try {
        if (!disposed && current().id === request.id) write(replyFile, JSON.stringify({ id: request.id, flushed: false }))
      } catch { /* A cancelled request cannot acknowledge a later update. */ }
    } finally { working = false }
  }
  try {
    watcher = observe(directory, { persistent: false }, (_event, file) => {
      if (file == null || String(file) === 'request.json') void check()
    })
    watcher.on?.('error', () => { watcher.close() })
  } catch { /* The bounded fallback remains available. */ }
  const timer = repeat(() => { void check() }, fallbackMs)
  timer.unref?.()
  void check()
  return () => { disposed = true; cancel(timer); watcher?.close() }
}
