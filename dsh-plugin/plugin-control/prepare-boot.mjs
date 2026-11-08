// Runs before DSH starts. Only the temporary --patch is written; the profile's
// watched configuration is never modified by deferred desktop switches.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainThread } from 'node:worker_threads'
import { runtimeImport } from '../runtime-import.mjs'
import { PROFILE_SWITCH_FILE, parseSwitches, startupSwitches } from './profile-model.mjs'

export async function prepareBoot(overlayPath, bootPath) {
  const { resolveProfileDir, loadProfileDirectory, loadOverlayPatches, readProfilePatches, composeEntries } = await runtimeImport('@deepseek-ai/dsh-app-boot')
  const dir = resolveProfileDir('web'), file = join(dir, PROFILE_SWITCH_FILE)
  let saved
  try { saved = parseSwitches(JSON.parse(readFileSync(file, 'utf8'))) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!saved.length) return
  const installAnchor = join(dirname(dirname(process.env.DSH_DESKTOP_DSH_BIN)), 'package.json')
  const profile = loadProfileDirectory('dsh', dir, installAnchor)
  const builtin = JSON.parse(readFileSync(bootPath, 'utf8'))
  const overlays = [...loadOverlayPatches('dsh', overlayPath), ...builtin]
  const context = { ...profile, installAnchor, home: dirname(dirname(dir)), overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED }
  const entries = composeEntries([readProfilePatches('dsh', context, profile)])
  const protectedModules = JSON.parse(readFileSync(new URL('./protected-modules.json', import.meta.url), 'utf8'))
  const runtimeVersion = JSON.parse(readFileSync(installAnchor, 'utf8')).version
  const { patches, notices } = startupSwitches(saved, entries, protectedModules, runtimeVersion)
  for (const notice of notices) process.stderr.write(notice + '\n')
  writeFileSync(bootPath, JSON.stringify([...builtin, ...patches]))
}

// Node also applies --import to workers. Consume these one-shot parameters
// before loading upstream modules so neither workers nor child processes can
// prepare the overlay a second time. Keep the actual DSH entrypoint/argv intact.
const overlay = process.env.DSH_DESKTOP_BOOT_OVERLAY, patch = process.env.DSH_DESKTOP_BOOT_PATCH
if (isMainThread && (overlay !== undefined || patch !== undefined)) {
  delete process.env.DSH_DESKTOP_BOOT_OVERLAY
  delete process.env.DSH_DESKTOP_BOOT_PATCH
  const started = performance.now()
  try {
    if (!overlay || !patch) throw Error('缺少插件启动参数')
    await prepareBoot(overlay, patch)
  } catch (error) {
    // Reject the preload so Node never executes DSH with a partial overlay.
    throw new Error('无法准备 DSH 插件开关：' + error.message, { cause: error })
  }
  if (process.env.DSH_DESKTOP_DEBUG) process.stderr.write(`[startup-perf] plugin-preparation_ms=${Math.round(performance.now() - started)}\n`)
} else if (isMainThread && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] && process.argv[3]) {
  try { await prepareBoot(process.argv[2], process.argv[3]) }
  catch (error) { process.stderr.write('无法准备 DSH 插件开关：' + error.message + '\n'); process.exitCode = 1 }
}
