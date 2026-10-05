/** Keep upstream static frontend, authentication and webRuntime. LAN origins
 * need the actual listener address in the ready line and shell environment;
 * upstream 0.1.5-rc.2 hardcodes loopback for both, even with --host.
 */
import { runtimeImport } from './runtime-import.mjs'
const upstream = await runtimeImport('@deepseek-ai/dsh-web-app')
export const Config = upstream.Config
export const name = upstream.name
export const inject = upstream.inject
export function apply(ctx, config) {
  if (ctx.webServer.host === '127.0.0.1') return upstream.apply(ctx, config)
  upstream.apply(ctx, { ...config, printUrl: false, openBrowser: false, surfaceContext: false })
  const origin = () => `http://${ctx.webServer.host}:${ctx.webServer.port}`
  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], c => c.systemPrompt.section({ name: 'app:web-surface', order: c.systemPrompt.getSectionOrder('WEB_SURFACE'),
      text: () => `You are interacting with the user through the DeepSeek Harness Web GUI at ${origin()}. The desktop and phone share this running backend. The browser provides no implicit DOM, route, or screenshot context. Do not start a replacement server unless the user asks.` }))
    ctx.inject(['shellEnv'], c => c.shellEnv.register({ name: 'web-runtime', variables: { DSH_WEB_URL: { description: 'Canonical URL of the running DeepSeek Harness Web GUI.' } }, resolve: () => ({ DSH_WEB_URL: origin() }) }))
  }
  if (config.printUrl) ctx.inject(['connection'], c => {
    const announce = () => {
      if (c.get('webServer') && c.get('connection')) console.log(`dsh web: ${c.connection.authenticatedUrl(origin())}`)
    }
    const settled = c.get('loader')?.await()
    if (settled) settled.then(announce, () => {})
    else announce()
  })
}
