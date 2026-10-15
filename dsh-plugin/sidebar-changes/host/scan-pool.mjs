import { identity } from './paths.mjs'

/** Share immutable file contents across concurrent tools in the same workspace.
 * Only scans serialize, never tool execution. Each scan still stats every path
 * at its own boundary, so overlapping writes retain their existing attribution.
 * The last user releases the cache; idle projects retain no source contents.
 */
export function createScanPool(scan) {
  const roots = new Map()
  async function drain(key, state) {
    while (state.pending.length) {
      // Freeze the batch before touching the filesystem. A request arriving
      // during this scan needs a later snapshot, never an in-flight/stale one.
      const batch = state.pending.splice(0)
      try {
        const result = await scan(state.root, state.last)
        state.last = state.users ? result : undefined
        for (const request of batch) request.resolve(result)
      } catch (error) {
        state.last = undefined
        for (const request of batch) request.reject(error)
      }
    }
    state.running = false
    if (!state.users) { roots.delete(key); state.last = undefined }
  }
  return root => {
    const key = identity(root)
    let state = roots.get(key)
    if (!state) roots.set(key, state = { root, users: 0, last: undefined, pending: [], running: false })
    state.users++
    let released = false
    return {
      snapshot() {
        if (released) return Promise.reject(Error('released scan scope'))
        const pending = new Promise((resolve, reject) => {
          state.pending.push({ resolve, reject })
        })
        if (!state.running) {
          state.running = true
          queueMicrotask(() => { void drain(key, state) })
        }
        return pending
      },
      release() {
        if (released) return
        released = true
        if (--state.users === 0 && !state.running) { roots.delete(key); state.last = undefined }
      },
    }
  }
}
