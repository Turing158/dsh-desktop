// ToolsService.resolve captures the step's complete tool set before building
// the model request. Warm deferred servers at that boundary, not after a tool
// call has already been proposed. The original service receiver is preserved.
const registries = new WeakMap(), prototypes = new WeakMap()

export function deferredToolRegistry(tools) {
  const key = tools?.layers, prototype = tools && Object.getPrototypeOf(tools)
  if (!key || !prototype || typeof prototype.resolve !== 'function') return null
  if (registries.has(key)) return registries.get(key)
  let interception = prototypes.get(prototype)
  if (!interception) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'resolve')
    if (!descriptor?.value || descriptor.writable === false) return null
    const original = descriptor.value
    const replacement = async function (context) {
      const registry = registries.get(this.layers)
      if (registry) await registry.ensure(context)
      return original.call(this, context)
    }
    Object.defineProperty(prototype, 'resolve', { ...descriptor, value: replacement })
    interception = { descriptor, replacement, users: 0 }
    prototypes.set(prototype, interception)
  }
  interception.users++
  const entries = new Set()
  function release(entry) {
    entries.delete(entry)
    if (entries.size) return
    registries.delete(key)
    if (--interception.users === 0) {
      if (prototype.resolve === interception.replacement) Object.defineProperty(prototype, 'resolve', interception.descriptor)
      prototypes.delete(prototype)
    }
  }
  const registry = {
    async ensure({ agent, signal }) {
      signal?.throwIfAborted()
      const pending = [...entries].filter(entry => !entry.disposed && (!entry.scope || entry.scope === agent))
      if (!pending.length) return
      const ready = Promise.all(pending.map(entry => entry.start()))
      if (!signal) return ready
      let abort
      try {
        await Promise.race([ready, new Promise((_resolve, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })])
      } finally { signal.removeEventListener('abort', abort) }
      signal.throwIfAborted()
    },
    defer(factory, scope) {
      const listeners = new Set()
      let instance, pending, cell, off, failure
      const notify = () => { for (const fn of [...listeners]) try { fn() } catch { /* Observers do not own startup. */ } }
      const status = {
        current: () => cell?.current() ?? (failure ? { state: 'failed', reason: 'load', lastError: 'MCP startup failed' } : { state: 'closed' }),
        closure: () => cell?.closure() ?? { closeConfirmed: true },
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      }
      const entry = { scope, disposed: false, start() {
        if (entry.disposed) return Promise.resolve()
        return pending ??= Promise.resolve().then(() => {
          if (entry.disposed) return
          instance = factory()
          return instance.ready
        }).then(next => {
          if (entry.disposed) return
          cell = next
          off = cell?.onChange(notify)
          notify()
        }).catch(error => { failure = error; notify(); throw error })
      } }
      entries.add(entry)
      let disposal
      return {
        ready: Promise.resolve(status), start: () => entry.start(),
        dispose() {
          return disposal ??= (async () => {
            entry.disposed = true
            try { await pending } catch { /* Dispose also handles failed activation. */ }
            const result = await instance?.dispose()
            off?.(); listeners.clear(); release(entry)
            return result ?? status.closure()
          })()
        },
      }
    },
  }
  registries.set(key, registry)
  return registry
}
