// Verify installation-anchor relocation without mounting plugins or invoking
// loadProfile/loadProfileDirectory, which can rewrite a user's profile.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectRuntimeTree } from './snapshot.mjs'

const inside = (root, file) => { const part = relative(root, file); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Error(code) }
const MAX_DOCUMENT = 2 * 1024 * 1024

async function plainPath(file, directory = false) {
  file = resolve(file)
  const info = await lstat(file)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail('runtime-profile-linked-path')
  for (let parent = dirname(file); dirname(parent) !== parent; parent = dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) fail('runtime-profile-linked-path')
  }
  return realpath(file)
}

// Retain hashes only; credential-bearing configuration bodies never leave this
// helper. A second read detects changes during asynchronous resolution.
async function reader() {
  const records = new Map()
  async function read(file, optional = false) {
    file = resolve(file)
    let before
    try { before = await lstat(file, { bigint: true }) }
    catch (error) {
      if (optional && error.code === 'ENOENT') { records.set(file, null); return null }
      throw error
    }
    await plainPath(file)
    if (before.size > BigInt(MAX_DOCUMENT)) fail('runtime-profile-size-budget')
    const bytes = await readFile(file)
    const after = await lstat(file, { bigint: true })
    if (bytes.length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('runtime-profile-changed')
    const hash = digest(bytes)
    if (records.has(file) && records.get(file) !== hash) fail('runtime-profile-changed')
    records.set(file, hash)
    return bytes
  }
  return { read, async finish() {
    const initial = [...records].sort(([a], [b]) => a.localeCompare(b))
    for (const [file, hash] of initial) {
      const bytes = await read(file, hash === null)
      if ((bytes === null ? null : digest(bytes)) !== hash) fail('runtime-profile-changed')
    }
    return initial
  } }
}

async function installation(entry) {
  entry = await plainPath(entry)
  const anchor = join(dirname(dirname(entry)), 'package.json')
  const manifest = JSON.parse(await readFile(anchor, 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh') fail('runtime-profile-entry-invalid')
  let modules = dirname(dirname(entry))
  while (dirname(modules) !== modules && !modules.endsWith(sep + 'node_modules')) modules = dirname(modules)
  if (!modules.endsWith(sep + 'node_modules')) fail('runtime-install-layout-unsupported')
  const require = createRequire(entry)
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  for (const name of ['resolveBundleDir', 'bundlePatchPaths', 'loadOverlayPatches', 'loadOptionalPatches', 'readProfileCompatibility', 'evaluatePluginCompatibility', 'readProfilePatches', 'composeEntries', 'createRuntimeResolution']) {
    if (typeof boot[name] !== 'function') fail('runtime-profile-resolver-unavailable')
  }
  return { entry, anchor, modules, boot, version: manifest.version }
}

async function retainedTree(root) {
  const inventory = await inspectRuntimeTree(root)
  const files = []
  for (const file of inventory.files) {
    const path = join(root, file.path), before = await lstat(path, { bigint: true }), hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    const after = await lstat(path, { bigint: true })
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('runtime-profile-changed')
    files.push({ ...file, sha256: hash.digest('hex') })
  }
  return { ...inventory, files }
}

export async function verifyRuntimeProfile(sourceEntry, targetEntry, options) {
  const home = await plainPath(options.home, true), dir = await plainPath(options.profileDirectory, true)
  if (!inside(home, dir)) fail('runtime-profile-directory-unsupported')
  const [source, target] = await Promise.all([installation(sourceEntry), installation(targetEntry)])
  if (source.version !== target.version || source.modules === target.modules) fail('runtime-profile-version-mismatch')
  const documents = await reader()
  const manifest = JSON.parse(await documents.read(join(dir, 'package.json')))
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length > 256 || bundles.some(name => typeof name !== 'string') || new Set(bundles).size !== bundles.length) fail('runtime-profile-manifest-invalid')
  await documents.read(join(dir, 'compatibility.json'), true)
  await documents.read(join(dir, 'cordis.patch.yml'), true)
  await documents.read(join(home, 'cordis.patch.yml'), true)
  const overlays = options.overlays ?? []
  if (!Array.isArray(overlays) || overlays.length > 32 || overlays.some(file => typeof file !== 'string' || !isAbsolute(file))) fail('runtime-profile-overlay-invalid')
  for (const file of overlays) await documents.read(file)

  // Profile packages remain at their existing location. They must have a
  // complete plain dependency tree; linked/shared installations need a separate
  // migration strategy and are refused before any runtime switch.
  let retained = null
  const modules = join(dir, 'node_modules')
  if (await lstat(modules).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) {
    await plainPath(modules, true)
    retained = await retainedTree(modules)
  }

  function normalize(value, installation, relocate) {
    if (typeof value === 'string') {
      let path
      if (value.startsWith('file:')) {
        const url = new URL(value)
        if (url.search || url.hash) fail('runtime-profile-module-unsupported')
        path = fileURLToPath(url)
      } else if (isAbsolute(value)) path = value
      if (path && inside(source.modules, path)) {
        if (!relocate) fail('runtime-profile-old-install-reference')
        path = join(target.modules, relative(source.modules, path))
        return value.startsWith('file:') ? pathToFileURL(path).href : path
      }
      if (path && inside(installation.modules, path)) return value.startsWith('file:') ? pathToFileURL(path).href : path
      return value
    }
    if (Array.isArray(value)) return value.map(item => normalize(item, installation, relocate))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, installation, relocate)]))
    return value
  }

  const externalTrees = new Map()
  async function inspect(installation, relocate) {
    const boot = installation.boot, layers = []
    const compatibility = boot.readProfileCompatibility(dir)
    if (compatibility.warnings.length) fail('runtime-profile-compatibility-invalid')
    for (const packageName of bundles) {
      const packageDir = await plainPath(boot.resolveBundleDir('dsh', packageName, installation.anchor, dir), true)
      if (!inside(installation.modules, packageDir) && !inside(dir, packageDir)) fail('runtime-profile-package-external')
      const pkg = JSON.parse(await documents.read(join(packageDir, 'package.json')))
      const issue = boot.evaluatePluginCompatibility(pkg, compatibility.exemptions, installation.version)
      if (issue && !issue.exempted) fail('runtime-profile-bundle-incompatible')
      const patchPaths = boot.bundlePatchPaths(packageDir, pkg.dsh?.bundle)
      const patches = []
      for (const file of patchPaths) {
        if (!inside(packageDir, file)) fail('runtime-profile-package-external')
        await documents.read(file)
        patches.push(...boot.loadOverlayPatches('dsh', file))
      }
      layers.push({ packageName, packageDir, patchPaths, patches })
    }
    const profile = { name: 'web', dir, patchPath: join(dir, 'cordis.patch.yml'), layers,
      patches: boot.loadOptionalPatches('dsh', join(dir, 'cordis.patch.yml')) ?? [], skippedBundles: [] }
    const resolution = await boot.createRuntimeResolution({ installAnchor: installation.anchor, profile, home })
    if (resolution.linkedRoots.length) fail('runtime-profile-linked-path')
    const table = new Map(resolution.entries.map(row => [row.name, row]))
    const local = new Set(resolution.localPackageNames)
    const entries = boot.composeEntries([boot.readProfilePatches('dsh', { dir, patchPath: profile.patchPath,
      home, installAnchor: installation.anchor, overlays: overlays.flatMap(file => boot.loadOverlayPatches('dsh', file)),
      telemetryDisabledEnv: options.telemetryDisabledEnv }, profile)])
    const imports = []
    async function visit(rows) {
      if (!Array.isArray(rows) || rows.length > 8192 || imports.length > 8192) fail('runtime-profile-size-budget')
      for (const row of rows) {
        if (row.group) { await visit(row.config); continue }
        if (typeof row.name !== 'string') fail('runtime-profile-module-unsupported')
        // Nested include files can change the Loader's base URL. They require
        // their own recursive contract; don't certify an uninspected subtree.
        if (row.name === '@deepseek-ai/cordis-plugin-include') fail('runtime-profile-module-unsupported')
        let selected
        if (row.name.startsWith('file:') || isAbsolute(row.name)) {
          selected = row.name.startsWith('file:') ? fileURLToPath(row.name) : row.name
          if (!inside(installation.modules, selected) && !inside(home, selected) && !overlays.some(file => inside(dirname(file), selected))) fail('runtime-profile-module-external')
          const info = await lstat(selected)
          await plainPath(selected, info.isDirectory())
          if (info.isFile()) await documents.read(selected)
          else if (!inside(installation.modules, selected) && !externalTrees.has(selected)) externalTrees.set(selected, await retainedTree(selected))
        } else {
          const name = row.name.match(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?=\/|$)/i)?.[0]
          if (!name) fail('runtime-profile-module-unsupported')
          selected = local.has(name) ? join(dir, 'node_modules', name) : table.get(name)?.packageDir
          if (!selected) fail('runtime-profile-module-missing')
          selected = await plainPath(selected, true)
          if (!inside(installation.modules, selected) && !inside(dir, selected)) fail('runtime-profile-module-external')
          await documents.read(join(selected, 'package.json'))
        }
        imports.push({ name: row.name, selected })
      }
    }
    await visit(entries)
    for (const row of resolution.entries) {
      const packageDir = await plainPath(row.packageDir, true)
      if (!inside(installation.modules, packageDir) && !inside(dir, packageDir)) fail('runtime-profile-package-external')
    }
    return normalize({ layers, entries, imports, resolution: resolution.entries, local: [...local] }, installation, relocate)
  }
  const before = await inspect(source, true), after = await inspect(target, false)
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('runtime-profile-resolution-changed')
  if (retained) {
    const current = await retainedTree(modules)
    if (JSON.stringify(current) !== JSON.stringify(retained)) fail('runtime-profile-changed')
  }
  for (const [path, initial] of externalTrees) if (JSON.stringify(await retainedTree(path)) !== JSON.stringify(initial)) fail('runtime-profile-changed')
  const files = await documents.finish()
  return { schema: 1, fingerprint: digest(JSON.stringify({ home, dir, source: source.anchor, target: target.anchor, files, resolution: after, retained, externalTrees: [...externalTrees] })),
    bundleCount: bundles.length, moduleCount: after.imports.length, retainedPackages: retained?.packages ?? 0,
    dataMigration: 'unverified' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const request = JSON.parse(await readFile(process.argv[2], 'utf8'))
    process.stdout.write(JSON.stringify(await verifyRuntimeProfile(request.sourceEntry, request.targetEntry, request)))
  } catch (error) {
    process.stderr.write(/^runtime-[a-z-]+$/.test(error.message) ? error.message : 'runtime-profile-unavailable')
    process.exitCode = 1
  }
}
