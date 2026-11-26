import { originalRuntimeImport } from './runtime-hooks.mjs'
import { watchClientBundles } from './bundle-watches.mjs'
const upstream = await originalRuntimeImport('@deepseek-ai/dsh-client-hmr')
const { default: z } = await originalRuntimeImport('@deepseek-ai/schemastery')
export const name = upstream.name
export const inject = upstream.inject
export const Config = z.object({ ...upstream.Config.dict, pollIntervalMs: z.number().step(1).min(1).default(30000) })

export function apply(ctx, config) {
  const modules = ctx.clientModules
  // Upstream owns the Remote stream and its authorization. Its old stat loop
  // sees an empty watch list; all real file observations belong to our scope.
  const facade = new Proxy(modules, { get(target, key) {
    if (key === 'artifactBaseline') return () => undefined
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const transportContext = new Proxy(ctx, { get(target, key) {
    if (key === 'clientModules') return facade
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  upstream.apply(transportContext, config)
  ctx.effect(() => watchClientBundles(modules, {
    immutableRoot: process.env.DSH_DESKTOP_IMMUTABLE_RUNTIME_ROOT,
    fallbackMs: config.pollIntervalMs, warn: error => ctx.logger.warn(error),
  }), 'desktop-idle: mutable client bundles')
}
