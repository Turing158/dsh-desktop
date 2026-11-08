import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const preload = resolve('dsh-plugin/plugin-control/prepare-boot.mjs')
function fixture() {
  mkdirSync(resolve('src-tauri/target'), { recursive: true })
  const root = mkdtempSync(resolve('src-tauri/target/profile-plugin-control-'))
  const runtime = join(root, 'runtime'), home = join(root, 'home')
  const pkg = join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot'), profile = join(home, 'profiles/web')
  mkdirSync(pkg, { recursive: true }); mkdirSync(profile, { recursive: true }); mkdirSync(join(runtime, 'lib'))
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', version: '0.2.1' }))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.js' }))
  writeFileSync(join(pkg, 'index.js'), `
    import { appendFileSync } from 'node:fs'; import { join } from 'node:path';
    import { isMainThread } from 'node:worker_threads';
    const trace = value => appendFileSync(process.env.TEST_TRACE, value + '\\n');
    trace(isMainThread ? 'main-import' : 'worker-import');
    export const resolveProfileDir = name => { trace('prepare'); return join(process.env.DSH_HOME, 'profiles', name) };
    export const loadProfileDirectory = () => ({});
    export const loadOverlayPatches = () => [];
    export const readProfilePatches = () => [{ id: 'optional', name: 'test-module' }];
    export const composeEntries = groups => groups.flat();
  `)
  const entry = join(runtime, 'lib/bin.js'), result = join(root, 'result.json'), trace = join(root, 'trace.txt')
  writeFileSync(entry, `
    import '@deepseek-ai/dsh-app-boot';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { isMainThread, Worker, parentPort } from 'node:worker_threads';
    if (isMainThread) {
      const worker = new Worker(new URL(import.meta.url));
      await new Promise((resolve, reject) => { worker.once('exit', code => code ? reject(Error('worker failed')) : resolve()); worker.once('error', reject) });
      writeFileSync(process.env.TEST_RESULT, JSON.stringify({ main: import.meta.main, argv: process.argv.slice(2),
        boot: JSON.parse(readFileSync(process.env.TEST_BOOT, 'utf8')),
        leaked: ['DSH_DESKTOP_BOOT_OVERLAY', 'DSH_DESKTOP_BOOT_PATCH'].filter(k => k in process.env) }));
    } else parentPort.postMessage('ready');
  `)
  const boot = join(root, 'boot.json'), overlay = join(root, 'desktop.patch.yml')
  writeFileSync(boot, '[]'); writeFileSync(overlay, '[]')
  const env = { ...process.env, DSH_HOME: home, DSH_DESKTOP_DSH_BIN: entry, TEST_TRACE: trace, TEST_RESULT: result, TEST_BOOT: boot,
    DSH_DESKTOP_BOOT_OVERLAY: overlay, DSH_DESKTOP_BOOT_PATCH: boot }
  // Do not inherit unrelated hooks from the test runner's environment.
  delete env.NODE_OPTIONS
  return { root, profile, boot, overlay, env, entry, result, trace,
    run: () => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, entry, 'web', '--patch', overlay], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 }) }
}

test('preload preserves the CLI entrypoint and argv, shares imports, and does not reapply in workers', () => {
  const f = fixture(), run = f.run()
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(readFileSync(f.result)), { main: true, argv: ['web', '--patch', f.overlay], boot: [], leaked: [] })
  assert.deepEqual(readFileSync(f.trace, 'utf8').trim().split('\n'), ['main-import', 'prepare', 'worker-import'])
})

test('saved plugin intent is applied before the backend starts and the saved file is unchanged', () => {
  const f = fixture(), saved = JSON.stringify({ version: 1, entries: [{ patchId: 'optional', moduleName: 'test-module', enabled: false, runtimeVersion: '0.2.1' }] })
  const file = join(f.profile, 'desktop-plugin-switches.json')
  writeFileSync(file, saved)
  const run = f.run()
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(readFileSync(f.result)).boot, [{ id: 'optional', name: 'test-module', disabled: true }])
  assert.equal(readFileSync(file, 'utf8'), saved)
})

test('invalid saved intent prevents backend execution and retains the diagnostic', () => {
  const f = fixture()
  writeFileSync(join(f.profile, 'desktop-plugin-switches.json'), '{broken')
  const run = f.run()
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /无法准备 DSH 插件开关/)
  assert.equal(existsSync(f.result), false)
  assert.equal(readFileSync(f.boot, 'utf8'), '[]')
})

test('standalone preparation remains compatible with the integration tools', () => {
  const f = fixture()
  delete f.env.DSH_DESKTOP_BOOT_OVERLAY; delete f.env.DSH_DESKTOP_BOOT_PATCH
  const run = spawnSync(process.execPath, [preload, f.overlay, f.boot], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 20000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(existsSync(f.result), false)
  assert.equal(readFileSync(f.boot, 'utf8'), '[]')
})
