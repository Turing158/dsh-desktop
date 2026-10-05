/** Build-time only. Download/verify a pinned Windows runtime; never run in the app. */
import { createReadStream, createWriteStream } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(project, 'src-tauri/target/offline-runtime')
const recipeFile = join(project, 'tools/offline-runtime.json')
const lockFile = join(project, 'tools/offline-dsh/package-lock.json')
const recipe = JSON.parse(await readFile(recipeFile, 'utf8'))
const recipeDigest = createHash('sha256').update(await readFile(recipeFile)).update(await readFile(lockFile)).digest('hex')
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
  if (key === 'webview2') {
    await run(join(windows, 'System32/expand.exe'), ['-F:*', archive, scratch])
  } else {
    await run(tar, ['-xf', archive, '-C', scratch])
  }
  const entries = await readdir(scratch, { withFileTypes: true })
  const nested = entries.length === 1 && entries[0].isDirectory()
  const source = nested ? join(scratch, entries[0].name) : scratch
  await rename(source, join(stage, key))
  if (nested) await removeCacheEntry(scratch)
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

async function verifyPrograms(root) {
  const env = runtimeEnv(root)
  const node = join(root, 'node/node.exe')
  const dsh = join(root, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const versions = {
    node: await run(node, ['--version'], { env }),
    dsh: await run(node, [dsh, '--version'], { env }),
  }
  if (versions.node !== 'v' + recipe.assets.node.version || versions.dsh.replace(/^v/, '') !== recipe.dsh) {
    throw Error('Runtime version mismatch: ' + JSON.stringify(versions))
  }
  // This resolves the native ripgrep dependency actually used by DSH, with no system rg.
  await run(node, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; import {execFileSync} from 'node:child_process'; const req=createRequire(${JSON.stringify(dsh)}); const search=createRequire(req.resolve('@deepseek-ai/dsh-tool-fs-search')); execFileSync(search('@vscode/ripgrep').rgPath,['--version'],{windowsHide:true});`], { env })
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
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = resolve(root, name)
    if (!file.startsWith(root + sep)) throw Error('Invalid runtime inventory path')
    if ((await stat(file)).size !== expected.bytes || await hash(file) !== expected.sha256) throw Error('Damaged runtime cache: ' + name)
  }
  return manifest
}

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Offline packaging currently requires Windows x64 and x64 Node.js')
await mkdir(cache, { recursive: true })
if (process.argv[2] === '--verify') {
  const target = resolve(process.argv[3])
  await verifyInventory(target)
  await verifyPrograms(target)
  console.log('Verified offline runtime: ' + target)
} else {
  if (await exists(runtime)) {
    console.log('Verifying cached runtime (no dependency downloads)')
    await verifyInventory(runtime)
    await verifyPrograms(runtime)
  } else {
    const stage = await mkdtemp(join(cache, 'stage-'))
    // Downloads are independent; extraction stays sequential to limit disk pressure.
    const keys = Object.keys(recipe.assets)
    const downloads = await Promise.all(keys.map(key => download(recipe.assets[key])))
    for (let i = 0; i < keys.length; i++) await unpack(keys[i], downloads[i], stage)
    await cp(join(project, 'tools/offline-dsh'), join(stage, 'dsh'), { recursive: true })
    console.log('Installing DSH dependencies into the build payload')
    await run(join(stage, 'node/node.exe'), [join(stage, 'node/node_modules/npm/bin/npm-cli.js'),
      // Include required peers: a clean DSH install with legacy-peer-deps misses
      // cordis-plugin-group and cannot even report --version. The lock pins the
      // full peer graph; force permits upstream's conflicting peer ranges.
      'ci', '--prefix', join(stage, 'dsh'), '--force', '--omit=dev', '--no-audit', '--no-fund'],
      { env: runtimeEnv(stage), cwd: stage })
    const versions = await verifyPrograms(stage)
    console.log('Recording runtime integrity manifest')
    const manifest = { schema: 1, platform: 'win32', arch: 'x64', recipeDigest, versions,
      archives: Object.fromEntries(await Promise.all(keys.map(async (key, i) => [key, { url: recipe.assets[key].url, sha256: await hash(downloads[i]) }]))),
      files: await inventory(stage) }
    await writeFile(join(stage, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
    await rename(stage, runtime)
  }
  const resultFile = process.argv[2]
  if (!resultFile || !isAbsolute(resultFile)) throw Error('Pass an absolute path for the build result JSON')
  await writeFile(resultFile, JSON.stringify({ root: runtime, recipeDigest }) + '\n')
  console.log('Offline runtime ready: ' + runtime)
}
