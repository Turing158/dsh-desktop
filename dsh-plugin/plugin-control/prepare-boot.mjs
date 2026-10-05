// Runs before DSH starts. Only the temporary --patch is written; the profile's
// watched configuration is never modified by deferred desktop switches.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

if (process.argv[2] && process.argv[3]) {
  try { await prepareBoot(process.argv[2], process.argv[3]) }
  catch (error) { process.stderr.write('无法准备 DSH 插件开关：' + error.message + '\n'); process.exitCode = 1 }
}
