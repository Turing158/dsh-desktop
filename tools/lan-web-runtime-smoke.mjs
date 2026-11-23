// Real stable/preview LAN startup with isolated profiles and no model requests.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { offlineModelPatch, handleOnboarding } from './dsh-ui-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/Turing_ICE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const bins = process.argv.slice(2).map(path => resolve(path))
assert.ok(bins.length, 'Pass installed DSH bin.js paths to verify')
const lan = Object.values(networkInterfaces()).flat().find(row => {
  if (!row || row.internal || row.family !== 'IPv4') return false
  const [a, b] = row.address.split('.').map(Number)
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
})?.address
assert.ok(lan, 'Requires a local private IPv4 interface')
const root = await mkdtemp(resolve('target/upgrade-compat-'))
const overlay = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, file) => 'name: ' + pathToFileURL(resolve('dsh-plugin', file)).href)
  + offlineModelPatch
const patch = join(root, 'desktop.patch.yml')
await writeFile(patch, overlay)
const report = { checks: [] }
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  for (const bin of bins) {
    const version = JSON.parse(await readFile(join(bin, '../../package.json'), 'utf8')).version
    for (const host of ['127.0.0.1', lan]) {
      const home = join(root, version, host)
      await mkdir(home, { recursive: true })
      let log = '', ready
      const child = spawn(process.execPath, [bin, 'web', '--patch', patch, '--no-open', '--host', host, '--port', '0'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: bin, DSH_UI_SMOKE_KEY: 'offline' },
      })
      const capture = chunk => {
        log += chunk
        appendFileSync(join(home, 'startup.log'), chunk)
        ready ||= log.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/)?.[1]
      }
      child.stdout.on('data', capture); child.stderr.on('data', capture)
      const contexts = []
      try {
        const deadline = Date.now() + 120000
        while (!ready) {
          if (child.exitCode !== null) throw Error('DSH exited before readiness: ' + log)
          assert.ok(Date.now() < deadline, 'Timed out waiting for readiness: ' + log)
          await new Promise(done => setTimeout(done, 100))
        }
        assert.ok(new URL(ready).searchParams.has('token'), 'must use the active authentication provider')
        console.log(`READY: ${version} ${host === lan ? 'LAN' : 'loopback'}`)
        for (const address of host === lan ? ['127.0.0.1', lan] : ['127.0.0.1']) {
          const url = new URL(ready); url.hostname = address
          const context = await browser.newContext(); contexts.push(context)
          const denied = await context.request.get(url.origin)
          assert.equal(denied.status(), 401, 'bare origin must still require authentication')
          const page = await context.newPage()
          await handleOnboarding(page)
          await page.goto(url.href)
          await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0 && !!window.__DSH_I18N__, null, { timeout: 120000 })
          const authenticated = await context.request.get(url.origin)
          assert.equal(authenticated.status(), 200)
          await page.screenshot({ path: join(home, address + '.png') })
          const check = `${version}: ${host === lan ? 'LAN' : 'loopback'} listener opens authenticated ${address === lan ? 'LAN' : 'desktop'} page`
          report.checks.push(check); console.log('PASS: ' + check)
        }
        assert.doesNotMatch(log, /fatal load failure|authenticatedUrl is not a function|entry did not activate/)
      } finally {
        await writeFile(join(home, 'startup.log'), log)
        for (const context of contexts) await context.close()
        let cleanupError
        if (child.exitCode === null) {
          try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
          catch (error) { cleanupError = error }
        }
        // taskkill may report a descendant already gone while the parent exit
        // event is still pending. Verify exit instead of failing on that race.
        await new Promise(done => {
          if (child.exitCode !== null) return done()
          const timer = setTimeout(done, 5000)
          child.once('exit', () => { clearTimeout(timer); done() })
        })
        if (child.exitCode === null) throw cleanupError || Error('Isolated DSH process did not exit')
      }
    }
  }
} catch (error) { report.error = error.stack; throw error }
finally {
  await browser.close()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Artifacts: ' + root)
}
