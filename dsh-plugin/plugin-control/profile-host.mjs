import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeImport } from '../runtime-import.mjs'
import { PROFILE_SWITCH_FILE, parseSwitches, protectedReason, hotCapability, ProfilePluginControl } from './profile-model.mjs'

export async function createProfileControl(ctx) {
  const file = join(ctx.profileContext.dir, PROFILE_SWITCH_FILE)
  const readSaved = () => {
    try { return parseSwitches(JSON.parse(readFileSync(file, 'utf8'))) }
    catch (error) { if (error.code === 'ENOENT') return []; throw Error(`${file}：${error.message}`) }
  }
  const policies = JSON.parse(readFileSync(new URL('./hot-policy.json', import.meta.url), 'utf8'))
  const protectedModules = JSON.parse(readFileSync(new URL('./protected-modules.json', import.meta.url), 'utf8'))
  const { readPluginInventory } = await runtimeImport('@deepseek-ai/dsh-host-plugin-inventory')
  const { writeFileAtomic, withFileLock } = await runtimeImport('@deepseek-ai/dsh-atomic-write')
  const { readProfilePatches, reconcileProfilePatches } = await runtimeImport('@deepseek-ai/dsh-app-boot')
  const runtimeVersion = JSON.parse(readFileSync(ctx.profileContext.installAnchor, 'utf8')).version
  const find = id => [...ctx.loader.entries()].find(entry => entry.id === id)
  const list = async () => {
    const inventory = await readPluginInventory(ctx)
    const manager = ctx.get('pluginManager')
    const rows = manager ? await manager.listPlugins() : inventory.entries.map(row => ({ ...row, readOnlyReason: 'management-unavailable' }))
    return { agentPresets: inventory.agentPresets || [], managementAvailable: Boolean(manager), runtimeVersion,
      rows: rows.map(row => {
        const entry = find(row.entryId)
        let pkg
        try { pkg = entry && ctx.get('pluginPackages')?.packageOf(row.moduleName, entry.parent.tree.ctx.baseUrl) } catch { /* Unknown metadata cannot certify hot switching. */ }
        const details = { ...row, packageName: pkg?.name, version: pkg?.version }
        const readOnlyReason = protectedReason(details, protectedModules)
        return { ...details, readOnlyReason, ...hotCapability(details, runtimeVersion, policies, Boolean(ctx.get('hmr'))),
          ...(readOnlyReason ? { hot: false } : {}) }
      }) }
  }
  return new ProfilePluginControl({ saved: readSaved(), list,
    exclusive: operation => {
      // Match the native manager's lock order: profile file lock, then HMR.
      return withFileLock(join(ctx.profileContext.dir, 'package.json'), () => {
        const hmr = ctx.get('hmr')
        return hmr ? hmr.runExclusive(operation) : operation()
      }, { waitMs: 10000 })
    },
    save: async intent => {
      const saved = readSaved().filter(row => row.patchId !== intent.patchId)
      saved.push({ ...intent, runtimeVersion })
      await writeFileAtomic(file, JSON.stringify({ version: 1, entries: saved }, null, 2) + '\n', { mode: 0o600 })
      return saved
    },
    apply: async (row, enabled) => {
      const overlays = ctx.profileContext.overlays, previous = structuredClone(overlays)
      overlays.push({ id: row.patchId, name: row.moduleName, disabled: !enabled })
      try {
        await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', ctx.profileContext), 'dsh', enabled ? [row.patchId] : [])
        const entry = find(row.entryId)
        if (!entry || (enabled ? entry.disabled || entry.fiber?.state !== 2 : !entry.disabled)) throw Error('插件未达到目标状态，可能受到父组或配置覆盖')
      } catch (error) {
        overlays.splice(0, overlays.length, ...previous)
        try { await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', ctx.profileContext), 'dsh') }
        catch (rollback) { throw Error(`${error.message}；恢复运行状态也失败：${rollback.message}`) }
        throw error
      }
    },
  })
}
