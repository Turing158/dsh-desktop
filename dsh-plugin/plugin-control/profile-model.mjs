export const PROFILE_SWITCH_FILE = 'desktop-plugin-switches.json'

export function parseSwitches(document) {
  if (document?.version !== 1 || !Array.isArray(document.entries) || document.entries.length > 4096) throw Error('DSH 插件开关配置格式错误')
  const ids = new Set()
  for (const row of document.entries) {
    if (!row || typeof row.patchId !== 'string' || !row.patchId || row.patchId.length > 1024
      || typeof row.moduleName !== 'string' || !row.moduleName || row.moduleName.length > 4096
      || typeof row.enabled !== 'boolean' || typeof row.runtimeVersion !== 'string' || !row.runtimeVersion || row.runtimeVersion.length > 128
      || ids.has(row.patchId)) throw Error('DSH 插件开关配置条目无效或重复')
    ids.add(row.patchId)
  }
  return document.entries.map(({ patchId, moduleName, enabled, runtimeVersion }) => ({ patchId, moduleName, enabled, runtimeVersion }))
}

export function protectedReason(row, protectedModules) {
  if (row.readOnlyReason) return row.readOnlyReason
  if (row.patchId?.startsWith('desktop-') || row.entryId?.startsWith('include:desktop-')) return 'desktop-managed'
  if (protectedModules.includes(row.moduleName)) return 'management-required'
  return null
}

export function hotCapability(row, runtimeVersion, policies, available) {
  if (!available) return { hot: false, hotReason: '当前宿主未启用热重载' }
  const policy = policies.find(p => p.moduleName === row.moduleName && p.packageName === row.packageName
    && p.version === row.version && p.runtimeVersion === runtimeVersion)
  return policy ? { hot: true, hotReason: policy.hint } : { hot: false, hotReason: '当前插件与 DSH 版本组合尚未验证热切换' }
}

// Persisted intent never feeds the live overlay until an explicit apply or boot.
export class ProfilePluginControl {
  constructor({ saved = [], list, save, apply, exclusive = fn => fn() }) {
    Object.assign(this, { saved, list, save, apply, exclusive })
    this.pending = new Set(); this.errors = new Map(); this.tail = Promise.resolve()
  }
  async status() {
    const inventory = await this.list()
    const rows = inventory.rows.map(row => {
      const intent = this.saved.find(s => s.patchId === row.patchId && s.moduleName === row.moduleName)
      const enabled = intent?.enabled ?? row.enabled
      const differs = enabled !== row.enabled
      const error = this.errors.get(row.entryId) || null
      const restart = differs && !error && !row.readOnlyReason && this.pending.has(row.entryId)
      return { ...row, id: row.entryId, enabled, running: row.enabled, phase: row.enabled ? row.fiberPhase || 'pending' : 'disabled',
        error, restart, application: error ? 'failed' : restart ? 'restart-required' : differs ? 'overridden' : 'applied' }
    })
    const notices = this.saved.filter(s => !rows.some(r => r.patchId === s.patchId && r.moduleName === s.moduleName))
      .map(s => `已保存的 ${s.patchId} 已不存在或模块已更换，未应用其开关。`)
    return { ...inventory, rows, notices, restartRequired: rows.some(row => row.restart) }
  }
  setEnabled(id, enabled) {
    const operation = this.tail.then(() => this.exclusive(async () => {
      if (typeof id !== 'string' || typeof enabled !== 'boolean') throw Error('无效的 DSH 插件开关')
      const row = (await this.list()).rows.find(r => r.entryId === id)
      if (!row) throw Error('插件已不存在，请刷新列表')
      if (row.readOnlyReason || !row.patchId) throw Error('此插件不可修改：' + (row.readOnlyReason || '无法定位配置'))
      this.saved = await this.save({ patchId: row.patchId, moduleName: row.moduleName, enabled })
      this.errors.delete(id); this.pending.delete(id)
      if (enabled !== row.enabled || enabled && row.fiberPhase === 'failed') {
        if (!row.hot) {
          if (enabled !== row.enabled) this.pending.add(id)
        } else {
          try { await this.apply(row, enabled) }
          catch (error) { this.errors.set(id, '热切换失败：' + (error?.message || String(error))) }
        }
      }
      return this.status()
    }))
    this.tail = operation.catch(() => {})
    return operation
  }
}

export function startupSwitches(saved, entries, protectedModules, runtimeVersion) {
  const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
  const rows = flatten(entries), patches = [], notices = []
  for (const intent of saved) {
    const matches = rows.filter(row => row.id === intent.patchId)
    const row = matches[0]
    // Version changes do not change saved intent. Revalidate the target and
    // current protections at boot; hot switching keeps its separate allowlist.
    if (matches.length !== 1 || row.name !== intent.moduleName || row.group
      || protectedReason({ patchId: row.id, moduleName: row.name }, protectedModules)) {
      notices.push(`未应用 ${intent.patchId}：条目已变更、无法唯一定位或属于受保护插件。`)
      continue
    }
    patches.push({ id: intent.patchId, name: intent.moduleName, disabled: !intent.enabled })
  }
  return { patches, notices }
}
