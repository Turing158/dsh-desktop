import * as nodeModule from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const { createRequire } = nodeModule

export function supportsIdleRuntime(entry) {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
    const version = /^0\.2\.(\d+)(?:[-+].*)?$/.exec(pkg.version)
    // These adapters depend on the MCP host and tool admission API introduced
    // in 0.2.3. Unknown and older layouts keep the upstream implementation.
    return pkg.name === '@deepseek-ai/dsh' && version !== null && Number(version[1]) >= 3
  } catch { return false }
}

export function runtimeRedirects(entry) {
  if (!supportsIdleRuntime(entry)) return new Map()
  const require = createRequire(entry), redirects = new Map()
  for (const [name, file] of [
    ['@deepseek-ai/dsh-client-hmr', './client-hmr.mjs'],
    ['@deepseek-ai/dsh-mcp-client', './mcp-client.mjs'],
    ['@deepseek-ai/dsh-mcp-manager', './mcp-manager.mjs'],
  ]) {
    try { redirects.set(pathToFileURL(require.resolve(name)).href, new URL(file, import.meta.url).href) }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error }
  }
  return redirects
}

export function installIdleRuntimeHooks(entry) {
  if (!entry || typeof nodeModule.registerHooks !== 'function' || process.env.DSH_DESKTOP_IDLE_OPTIMIZATIONS === '0') return
  const redirects = runtimeRedirects(entry)
  if (!redirects.size) return
  const hooks = nodeModule.registerHooks({ load(url, context, nextLoad) {
    // Keep both require.resolve() and import.meta.resolve() pointing at the
    // real package. DSH uses those URLs to discover browser faces and Typert
    // metadata; replacing a resolution URL silently removes those faces.
    const replacement = redirects.get(url)
    if (!replacement) return nextLoad(url, context)
    const defaultExport = replacement.endsWith('/mcp-manager.mjs') ? `export { default } from ${JSON.stringify(replacement)};` : ''
    return { format: 'module', source: `export * from ${JSON.stringify(replacement)};${defaultExport}`, shortCircuit: true }
  } })
  return hooks
}

export async function originalRuntimeImport(name) {
  const require = createRequire(process.env.DSH_DESKTOP_DSH_BIN || process.argv[1])
  const url = pathToFileURL(require.resolve(name))
  // A marked URL loads the real source under one separate cache identity,
  // bypassing the wrapper without changing relative dependency resolution.
  // This also works from another helper generation with no module-local flag.
  if (['@deepseek-ai/dsh-client-hmr', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-mcp-manager'].includes(name)) {
    url.searchParams.set('desktop-upstream', '1')
  }
  return import(url.href)
}
