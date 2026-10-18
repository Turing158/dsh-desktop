/** Verify explicit local listeners against the installed DSH in an isolated profile. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { networkInterfaces } from 'node:os'
import { createServer, createConnection } from 'node:net'
import { request } from 'node:http'

const root = await mkdtemp(resolve('src-tauri/target/remote-listeners-'))
const home = join(root, 'home')
await mkdir(home)
const mainAddress = Object.values(networkInterfaces()).flat().find(item => {
  if (!item || item.family !== 'IPv4' || item.internal) return false
  const [a, b] = item.address.split('.').map(Number)
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
})?.address || '127.0.0.1'
const loopback = mainAddress === '127.0.0.1' ? '127.0.0.2' : '127.0.0.1'
const hold = (address, port = 0) => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(port, address, () => resolve(server))
})
const close = server => new Promise(resolve => server.close(resolve))
const reservation = await hold(mainAddress)
const port = reservation.address().port
const loopReservation = await hold(loopback, port)
const extraReservation = await hold(loopback)
const extraPort = extraReservation.address().port
await Promise.all([close(reservation), close(loopReservation), close(extraReservation)])
const main = { address: mainAddress, port }
const extra = [{ address: loopback, port }, { address: loopback, port: extraPort }]
const domains = ['first.example.test', 'second.example.test:8443']
const probePath = join(root, 'upgrade.mjs')
await writeFile(probePath, `export const inject = ['webServer', 'connection']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/listener-smoke-upgrade', handler(req, socket) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection) { socket.end('HTTP/1.1 ' + rejection + ' Rejected\\r\\nConnection: close\\r\\n\\r\\n'); return }
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: listener-smoke\\r\\n\\r\\n')
    socket.on('data', chunk => socket.write(chunk))
  } }), 'listener-smoke.upgrade')
}`)
const patch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + '\n- insert:\n    - id: listener-smoke-upgrade\n      name: ' + pathToFileURL(probePath).href + '\n'
const patchPath = join(root, 'desktop.patch.yml')
await writeFile(patchPath, patch)
const dshBin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { checks: [] }
let child, output = ''
function pass(name) { report.checks.push(name); console.log('PASS: ' + name) }
async function stop() {
  if (child?.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await exited
  }
  child = null
}
async function start(listeners, expectConflict = false) {
  output = ''
  const hosts = [mainAddress + ':' + port, ...domains, ...listeners.slice(1).map(item => item.address + ':' + item.port)]
  child = spawn(process.execPath, [dshBin, 'web', '--patch', patchPath, '--no-open', '--host', mainAddress, '--port', String(port), ...hosts.flatMap(host => ['--trusted-host', host])], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: dshBin, DSH_DESKTOP_LISTENERS: JSON.stringify(listeners) },
  })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  for (let i = 0; i < 300; i++) {
    const ready = output.match(/dsh web: (http:\/\/[^\s\u001b]+)/)?.[1]
    if (ready) { assert.equal(expectConflict, false, 'a failed listener must not announce readiness'); return new URL(ready) }
    if (expectConflict && output.includes('EADDRINUSE')) return null
    if (child.exitCode !== null) break
    await sleep(100)
  }
  throw Error('Backend did not reach the expected state: ' + output.replace(/([?&]token=)[^\s"<>]*/g, '$1[redacted]').slice(-1800))
}
function http(address, localPort, host, path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: address, port: localPort, path, method, headers: { Host: host, ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.setTimeout(6000, () => req.destroy(Error('Request timeout')))
    req.end(body)
  })
}
function upgradedSocket(cookie) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: loopback, port })
    let received = '', upgraded = false
    socket.setTimeout(6000, () => socket.destroy(Error('Upgrade timeout')))
    socket.on('error', reject)
    socket.once('connect', () => socket.write('GET /listener-smoke-upgrade HTTP/1.1\r\nHost: ' + loopback + ':' + port + '\r\nCookie: ' + cookie + '\r\nConnection: Upgrade\r\nUpgrade: listener-smoke\r\n\r\n'))
    socket.on('data', chunk => {
      received += chunk
      if (!upgraded && received.includes('\r\n\r\n')) {
        if (!received.startsWith('HTTP/1.1 101')) { socket.destroy(Error('Upgrade rejected')); return }
        upgraded = true
        received = ''
        socket.write('listener-ping')
      } else if (upgraded && received.includes('listener-ping')) {
        socket.setTimeout(0)
        socket.removeAllListeners('data')
        resolve(socket)
      }
    })
  })
}
try {
  const desktopUrl = await start([main])
  assert.equal(desktopUrl.origin, `http://127.0.0.1:${port}`)
  assert.equal((await http(mainAddress, port, domains[0], '/')).status, 401)
  assert.equal((await http('127.0.0.1', port, '127.0.0.1:' + port, desktopUrl.pathname + desktopUrl.search)).status, 303)
  if (loopback !== '127.0.0.1') await assert.rejects(http(loopback, port, loopback + ':' + port, '/'), { code: 'ECONNREFUSED' })
  await stop()
  pass('the desktop retains an authenticated loopback listener without a local Host entry')

  const loginUrl = await start([main, ...extra])
  const cookies = new Map()
  for (const [address, localPort, host] of [[mainAddress, port, domains[0]], [loopback, port, loopback + ':' + port], [loopback, extraPort, loopback + ':' + extraPort], [loopback, port, domains[1]]]) {
    assert.equal((await http(address, localPort, host, '/api/nonexistent')).status, 401)
    const login = await http(address, localPort, host, loginUrl.pathname + loginUrl.search)
    assert.equal(login.status, 303)
    const cookie = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ')
    cookies.set(host, cookie)
    assert.equal((await http(address, localPort, host, '/', { Cookie: cookie })).status, 200)
    const rpc = await http(address, localPort, host, '/api/session/list', { Cookie: cookie, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }))
    assert.equal(rpc.status, 200)
    assert.equal(JSON.parse(rpc.text).result.ok, true)
  }
  assert.equal((await http(loopback, port, 'unlisted.example.test', '/api/nonexistent')).status, 403)
  assert.equal((await http(loopback, port, domains[1], '/api/nonexistent', { Cookie: cookies.get(domains[0]) })).status, 401)
  const upgraded = await upgradedSocket(cookies.get(loopback + ':' + port))
  const upgradedClosed = new Promise(resolve => upgraded.once('close', resolve))
  await stop()
  await upgradedClosed
  pass('LAN and added loopback ports share login, session RPC, Host checks and authenticated HTTP upgrades')

  await start([main])
  for (const item of extra) {
    if (item.address === '127.0.0.1' && item.port === port) continue
    await assert.rejects(http(item.address, item.port, item.address + ':' + item.port, '/'), { code: 'ECONNREFUSED' })
  }
  assert.equal((await http('127.0.0.1', port, '127.0.0.1:' + port, '/api/nonexistent')).status, 401)
  assert.equal((await http(mainAddress, port, domains[0], '/api/nonexistent', { Cookie: cookies.get(domains[0]) })).status, 404)
  await stop()
  pass('removing extra local entries closes their sockets while desktop, LAN and domain login remain usable')

  const occupied = await hold(loopback, extraPort)
  try { await start([main, ...extra], true); await stop() } finally { await close(occupied) }
  const released = await hold(loopback, port)
  await close(released)
  pass('an occupied extra port prevents readiness and cleanup releases already opened sockets')
} catch (error) {
  report.error = error.stack
  throw error
} finally {
  await stop()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Report: ' + join(root, 'report.json'))
}
