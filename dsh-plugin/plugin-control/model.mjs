// Retain the desktop-ui key: it is authoritative for the merged appearance
// feature. Obsolete entry/core switches cannot override it or disable core UI.
export function normalizeSaved(catalog, saved) {
  return Object.fromEntries(catalog.filter(row => typeof saved[row.id] === 'boolean').map(row => [row.id, saved[row.id]]))
}

export function bootPatches(catalog, core, saved) {
  return [
    ...catalog.flatMap(row => (row.modules || [row.id]).map(id => ({ id, disabled: saved[row.id] === false }))),
    ...core.map(id => ({ id, disabled: false })),
  ]
}

// Saved intent and the current process generation deliberately remain separate.
export class PluginControl {
  constructor({ catalog, saved = {}, running = {}, save, apply, phase, hotAvailable = true }) {
    this.catalog = catalog
    this.saved = normalizeSaved(catalog, saved)
    this.running = Object.fromEntries(catalog.map(row => [row.id, running[row.id] !== false]))
    this.save = save; this.apply = apply; this.phase = phase; this.hotAvailable = hotAvailable
    this.tail = Promise.resolve(); this.errors = new Map()
  }
  status() {
    const rows = this.catalog.map(row => ({ ...row, hot: row.hot && this.canHotReload(),
      enabled: this.saved[row.id] !== false, running: this.running[row.id],
      phase: this.phase(row.id), error: this.errors.get(row.id) || null,
      restart: (this.saved[row.id] !== false) !== this.running[row.id],
    }))
    return { rows, restartRequired: rows.some(row => row.restart) }
  }
  canHotReload() { return typeof this.hotAvailable === 'function' ? this.hotAvailable() : this.hotAvailable }
  setEnabled(id, enabled) {
    const operation = this.tail.then(async () => {
      const row = this.catalog.find(row => row.id === id)
      if (!row || typeof enabled !== 'boolean') throw Error('无效的内置插件开关')
      const saved = { ...this.saved, [id]: enabled }
      await this.save(saved)
      this.saved = saved
      this.errors.delete(id)
      if (row.hot && this.canHotReload() && (enabled !== this.running[id] || this.phase(id) === 'failed')) {
        try { await this.apply(id, enabled); this.running[id] = enabled }
        catch (error) { this.errors.set(id, '热切换失败：' + (error?.message || String(error))) }
      }
      return this.status()
    })
    this.tail = operation.catch(() => {})
    return operation
  }
}
