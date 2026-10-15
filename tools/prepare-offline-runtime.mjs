/** Build-time only. Download/verify a pinned Windows runtime; never run in the app. */
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(project, 'src-tauri/target/offline-runtime')
// Only Node.js/npm and WebView2 are distributed. DSH is resolved or installed
// on the user's machine by the normal startup flow.
const argv = process.argv.slice(2)
// Both "--arch x86" and "--arch=x86" are accepted: a mistyped flag must not
// silently build the default architecture instead.
const flag = name => {
  const inline = argv.find(value => value.startsWith(name + '='))
  if (inline) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  if (index < 0) return null
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw Error(`${name} needs a value`)
  return value
}
const verifyTarget = flag('--verify') ? resolve(flag('--verify')) : null
// A payload is verified against the recipe its own manifest was built from, so
// --verify needs no arch flag. A build run defaults to x64.
const arch = verifyTarget
  ? JSON.parse(await readFile(join(verifyTarget, 'runtime.json'), 'utf8')).arch
  : (flag('--arch') ?? 'x64')
// The recipes this repository ships; a typo must fail loudly rather than pick a
// missing file or the wrong architecture.
if (!['x64', 'x86'].includes(arch)) throw Error(`Unknown architecture: ${arch}`)
const recipeFile = join(project, arch === 'x64' ? 'tools/offline-runtime.json' : `tools/offline-runtime-${arch}.json`)
const recipe = JSON.parse(await readFile(recipeFile, 'utf8'))
if (recipe.arch !== arch) throw Error(`Recipe ${recipeFile} describes ${recipe.arch}, not ${arch}`)
// Include the payload format so caches containing DSH can never be reused.
const recipeDigest = createHash('sha256').update('node-webview2-user-npm-v1\n').update(await readFile(recipeFile)).digest('hex')
const runtime = join(cache, recipeDigest.slice(0, 16))
const windows = process.env.SystemRoot || 'C:\\Windows'
const tar = join(windows, 'System32/tar.exe')
const powershell = join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const exists = path => access(path).then(() => true, () => false)

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = chunk => { output = (output + chunk).slice(-16000) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(Error(`${file} failed (${code}):\n${output}`)))
  })
}

async function hash(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

// Every recursive cleanup is confined to this script's own build cache.
async function removeCacheEntry(path) {
  const full = resolve(path)
  if (!full.startsWith(cache + sep) || full === cache) throw Error('Unsafe cache path: ' + full)
  await rm(full, { recursive: true, force: true })
}

async function download(asset) {
  const file = join(cache, 'downloads', new URL(asset.url).pathname.split('/').pop())
  await mkdir(dirname(file), { recursive: true })
  if (await exists(file)) {
    // CABs are checked by their locked hash, or by Microsoft's signature after extraction.
    if (!asset.sha256 || await hash(file) === asset.sha256) return file
    await removeCacheEntry(file)
  }
  console.log('Downloading ' + asset.url)
  const partial = file + '.part'
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(20 * 60 * 1000) })
      if (!response.ok) throw Error(`HTTP ${response.status}: ${asset.url}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
      if (asset.sha256 && await hash(partial) !== asset.sha256) throw Error('SHA256 mismatch: ' + file)
      await rename(partial, file)
      return file
    } catch (error) {
      await removeCacheEntry(partial)
      if (attempt === 3) throw error
      console.log(`Retrying download (${attempt}/3): ${error.message}`)
    }
  }
}

async function unpack(key, archive, stage) {
  console.log('Extracting ' + key)
  const scratch = await mkdtemp(join(cache, 'extract-'))
  try {
    if (key === 'webview2') {
      await run(join(windows, 'System32/expand.exe'), ['-F:*', archive, scratch])
    } else {
      await run(tar, ['-xf', archive, '-C', scratch])
    }
    const entries = await readdir(scratch, { withFileTypes: true })
    const nested = entries.length === 1 && entries[0].isDirectory()
    const source = nested ? join(scratch, entries[0].name) : scratch
    await rename(source, join(stage, key))
    return
  } finally {
    // Either the payload was moved out of the scratch directory, or the
    // extraction failed: in both cases what is left here is disposable. Left
    // behind, one failed download would cost hundreds of megabytes forever.
    if (await exists(scratch)) {
      await removeCacheEntry(scratch).catch(error => console.log('Cleanup failed: ' + error.message))
    }
  }
}

function runtimeEnv(root) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(path|node_options|node_path|npm_config_prefix|npm_config_global|npm_config_ignore_scripts)$/i.test(name)) delete env[name]
  }
  env.PATH = [join(root, 'node'),
    join(windows, 'System32'), join(windows, 'System32/WindowsPowerShell/v1.0')].join(';')
  env.npm_config_cache = join(cache, 'npm-cache')
  return env
}

// A recipe that pointed at the other architecture's download would still install
// and still pass every version check, because a 64-bit host happily launches a
// 64-bit node.exe; the payload would only fail on the target machine. The PE
// header is the one piece of evidence the manifest itself cannot fake.
const PE_MACHINE = { x64: 0x8664, x86: 0x14c }
async function peMachine(file) {
  const handle = await open(file, 'r')
  try {
    const dos = Buffer.alloc(64)
    await handle.read(dos, 0, 64, 0)
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw Error('Not a PE image: ' + file)
    const header = Buffer.alloc(6)
    await handle.read(header, 0, 6, dos.readUInt32LE(0x3c))
    if (header.toString('ascii', 0, 4) !== 'PE\0\0') throw Error('Not a PE image: ' + file)
    return header.readUInt16LE(4)
  } finally {
    await handle.close()
  }
}

async function verifyPrograms(root, arch) {
  const env = runtimeEnv(root)
  const expectedMachine = PE_MACHINE[arch]
  for (const binary of ['node/node.exe', 'webview2/msedgewebview2.exe']) {
    const actual = await peMachine(join(root, binary))
    if (actual !== expectedMachine) {
      throw Error(`${binary} is a PE machine 0x${actual.toString(16)} binary, not ${arch}; the recipe points at the wrong download`)
    }
  }
  const node = join(root, 'node/node.exe')
  const npm = join(root, 'node/node_modules/npm/bin/npm-cli.js')
  const versions = {
    node: await run(node, ['--version'], { env }),
    npm: await run(node, [npm, '--version'], { env }),
  }
  if (versions.node !== 'v' + recipe.assets.node.version) {
    throw Error('Runtime version mismatch: ' + JSON.stringify(versions))
  }
  // Verify Microsoft's signed runtime without relying on an installed Edge/WebView2.
  const signature = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$s = Get-AuthenticodeSignature -LiteralPath $env:DSH_PACK_WEBVIEW; if ($s.Status -ne "Valid" -or $s.SignerCertificate.Subject -notmatch "O=Microsoft Corporation") { throw "Invalid WebView2 signature" }; (Get-Item -LiteralPath $env:DSH_PACK_WEBVIEW).VersionInfo.FileVersion'],
    { env: { ...env, DSH_PACK_WEBVIEW: join(root, 'webview2/msedgewebview2.exe') } })
  if (signature !== recipe.assets.webview2.version) throw Error('Unexpected WebView2 version: ' + signature)
  return { ...versions, webview2: signature }
}

async function inventory(root) {
  const files = {}
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw Error('Runtime contains a non-portable symlink: ' + file)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        const name = relative(root, file).split(sep).join('/')
        if (name !== 'runtime.json') files[name] = { bytes: (await stat(file)).size, sha256: await hash(file) }
      }
    }
  }
  await visit(root)
  return files
}

async function verifyInventory(root) {
  const manifest = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  if (manifest.recipeDigest !== recipeDigest) throw Error('Runtime cache recipe mismatch')
  // Reject unlisted leftovers too: copying an old cache must not reintroduce DSH.
  for (const entry of await readdir(root)) {
    if (!['node', 'webview2', 'runtime.json'].includes(entry)) throw Error('Unexpected runtime entry: ' + entry)
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!/^(node|webview2)\//.test(name)) throw Error('Unexpected runtime inventory path: ' + name)
    const file = resolve(root, name)
    if (!file.startsWith(root + sep)) throw Error('Invalid runtime inventory path')
    if ((await stat(file)).size !== expected.bytes || await hash(file) !== expected.sha256) throw Error('Damaged runtime cache: ' + name)
  }
  return manifest
}

if (process.platform !== 'win32') throw Error('Offline packaging requires Windows; an x64 host builds both payloads')
await mkdir(cache, { recursive: true })
if (verifyTarget) {
  await verifyInventory(verifyTarget)
  await verifyPrograms(verifyTarget, arch)
  console.log('Verified offline runtime: ' + verifyTarget)
} else {
  // A failed or interrupted build leaves its staging tree behind; it is always
  // disposable and can be gigabytes, so reclaim the stale ones up front. Both
  // staging shapes are swept, and a tree that cannot be removed (a handle from a
  // concurrent run, an antivirus scan) must never take the new build down.
  for (const entry of await readdir(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(stage|extract)-/.test(entry.name)) continue
    const stale = join(cache, entry.name)
    if ((await stat(stale)).mtimeMs >= Date.now() - 2 * 60 * 60 * 1000) continue
    await removeCacheEntry(stale).catch(error => console.log(`Keeping ${entry.name}: ${error.message}`))
  }
  if (await exists(runtime)) {
    console.log('Verifying cached runtime (no dependency downloads)')
    await verifyInventory(runtime)
    await verifyPrograms(runtime, arch)
  } else {
    const stage = await mkdtemp(join(cache, 'stage-'))
    try {
      // Downloads are independent; extraction stays sequential to limit disk pressure.
      const keys = ['node', 'webview2']
      const downloads = await Promise.all(keys.map(key => download(recipe.assets[key])))
      for (let i = 0; i < keys.length; i++) await unpack(keys[i], downloads[i], stage)
      // Match the Windows Node installer: ZIP distributions otherwise install
      // global packages beside node.exe, where the app's DSH lookup cannot find
      // them. A built-in default still permits the user's own npm configuration.
      await writeFile(join(stage, 'node/node_modules/npm/npmrc'), 'prefix=${APPDATA}/npm\n')
      const versions = await verifyPrograms(stage, arch)
      console.log('Recording runtime integrity manifest')
      const manifest = { schema: 1, platform: 'win32', arch, recipeDigest, versions,
        archives: Object.fromEntries(await Promise.all(keys.map(async (key, i) => [key, { url: recipe.assets[key].url, sha256: await hash(downloads[i]) }]))),
        files: await inventory(stage) }
      await writeFile(join(stage, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
      await rename(stage, runtime)
    } catch (error) {
      // A half-built payload wastes gigabytes and would confuse the cache check.
      console.log('Removing the failed staging tree')
      await removeCacheEntry(stage).catch(cleanup => console.log('Cleanup failed: ' + cleanup.message))
      throw error
    }
  }
  // The result JSON is the first bare argument; --arch and its value are flags.
  const resultFile = argv.find((value, index) => !value.startsWith('--') && !(argv[index - 1] ?? '').startsWith('--')) ?? null
  if (!resultFile || !isAbsolute(resultFile)) throw Error('Pass an absolute path for the build result JSON')
  await writeFile(resultFile, JSON.stringify({ root: runtime, recipeDigest, arch }) + '\n')
  console.log('Offline runtime ready: ' + runtime)
}
