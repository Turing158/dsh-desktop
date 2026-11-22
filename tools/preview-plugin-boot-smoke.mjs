// Exercise real app-boot packages across an upgrade in a disposable profile.
// Set DSH_DESKTOP_DSH_BIN and DSH_COMPAT_TARGET_BIN to the installed CLI files.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootPatches } from '../dsh-plugin/plugin-control/model.mjs'
import { offlineModelPatch } from './dsh-ui-helpers.mjs'

const source = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const bins = [...new Set([source, process.env.DSH_COMPAT_TARGET_BIN || source].map(file => resolve(file)))]
const root = await mkdtemp(resolve('src-tauri/target/profile-plugin-control-'))
const home = join(root, 'home'), profile = join(home, 'profiles/web'), probe = join(root, 'probe')
await mkdir(profile, { recursive: true }); await mkdir(probe)
await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
await writeFile(join(home, 'cordis.patch.yml'), offlineModelPatch)
const lifecycle = join(root, 'lifecycle.log'), moduleName = pathToFileURL(join(probe, 'index.js')).href
await writeFile(join(probe, 'package.json'), JSON.stringify({ name: 'preview-boot-probe', type: 'module' }))
await writeFile(join(probe, 'index.js'), `import { appendFileSync } from 'node:fs';
export function apply() { appendFileSync(${JSON.stringify(lifecycle)}, 'mounted\\n') }`)
const overlay = join(root, 'desktop.patch.yml'), boot = join(root, 'boot.json'), savedFile = join(profile, 'desktop-plugin-switches.json')
const desktopPatch = (await readFile('dsh-plugin/desktop-notify.patch.yml', 'utf8'))
  .replace(/name: \.\/([^\s]+)/g, (_, name) => 'name: ' + pathToFileURL(resolve('dsh-plugin', name)).href)
const overlayBytes = desktopPatch + `\n- insert:\n    - id: preview-boot-probe\n      name: ${moduleName}\n`
await writeFile(overlay, overlayBytes)
const catalog = JSON.parse(await readFile('dsh-plugin/plugin-control/catalog.json', 'utf8'))
const core = JSON.parse(await readFile('dsh-plugin/plugin-control/core.json', 'utf8'))
const builtin = bootPatches(catalog, core, {})
const preload = pathToFileURL(resolve('dsh-plugin/plugin-control/prepare-boot.mjs')).href
const sourceVersion = JSON.parse(await readFile(join(dirname(dirname(bins[0])), 'package.json'), 'utf8')).version
const checks = []
let child, output = ''
const sleep = ms => new Promise(done => setTimeout(done, ms))

try {
  for (const bin of bins) for (const enabled of [false, true]) {
    const version = JSON.parse(await readFile(join(dirname(dirname(bin)), 'package.json'), 'utf8')).version
    const saved = JSON.stringify({ version: 1, entries: [
      { patchId: 'preview-boot-probe', moduleName, enabled, runtimeVersion: sourceVersion },
      { patchId: 'absent-old-plugin', moduleName: 'absent', enabled: false, runtimeVersion: sourceVersion },
      { patchId: 'desktop-plugin-control', moduleName: pathToFileURL(resolve('dsh-plugin/plugin-control/index.js')).href,
        enabled: false, runtimeVersion: sourceVersion },
    ] })
    await writeFile(savedFile, saved); await writeFile(boot, JSON.stringify(builtin)); await writeFile(lifecycle, '')
    const env = { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: bin, DSH_TELEMETRY_DISABLED: '1',
      DSH_UI_SMOKE_KEY: 'offline', DSH_DESKTOP_BOOT_OVERLAY: overlay, DSH_DESKTOP_BOOT_PATCH: boot }
    delete env.NODE_OPTIONS
    output = ''
    child = spawn(process.execPath, ['--import', preload, bin, 'web', '--patch', overlay, '--patch', boot, '--no-open', '--port', '0'],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise(done => child.once('exit', done))
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    try {
      const deadline = Date.now() + 60000
      while (!/dsh web: http/.test(output) && child.exitCode === null && Date.now() < deadline) await sleep(100)
      assert.match(output, /dsh web: http/, output)
      assert.doesNotMatch(output, /无法准备 DSH 插件开关|reading 'flatMap'/)
      assert.match(output, /未应用 absent-old-plugin/)
      assert.match(output, /未应用 desktop-plugin-control/)
      assert.deepEqual(JSON.parse(await readFile(boot, 'utf8')), [...builtin,
        { id: 'preview-boot-probe', name: moduleName, disabled: !enabled }])
      assert.equal((await readFile(lifecycle, 'utf8')).includes('mounted'), enabled)
      assert.equal(await readFile(savedFile, 'utf8'), saved)
      assert.equal(await readFile(overlay, 'utf8'), overlayBytes)
      const restore = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { profileRestoreContext } = await import(${JSON.stringify(pathToFileURL(resolve('dsh-plugin/desktop-maintenance/providers.mjs')).href)});
        const result = await profileRestoreContext({ profileDirectory: ${JSON.stringify(profile)}, profileHome: ${JSON.stringify(home)} },
          ${JSON.stringify(overlay)}, ${JSON.stringify(boot)});
        console.log(JSON.stringify(result.entries.find(row => row.id === 'preview-boot-probe')));
      `], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 })
      assert.equal(JSON.parse(restore).disabled, !enabled)
      const check = `${version}: saved ${enabled ? 'enable' : 'disable'} intent survives startup and restore validation`
      checks.push(check); console.log('PASS: ' + check)
    } finally {
      if (child.exitCode === null) {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else child.kill('SIGTERM')
        await exited
      }
      await writeFile(join(root, `${version}-${enabled}.log`), output)
      child = null
    }
  }
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify({ checks }, null, 2))
  console.log('Artifacts: ' + root)
}
