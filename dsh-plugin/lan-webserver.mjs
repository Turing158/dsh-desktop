/** Compatibility for DSH 0.1.5-rc.2: its CLI accepts --host but the HTTP
 * service schema only accepts 127.0.0.1 / 0.0.0.0. Reuse the complete upstream
 * service, changing only the host schema to specific local private IPv4s.
 */
import { networkInterfaces } from 'node:os'
import { runtimeImport } from './runtime-import.mjs'
const { WebServer } = await runtimeImport('@deepseek-ai/dsh-host-webserver')
const { default: z } = await runtimeImport('@deepseek-ai/schemastery')
const hosts = ['127.0.0.1', ...Object.values(networkInterfaces()).flat().filter(i => {
  if (!i || i.family !== 'IPv4' || i.internal) return false
  const [a,b] = i.address.split('.').map(Number)
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
}).map(i => i.address)]
if (!WebServer.Config?.dict?.host) throw new Error('desktop-lan: unsupported upstream WebServer schema')
export default class DesktopWebServer extends WebServer {
  static Config = z.object({ ...WebServer.Config.dict, host: z.union([...new Set(hosts)].map(host => z.const(host))).required() })
}
