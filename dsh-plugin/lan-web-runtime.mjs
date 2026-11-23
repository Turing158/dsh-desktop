/** Keep upstream static frontend, authentication and webRuntime. The desktop
 * ready URL uses our loopback listener so browser login has a local callback;
 * the shared web surface still advertises the selected LAN address.
 */
import { runtimeImport } from './runtime-import.mjs'
import * as nodeModule from 'node:module'
const upstream = await runtimeImport('@deepseek-ai/dsh-web-app')
export const Config = upstream.Config
export const name = upstream.name
export const inject = upstream.inject
export function apply(ctx, config) {
  // The native host terminates the process tree on exit, so Node's normal
  // exit-time cache flush cannot be relied on. Flush after startup settles,
  // outside the readiness announcement; older Node versions simply skip it.
  ctx.inject(['connection'], c => {
    c.get('loader')?.await()?.then(() => {
      setImmediate(() => { try { nodeModule.flushCompileCache?.() } catch { /* Optional cache. */ } })
    }, () => {})
  })
  if (ctx.webServer.host === '127.0.0.1') return upstream.apply(ctx, config)
  // Upstream owns the advertised LAN URL and its prompt/environment context.
  // Registering app:web-surface here conflicts with newer harness-dev-context.
  upstream.apply(ctx, { ...config, printUrl: false, openBrowser: false })
  if (config.printUrl) ctx.inject(['connection'], c => {
    let active = true
    c.effect(() => () => { active = false }, 'desktop-web-runtime: ready URL')
    const announce = () => {
      const webServer = c.get('webServer'), connection = c.get('connection')
      if (!active || !webServer || !connection) return
      const baseUrl = `http://127.0.0.1:${webServer.port}`
      let url
      if (typeof connection.authenticatedUrl === 'function') {
        url = connection.authenticatedUrl(baseUrl)
      } else {
        // DSH 0.2.3 moved browser authentication out of Connection. Ask the
        // active WebServer's authentication providers for the same launch URL
        // upstream publishes, using the desktop's local callback origin.
        const entries = []
        c.emit(webServer, 'webserver/entry-url', baseUrl, entries)
        url = entries.find(entry => entry.open)?.url
      }
      if (!url) throw new Error('desktop-web-runtime: no authenticated desktop entry URL')
      console.log(`dsh web: ${url}`)
    }
    const settled = c.get('loader')?.await()
    if (settled) settled.then(announce, () => {})
    else announce()
  })
}
