import { originalRuntimeImport } from './runtime-hooks.mjs'
import { deferredToolRegistry } from './deferred-tools.mjs'
const upstream = await originalRuntimeImport('@deepseek-ai/dsh-mcp-client')
const { scopeOf } = await originalRuntimeImport('@deepseek-ai/dsh-scope')
const { Context } = await originalRuntimeImport('@deepseek-ai/cordis')
export const Config = upstream.Config
export const inject = upstream.inject
export const name = upstream.name
export const McpLocalError = upstream.McpLocalError
export const McpToolError = upstream.McpToolError
export const createMcpToolDefinition = upstream.createMcpToolDefinition
const reservations = new WeakMap()

function reserve(ctx, serverName) {
  const owner = scopeOf(ctx) ?? ctx[Context.root]
  let names = reservations.get(owner)
  if (!names) { names = new Set(); reservations.set(owner, names) }
  if (names.has(serverName)) throw Error(`mcp-client: serverName "${serverName}" is already in use`)
  names.add(serverName)
  return () => names.delete(serverName)
}

function defer(ctx, config, factory) {
  // Explicit fail-on-startup deployments retain their startup failure contract.
  if (config.failOnStartupError) return null
  const registry = deferredToolRegistry(ctx.tools)
  if (!registry) return null
  const release = reserve(ctx, config.serverName)
  const handle = registry.defer(factory, scopeOf(ctx))
  const dispose = handle.dispose
  handle.dispose = async () => {
    const result = await dispose()
    if (result?.closeConfirmed !== false && !result?.cleanupError) release()
    return result
  }
  return handle
}

export async function apply(ctx, config) {
  const handle = defer(ctx, config, () => {
    const fiber = ctx.plugin(upstream, config)
    return { ready: fiber.await().then(() => undefined), dispose: () => fiber.dispose() }
  })
  if (!handle) return upstream.apply(ctx, config)
  ctx.effect(() => () => handle.dispose(), 'desktop-idle: deferred MCP client')
}

export class McpClientHost extends upstream.McpClientHost {
  pendingServers = new Map()
  mount(config) {
    const handle = defer(this.ownerContext, config, () => super.mount(config))
    if (!handle) return super.mount(config)
    this.pendingServers.set(config.serverName, handle)
    const dispose = handle.dispose
    handle.dispose = async () => {
      const result = await dispose()
      if (this.pendingServers.get(config.serverName) === handle) this.pendingServers.delete(config.serverName)
      return result
    }
    return handle
  }
  async wake(serverName) { await this.pendingServers.get(serverName)?.start() }
}
