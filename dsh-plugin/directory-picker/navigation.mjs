export const ROOTS = 'desktop:roots'

/** History changes only after a successful scan; old requests cannot replace newer views. */
export function createNavigation({ listDirectory, listRoots }) {
  let state = { location: null, history: [], index: -1, loading: false, error: null }
  let generation = 0, controller, lastRequest
  const listeners = new Set()
  const update = changes => { state = { ...state, ...changes }; for (const listener of listeners) listener() }
  async function visit(target, { index, replace = false } = {}) {
    lastRequest = { target, options: { index, replace } }
    const ticket = ++generation
    controller?.abort()
    controller = new AbortController()
    update({ loading: true, error: null })
    try {
      const location = target === ROOTS
        ? { kind: 'roots', path: ROOTS, entries: await listRoots(controller.signal), crumbs: [] }
        : { ...await listDirectory(target, controller.signal), kind: 'directory' }
      if (ticket !== generation) return false
      let history = state.history, nextIndex = state.index
      if (index !== undefined) nextIndex = index
      else if (!replace && location.path !== history[nextIndex]) {
        history = [...history.slice(0, nextIndex + 1), location.path]
        nextIndex = history.length - 1
      } else if (nextIndex < 0) { history = [location.path]; nextIndex = 0 }
      update({ location, history, index: nextIndex, loading: false, error: null })
      return true
    } catch (error) {
      if (ticket === generation) update({ loading: false, error: error?.rpcError?.message || error?.message || String(error) })
      return false
    }
  }
  const move = delta => {
    const index = state.index + delta
    if (index < 0 || index >= state.history.length) return Promise.resolve(false)
    return visit(state.history[index], { index })
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    visit,
    retry: () => visit(lastRequest?.target, lastRequest?.options),
    back: () => move(-1), forward: () => move(1),
    parent: () => state.location?.kind === 'directory'
      ? visit(state.location.crumbs.at(-2)?.path ?? ROOTS) : Promise.resolve(false),
    refresh: () => visit(state.location?.path, { replace: true }),
    dispose() { generation++; controller?.abort(); listeners.clear() },
  }
}
