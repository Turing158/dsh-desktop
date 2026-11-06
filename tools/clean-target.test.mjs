import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('cleanup preserves development, packaging and unknown files while deleting known temporary checks', () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const targetRoot = join(project, 'src-tauri/target')
  mkdirSync(targetRoot, { recursive: true })
  const base = mkdtempSync(join(targetRoot, 'clean-target-test-'))
  const fixture = join(base, 'project')
  const script = join(fixture, 'tools/clean-target.mjs')
  mkdirSync(dirname(script), { recursive: true })
  copyFileSync(join(project, 'tools/clean-target.mjs'), script)
  const target = join(fixture, 'src-tauri/target')
  function put(path, content = 'keep') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  function run(args = []) {
    return execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  const keep = [
    'debug/deepseek-harness-desktop.exe', 'debug/deepseek_harness_desktop.pdb',
    'debug/deps/dependency.rlib', 'debug/build/package/output', 'debug/.fingerprint/package/info',
    'debug/incremental/state', 'debug/dsh-plugin/plugin.js', 'debug/_up_/ui/index.html',
    'debug/deepseek-harness-desktop-diagnostics-isolated.exe',
    'release/deepseek-harness-desktop.exe', 'release/incremental/state',
    'release/bundle/installer.exe', 'release/nsis/resource.nsh',
    'release/build/package/output', 'release/dsh-plugin/plugin.js',
    'i686-pc-windows-msvc/debug/incremental/state',
    'i686-pc-windows-msvc/release/deepseek-harness-desktop.exe',
    'aarch64-pc-windows-msvc/release/build/package/output',
    'custom-profile/incremental/state', 'new-pack-cache/component.tar',
    'offline-runtime/downloads/runtime.zip', 'offline-runtime/prepared/runtime.json',
    'offline-runtime-x64-result.json', 'offline-runtime-x86-result.json',
    'offline-runtime-result.json', 'future-runtime.json', 'unknown.log',
    'future-package-check.mjs', 'CACHEDIR.TAG', '.rustc_info.json', '.cargo-build-lock',
  ]
  const remove = [
    'native-diagnostics-AbC123/report.json', 'ui-smoke/screenshot.png',
    'cleanup-verification-AbC123/report.json', 'update-speed-rust-tests.log', 'ui-smoke.mjs',
    'deepseek-harness-desktop-diagnostics-isolated.exe',
    `native-diagnostics-AbC123/${'long-segment/'.repeat(30)}report.json`,
  ]
  for (const path of keep) put(join(target, path))
  for (const path of remove) put(join(target, path), 'remove')
  put(join(fixture, 'target/debug/incremental/state'))
  put(join(fixture, 'target/ui-smoke/report.json'))
  put(join(fixture, 'src-tauri/src-tauri/target/release/build/output'))
  put(join(fixture, 'src-tauri/src-tauri/target/terminal-live/report.json'))
  const external = join(base, 'external/sentinel.txt')
  put(external, 'external unchanged')
  symlinkSync(dirname(external), join(target, 'native-diagnostics-AbC123/external'), process.platform === 'win32' ? 'junction' : 'dir')
  const preview = run(['--dry-run'])
  assert.match(preview, /Would remove/)
  assert.doesNotMatch(preview, /Would remove: .*incremental/)
  for (const path of [...keep, ...remove]) assert.ok(existsSync(join(target, path)), path)
  run()
  for (const path of keep) assert.equal(readFileSync(join(target, path), 'utf8'), 'keep', path)
  for (const path of remove) assert.ok(!existsSync(join(target, path)), path)
  assert.equal(readFileSync(external, 'utf8'), 'external unchanged')
  assert.equal(readFileSync(join(fixture, 'target/debug/incremental/state'), 'utf8'), 'keep')
  assert.equal(readFileSync(join(fixture, 'src-tauri/src-tauri/target/release/build/output'), 'utf8'), 'keep')
  assert.ok(!existsSync(join(fixture, 'target/ui-smoke')))
  assert.ok(!existsSync(join(fixture, 'src-tauri/src-tauri/target/terminal-live')))
  assert.match(run(), /Removed 0 entries/)
})
