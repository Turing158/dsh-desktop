import { watch, statSync } from 'node:fs'
import { dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'

export function insideImmutableRoot(file, root) {
  if (!root) return false
  const part = relative(resolve(root), resolve(file))
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}
const equal = (a, b) => a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size
const metadata = stat => ({ mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size })

// Watch only mutable executable bundles, one nonrecursive handle per parent.
// Keep the original graph/rebuild transport; static runtime trees have no watch
// registrations and no repeated stat calls.
export function watchClientBundles(modules, { immutableRoot, fallbackMs = 30000,
  observe = watch, stat = statSync, repeat = setInterval, cancel = clearInterval,
  schedule = setTimeout, unschedule = clearTimeout, warn = () => {} } = {}) {
  const files = new Map(), directories = new Map(), dirty = new Set()
  let disposed = false, fallback = null, debounce = null
  function inspect(file) {
    const record = files.get(file)
    if (!record) return
    let next
    try { next = metadata(stat(file)) } catch { record.missing = true; return }
    if (!record.missing && equal(record, next)) return
    Object.assign(record, next, { missing: false })
    for (const id of record.ids) try { modules.rebuilt(id) }
    catch (error) { record.missing = true; if (error.code !== 'ENOENT') warn(error) }
  }
  function enqueue(directory, name) {
    for (const file of files.keys()) if (dirname(file) === directory && (name == null || basename(file) === String(name))) dirty.add(file)
    if (!dirty.size || debounce !== null) return
    debounce = schedule(() => {
      debounce = null
      if (disposed) return
      const paths = [...dirty]; dirty.clear()
      paths.forEach(inspect)
    }, 30)
    debounce?.unref?.()
  }
  function sync() {
    if (disposed) return
    const next = new Map()
    for (const row of modules.graph().entries) {
      const baseline = modules.artifactBaseline(row.id)
      if (!baseline || insideImmutableRoot(baseline.path, immutableRoot)) continue
      const file = resolve(baseline.path), record = next.get(file)
      if (record) record.ids.add(row.id)
      else next.set(file, { ...metadata(baseline), ids: new Set([row.id]), missing: files.get(file)?.missing || false })
    }
    files.clear(); for (const [file, record] of next) files.set(file, record)
    const parents = new Set([...files.keys()].map(dirname))
    for (const [directory, watcher] of directories) if (!parents.has(directory)) { watcher.close(); directories.delete(directory) }
    for (const directory of parents) if (!directories.has(directory)) try {
      const watcher = observe(directory, { persistent: false }, (_event, file) => enqueue(directory, file))
      directories.set(directory, watcher)
      watcher.on?.('error', error => { watcher.close(); directories.delete(directory); warn(error) })
    } catch (error) { warn(error) }
    if (files.size && fallback === null) {
      fallback = repeat(() => { for (const file of [...files.keys()]) inspect(file) }, fallbackMs)
      fallback.unref?.()
    } else if (!files.size && fallback !== null) { cancel(fallback); fallback = null }
  }
  const off = modules.onGraphChanged(sync)
  sync()
  return () => {
    disposed = true; off()
    if (fallback !== null) cancel(fallback)
    if (debounce !== null) unschedule(debounce)
    directories.forEach(watcher => watcher.close())
    directories.clear(); files.clear(); dirty.clear()
  }
}
