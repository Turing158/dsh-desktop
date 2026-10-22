// Desktop-owned structured exports. Never copy a whole profile/config file:
// unknown namespaces may contain credentials or executable plugin settings.
import { open, lstat, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SettingsSchema as appearance } from '../ui-client/index.js'
import { SettingsSchema as terminal } from '../sidebar-terminal/index.js'
import { normalizeSaved } from '../plugin-control/model.mjs'
import { parseSwitches, startupSwitches, PROFILE_SWITCH_FILE } from '../plugin-control/profile-model.mjs'
import { runtimeImport } from '../runtime-import.mjs'

const schemas = new Map([['desktop-appearance', appearance], ['desktop-terminal-dock', terminal]])
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const MAX_DOCUMENT = 10 * 1024 * 1024
export function desktopPreferences(document) {
  if (!plain(document) || document.version !== 1 || !plain(document.namespaces)) throw Error('backup-preferences-schema')
  const namespaces = {}
  for (const [id, schema] of schemas) {
    if (!Object.hasOwn(document.namespaces, id)) continue
    const value = schema.validate(document.namespaces[id])
    if (value === undefined) throw Error('backup-preferences-schema')
    namespaces[id] = value
  }
  return { version: 1, namespaces }
}
export function pluginIntent(document, catalog) {
  if (!plain(document) || document.version !== 1 || !plain(document.enabled)
    || Object.values(document.enabled).some(value => typeof value !== 'boolean')) throw Error('backup-plugin-schema')
  return { version: 1, enabled: normalizeSaved(catalog, document.enabled) }
}
export function profileIntent(document) {
  // Intent is descriptive only. Restore must reapply the target's protection
  // and uniqueness rules; this document is never a runtime overlay by itself.
  return { version: 1, entries: parseSwitches(document) }
}
export function mergeProfileIntent(imported, current, context) {
  if (!context || !Array.isArray(context.entries) || !Array.isArray(context.protectedModules)
    || typeof context.runtimeVersion !== 'string') throw Error('backup-profile-unavailable')
  let incoming, saved
  try { incoming = parseSwitches(imported); saved = current === null ? [] : parseSwitches(current) }
  catch { throw Error('backup-profile-schema') }
  if (!incoming.length) throw Error('backup-provider-empty')
  if (incoming.some(row => row.runtimeVersion !== context.runtimeVersion)) throw Error('backup-profile-version')
  const checked = startupSwitches(incoming, context.entries, context.protectedModules, context.runtimeVersion)
  if (checked.notices.length || checked.patches.length !== incoming.length) throw Error('backup-profile-target')
  const replaced = new Set(incoming.map(row => row.patchId))
  // Preserve unrelated local intent and local extension fields. Foreign fields
  // never cross the boundary; startup reuses the same target/protection rules.
  const existing = new Map((current?.entries ?? []).map(row => [row.patchId, row]))
  const entries = [...saved.filter(row => !replaced.has(row.patchId)).map(row => structuredClone(existing.get(row.patchId))),
    ...incoming.map(row => ({...(existing.get(row.patchId) ?? {}),...row}))]
  if (entries.length > 4096) throw Error('backup-profile-schema')
  return {...(current ?? {}),version:1,entries}
}
export async function profileRestoreContext(roots, overlayPath, bootPath) {
  const { loadProfileDirectory, loadOverlayPatches, readProfilePatches, composeEntries } = await runtimeImport('@deepseek-ai/dsh-app-boot')
  const installAnchor = join(dirname(dirname(process.env.DSH_DESKTOP_DSH_BIN)), 'package.json')
  const manifest = JSON.parse(await readFile(installAnchor, 'utf8'))
  const profile = loadProfileDirectory('dsh', roots.profileDirectory, installAnchor)
  if (profile.skippedBundles?.length) throw Error('backup-profile-unavailable')
  const builtin = JSON.parse(await readFile(bootPath, 'utf8'))
  const overlays = [...loadOverlayPatches('dsh', overlayPath),...builtin]
  const context = {...profile,installAnchor,home:roots.profileHome,overlays,telemetryDisabledEnv:process.env.DSH_TELEMETRY_DISABLED}
  const entries = composeEntries([readProfilePatches('dsh', context, profile)])
  const protectedModules = JSON.parse(await readFile(new URL('../plugin-control/protected-modules.json',import.meta.url),'utf8'))
  return {entries,protectedModules,runtimeVersion:manifest.version}
}
export function mergeComponent(id, imported, current, catalog, profileContext) {
  if (id === 'desktop-preferences') {
    const safe = desktopPreferences(imported)
    if (!Object.keys(safe.namespaces).length) throw Error('backup-provider-empty')
    if (current !== null && (!plain(current) || current.version !== 1 || !plain(current.namespaces))) throw Error('backup-preferences-schema')
    // Keep unrelated namespaces and unknown fields already present locally.
    // The imported document can only supply fields declared by our schemas.
    const next = structuredClone(current ?? {version:1,namespaces:{}})
    for (const [namespace, value] of Object.entries(safe.namespaces)) {
      next.namespaces[namespace] = {...(plain(next.namespaces[namespace]) ? next.namespaces[namespace] : {}),...value}
    }
    return next
  }
  if (id === 'plugin-intent') {
    const safe = pluginIntent(imported, catalog)
    if (!Object.keys(safe.enabled).length) throw Error('backup-provider-empty')
    if (current !== null) pluginIntent(current, catalog)
    return {...(current ?? {}),version:1,enabled:{...(current?.enabled ?? {}),...safe.enabled}}
  }
  if (id === 'profile-plugins') return mergeProfileIntent(imported, current, profileContext)
  throw Error('backup-component-unsupported')
}
export async function resolveConfigurationRoots(pluginFile) {
  const { resolveDshHome } = await runtimeImport('@deepseek-ai/dsh-home-paths')
  const { resolveProfileDir } = await runtimeImport('@deepseek-ai/dsh-app-boot')
  const home = resolveDshHome(), profile = resolveProfileDir('web', home)
  return {desktopPreferences:join(home,'desktop-settings.json'),pluginIntent:pluginFile,
    profileSwitches:join(profile,PROFILE_SWITCH_FILE),profileHome:home,profileDirectory:profile}
}
export async function readStableDocument(file, filter, maximum = MAX_DOCUMENT) {
  let handle
  try {
    const initial = await lstat(file)
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maximum) throw Error('backup-provider-file')
    handle = await open(file, 'r')
    const before = await handle.stat({ bigint: true })
    if (before.size > BigInt(maximum)) throw Error('backup-provider-file')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true })
    if (length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key] || after[key] !== current[key])
      || current.isSymbolicLink()) throw Error('backup-provider-changed')
    const value = filter(JSON.parse(bytes.subarray(0, length).toString('utf8')))
    return { schema: 1, value, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), sourceBytes: length }
  } finally { await handle?.close() }
}
export async function captureDesktopComponents(roots, catalog, selected = ['desktop-preferences','plugin-intent','profile-plugins']) {
  const components = [], excluded = []
  for (const [id, file, filter] of [
    ['desktop-preferences', roots.desktopPreferences, desktopPreferences],
    ['plugin-intent', roots.pluginIntent, value => pluginIntent(value, catalog)],
    ['profile-plugins', roots.profileSwitches, profileIntent],
  ]) {
    if (!selected.includes(id)) continue
    if (!file) { excluded.push({ id, reasonCode: 'backup-provider-unavailable' }); continue }
    try { components.push({ id, ...(await readStableDocument(file, filter)) }) }
    catch (error) {
      if (error.code !== 'ENOENT') throw Error(['backup-provider-file', 'backup-provider-changed', 'backup-preferences-schema', 'backup-plugin-schema'].includes(error.message) ? error.message : 'backup-provider-invalid')
      excluded.push({ id, reasonCode: 'backup-provider-empty' })
    }
  }
  return { schema: 1, scope: 'partial', credentialPolicy: 'exclude-credentials', components, excluded }
}
// Invoked only by the native host with a private request/staging directory.
// Stdout contains bounded metadata, never preference bodies or credentials.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const request = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const catalog = JSON.parse(await readFile(new URL('../plugin-control/catalog.json', import.meta.url), 'utf8'))
    if (request.mode === 'resolve') {
      process.stdout.write(JSON.stringify(await resolveConfigurationRoots(request.pluginFile)))
    } else if (request.mode === 'profile-lock') {
      const { withFileLock } = await runtimeImport('@deepseek-ai/dsh-atomic-write')
      // The native parent retains this helper's job and stdin through commit,
      // backend restart and UI acknowledgement. EOF/parent exit releases it;
      // forced termination leaves an exited PID for upstream takeover.
      const finished = new Promise(resolve => {process.stdin.resume();process.stdin.once('data',resolve);process.stdin.once('end',resolve)})
      await withFileLock(join(request.profileDirectory,'package.json'), async () => {
        process.stdout.write('profile-locked\n')
        await finished
        process.stdin.pause()
      },{waitMs:10000})
    } else if (request.mode === 'merge') {
      if (!Array.isArray(request.items) || request.items.length > 3) throw Error('backup-provider-invalid')
      const profileContext = request.items.some(item=>item.id==='profile-plugins')
        ? await profileRestoreContext(request.roots,request.overlayPath,request.bootPath) : null
      const components = []
      for (const item of request.items) {
        const imported = (await readStableDocument(item.imported, value => value)).value
        const current = item.before ? (await readStableDocument(item.before, value => value)).value : null
        const value = mergeComponent(item.id, imported, current, catalog, profileContext)
        const bytes = JSON.stringify(value)
        await writeFile(join(request.staging,item.id+'.json'),bytes,{flag:'wx',mode:0o600})
        components.push({id:item.id,schema:1,size:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')})
      }
      const profileBinding = profileContext ? createHash('sha256').update(JSON.stringify(profileContext)).digest('hex') : null
      process.stdout.write(JSON.stringify({schema:1,components,excluded:[],profileBinding}))
    } else {
    const allowed = new Set(['desktop-preferences', 'plugin-intent', 'profile-plugins'])
    if (!Array.isArray(request.components) || request.components.some(id => !allowed.has(id))) throw Error('backup-provider-invalid')
    const result = await captureDesktopComponents(request.roots, catalog, request.components)
    const components = []
    for (const component of result.components.filter(component => request.components.includes(component.id))) {
      const bytes = JSON.stringify(component.value)
      await writeFile(join(request.staging, component.id + '.json'), bytes, {flag:'wx',mode:0o600})
      components.push({id:component.id,schema:component.schema,size:Buffer.byteLength(bytes),sha256:component.sha256})
    }
    process.stdout.write(JSON.stringify({schema:1,components,excluded:result.excluded.filter(entry => request.components.includes(entry.id))}))
    }
  } catch (error) {
    process.stderr.write(['backup-provider-file','backup-provider-changed','backup-preferences-schema','backup-plugin-schema','backup-component-unsupported','backup-provider-empty',
      'backup-profile-unavailable','backup-profile-schema','backup-profile-version','backup-profile-target'].includes(error.message) ? error.message : 'backup-provider-invalid')
    process.exitCode = 1
  }
}
