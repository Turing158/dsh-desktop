import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const preload = resolve('dsh-plugin/plugin-control/prepare-boot.mjs')
function fixture({ fileOverlays = false } = {}) {
  mkdirSync(resolve('src-tauri/target'), { recursive: true })
  const root = mkdtempSync(resolve('src-tauri/target/profile-plugin-control-'))
  const runtime = join(root, 'runtime'), home = join(root, 'home')
  const pkg = join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot'), profile = join(home, 'profiles/web')
  mkdirSync(pkg, { recursive: true }); mkdirSync(profile, { recursive: true }); mkdirSync(join(runtime, 'lib'))
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', version: '0.2.1' }))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.js' }))
  writeFileSync(join(pkg, 'index.js'), `
    import { appendFileSync, readFileSync } from 'node:fs'; import { join } from 'node:path';
    import { isMainThread } from 'node:worker_threads';
    const trace = value => appendFileSync(process.env.TEST_TRACE, value + '\\n');
    trace(isMainThread ? 'main-import' : 'worker-import');
    export const resolveProfileDir = name => { trace('prepare'); return join(process.env.DSH_HOME, 'profiles', name) };
    export const loadProfileDirectory = () => ({});
    export const loadOverlayPatches = (_, file) => JSON.parse(readFileSync(file, 'utf8'));
    export const readProfilePatches = (_, context) => ${fileOverlays
      ? "context.overlayPaths.flatMap(file => loadOverlayPatches('dsh', file))"
      : 'context.overlays'};
    export const composeEntries = groups => {
      const entries = new Map();
      for (const patch of groups.flat()) entries.set(patch.id, { ...entries.get(patch.id), ...patch });
      return [...entries.values()];
    };
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
  writeFileSync(boot, '[]'); writeFileSync(overlay, JSON.stringify([{ id: 'optional', name: 'test-module' }]))
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

test('desktop preload sends the GitHub provider’s multiline GraphQL field through stdin on Windows', () => {
  const f = fixture()
  const modules = join(f.root, 'runtime/node_modules')
  const provider = join(modules, '@deepseek-ai/dsh-experimental-forge-github/lib')
  const execa = join(modules, 'execa')
  mkdirSync(provider, { recursive: true })
  mkdirSync(execa, { recursive: true })
  writeFileSync(join(provider, '../package.json'), '{"type":"module","exports":"./lib/index.js"}')
  writeFileSync(join(provider, 'index.js'), `export { execa } from 'execa'`)
  writeFileSync(join(execa, 'package.json'), '{"type":"module","exports":"./index.js"}')
  writeFileSync(join(execa, 'index.js'), 'export const execa = (file, args, options) => ({ file, args, options })')
  writeFileSync(f.entry, `
    import { execa as run } from '@deepseek-ai/dsh-experimental-forge-github'
    import { execa as other } from 'execa'
    import { writeFileSync } from 'node:fs'
    const query = 'query {\\r\\n  # comment\\n  viewer { login }\\n}'
    const args = ['api', 'graphql', '--hostname', 'github.com', '-f', 'query=' + query, '-F', 'first=50']
    const options = { stdin: 'ignore', timeout: 30000 }
    const results = [run('custom-gh', args, options), other('custom-gh', args, options),
      run('gh', ['api', 'graphql', '--input', '-'], { input: '{"query":"mutation {}"}' }),
      run('gh', ['api', 'graphql', '-f', 'query={viewer{login}}'], options)]
    writeFileSync(process.env.TEST_RESULT, JSON.stringify({ results, query, args, options }))
  `)
  f.env.DSH_DESKTOP_IDLE_OPTIMIZATIONS = '0'
  const run = f.run()
  assert.equal(run.status, 0, run.stderr)
  const { results, query, args, options } = JSON.parse(readFileSync(f.result, 'utf8'))
  const [adapted, other, mutation, singleLine] = results
  assert.deepEqual(other, { file: 'custom-gh', args, options })
  assert.deepEqual(adapted, process.platform === 'win32' ? {
    file: 'custom-gh', args: ['api', 'graphql', '--hostname', 'github.com', '-F', 'query=@-', '-F', 'first=50'],
    options: { ...options, stdin: 'pipe', input: query },
  } : other)
  assert.deepEqual(mutation, { file: 'gh', args: ['api', 'graphql', '--input', '-'], options: { input: '{"query":"mutation {}"}' } })
  assert.deepEqual(singleLine, { file: 'gh', args: ['api', 'graphql', '-f', 'query={viewer{login}}'], options })
})

for (const fileOverlays of [false, true]) for (const enabled of [false, true]) {
  test(`saved plugin intent applies before startup with ${fileOverlays ? 'preview file' : 'stable parsed'} overlays (${enabled})`, () => {
    const f = fixture({ fileOverlays }), saved = JSON.stringify({ version: 1, entries: [
      { patchId: 'optional', moduleName: 'test-module', enabled, runtimeVersion: '0.2.2-rc.5' },
    ] })
    const file = join(f.profile, 'desktop-plugin-switches.json')
    const builtin = [{ id: 'optional', disabled: enabled }, { id: 'desktop-notify', disabled: false }]
    writeFileSync(file, saved); writeFileSync(f.boot, JSON.stringify(builtin))
    const overlay = readFileSync(f.overlay, 'utf8'), run = f.run()
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(readFileSync(f.result)).boot, [...builtin, { id: 'optional', name: 'test-module', disabled: !enabled }])
    assert.equal(readFileSync(file, 'utf8'), saved)
    assert.equal(readFileSync(f.overlay, 'utf8'), overlay)
  })
}

test('preview overlay read errors prevent backend execution without overwriting the boot patch', () => {
  const f = fixture({ fileOverlays: true })
  writeFileSync(join(f.profile, 'desktop-plugin-switches.json'), JSON.stringify({ version: 1, entries: [
    { patchId: 'optional', moduleName: 'test-module', enabled: false, runtimeVersion: '0.2.2-rc.5' },
  ] }))
  writeFileSync(f.overlay, '{broken')
  const run = f.run()
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /无法准备 DSH 插件开关/)
  assert.doesNotMatch(run.stderr, /reading 'flatMap'/)
  assert.equal(existsSync(f.result), false)
  assert.equal(readFileSync(f.boot, 'utf8'), '[]')
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
