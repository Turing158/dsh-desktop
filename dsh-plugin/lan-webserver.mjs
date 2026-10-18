/** Share the upstream HTTP routes and authentication across explicitly
 * selected local sockets. Domains remain Host permissions, not bind targets.
 */
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:http'
import { isIPv4 } from 'node:net'
import { runtimeImport } from './runtime-import.mjs'
import { paintableBootInjections } from './title-bar/index.js'
const { WebServer } = await runtimeImport('@deepseek-ai/dsh-host-webserver')
const { Service } = await runtimeImport('@deepseek-ai/cordis')
const { default: z } = await runtimeImport('@deepseek-ai/schemastery')
const hosts = ['127.0.0.1', ...Object.values(networkInterfaces()).flat().filter(i => {
  if (!i || i.family !== 'IPv4' || i.internal) return false
  const [a,b] = i.address.split('.').map(Number)
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
}).map(i => i.address)]
if (!WebServer.Config?.dict?.host) throw new Error('desktop-lan: unsupported upstream WebServer schema')
export function parseListeners(value, local = hosts) {
  const entries = JSON.parse(value)
  if (!Array.isArray(entries) || entries.length > 34) throw Error('desktop-lan: invalid listener plan')
  const seen = new Set()
  return entries.filter(entry => {
    if (!entry || !isIPv4(entry.address) || (!entry.address.startsWith('127.') && !local.includes(entry.address))
      || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw Error('desktop-lan: listener must be a local IPv4 address with a valid port')
    const key = entry.address + ':' + entry.port
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
export default class DesktopWebServer extends WebServer {
  static Config = z.object({ ...WebServer.Config.dict, host: z.union([...new Set(hosts)].map(host => z.const(host))).required() })

  collectIndexInjections() {
    return paintableBootInjections(super.collectIndexInjections())
  }

  async [Service.init]() {
    const listeners = parseListeners(process.env.DSH_DESKTOP_LISTENERS || '[]')
    if (listeners.length && !listeners.some(entry => entry.address === this.config.host && entry.port === this.config.port)) {
      throw Error('desktop-lan: listener plan does not match the main listener')
    }
    await super[Service.init]()
    // Keep the desktop document on loopback: Platform login only accepts local
    // callback origins. Remote browsers still use the selected LAN sockets.
    if (this.host !== '127.0.0.1' && !listeners.some(entry => entry.address === '127.0.0.1' && entry.port === this.port)) {
      listeners.push({ address: '127.0.0.1', port: this.port })
    }
    for (const { address, port } of listeners) {
      if (address === this.host && port === this.port) continue
      const sockets = new Set()
      const server = createServer((req, res) => this.server.emit('request', req, res))
      server.on('upgrade', (req, socket, head) => this.server.emit('upgrade', req, socket, head))
      server.on('connection', socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      // Register before binding so a later bind failure also disposes sockets
      // already opened by this activation, including upgraded connections.
      this.ctx.effect(() => () => new Promise(resolve => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      }), 'desktop-lan.listen.' + address + ':' + port)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, address, () => {
          server.off('error', reject)
          server.on('error', error => this.ctx.logger.error(error))
          resolve()
        })
      })
    }
  }
}
