import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeImport } from '../runtime-import.mjs'
import { PluginControl, normalizeSaved } from './model.mjs'
import { contribution } from './protocol.mjs'
import { createProfileControl } from './profile-host.mjs'
import { createMarketplaceInstaller } from './marketplace.mjs'
import { createPluginReporter } from '../compatibility/selectors.mjs'

export const name = 'desktop-plugin-control'
export const inject = ['loader', 'profileContext', 'typert']
export async function apply(ctx) {
  const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))
  const file = process.env.DSH_DESKTOP_PLUGINS_FILE || join(ctx.profileContext.home, 'desktop-plugins.json')
  let saved = {}
  let localDocument = { version: 1, enabled: {} }
  try {
    const document = JSON.parse(readFileSync(file, 'utf8'))
    if (document.version !== 1 || !document.enabled || typeof document.enabled !== 'object' || Array.isArray(document.enabled)
      || Object.values(document.enabled).some(value => typeof value !== 'boolean')) throw Error('内置插件配置格式错误')
    saved = document.enabled
    localDocument = document
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const { writeFileAtomic } = await runtimeImport('@deepseek-ai/dsh-atomic-write')
  const normalized = normalizeSaved(catalog, saved)
  // Reconcile only the running catalog. Unknown local intent is inert and may
  // belong to another installation; reading it must not replace the file.
  saved = normalized
  const { readProfilePatches, reconcileProfilePatches } = await runtimeImport('@deepseek-ai/dsh-app-boot')
  const { TypertRemoteService, RemoteError } = await runtimeImport('@deepseek-ai/dsh-typert-protocol')
  const find = id => [...ctx.loader.entries()].find(entry => entry.options.id === id)
  const running = Object.fromEntries(catalog.map(row => [row.id, !find(row.id)?.disabled]))
  const control = new PluginControl({ catalog, saved, running,
    hotAvailable: () => Boolean(ctx.get('hmr')),
    phase: id => {
      const row = catalog.find(row => row.id === id)
      const phases = (row.modules || [id]).map(moduleId => {
        const entry = find(moduleId)
        if (!entry || entry.disabled) return 'disabled'
        return ({ 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'disabled', 5: 'unloading' })[entry.fiber?.state] || 'pending'
      })
      return ['failed', 'loading', 'unloading', 'pending', 'disabled', 'active'].find(phase => phases.includes(phase))
    },
    save: async enabled => {
      const next = { ...localDocument, version: 1, enabled: { ...localDocument.enabled, ...enabled } }
      await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      localDocument = next
    },
    apply: (id, enabled) => ctx.get('hmr').runExclusive(async () => {
      // Overlay layers are held in memory by app-boot. Retain the live values
      // there so an unrelated profile/config reload cannot undo a hot switch.
      const overlays = ctx.profileContext.overlays
      const previous = structuredClone(overlays)
      overlays.push({ id, disabled: !enabled })
      try {
        await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', ctx.profileContext), 'dsh', enabled ? [id] : [])
        const entry = find(id)
        if (!entry || (enabled ? entry.fiber?.state !== 2 : !entry.disabled)) throw Error('插件尚未达到目标运行状态')
      } catch (error) {
        overlays.splice(0, overlays.length, ...previous)
        try { await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', ctx.profileContext), 'dsh') }
        catch (rollback) { ctx.logger.warn('desktop plugin rollback: %s', rollback.message) }
        throw error
      }
    }),
  })
  const profileControl = await createProfileControl(ctx)
  const marketplace = createMarketplaceInstaller(() => ctx.get('pluginManager'))
  const emitPluginObservations = createPluginReporter()
  const status = async () => {
    const builtins = control.status(), profile = await profileControl.status()
    const market = await marketplace.status()
    const result = { ...builtins, plugins: profile.rows, agentPresets: profile.agentPresets, notices: profile.notices,
      managementAvailable: profile.managementAvailable, runtimeVersion: profile.runtimeVersion,
      marketplace: market, restartRequired: builtins.restartRequired || profile.restartRequired || market.restartRequired }
    emitPluginObservations(result)
    return result
  }
  // Read-only status uses the same controller results as actual switch actions.
  void status().catch(() => {})
  const capabilityTimer = setInterval(() => { void status().catch(() => {}) }, 60_000)
  ctx.effect(() => () => clearInterval(capabilityTimer))
  class DesktopPlugins extends TypertRemoteService {
    constructor(scope) { super(scope, 'desktopPlugins') }
    async status() { return status() }
    async installMarketplace() { await marketplace.install(); return status() }
    async setEnabled(id, enabled) {
      try { await control.setEnabled(id, enabled); return await status() }
      catch (error) { throw new RemoteError('desktop-plugins/change', error.message, {}) }
    }
    async setPluginEnabled(entryId, enabled) {
      try { await profileControl.setEnabled(entryId, enabled); return await status() }
      catch (error) { throw new RemoteError('desktop-plugins/change', error.message, {}) }
    }
  }
  ctx.plugin(DesktopPlugins)
  ctx.typert.register({ package: contribution.package, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: contribution.descriptors })
}
