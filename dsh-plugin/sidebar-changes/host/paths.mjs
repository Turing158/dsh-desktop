import path from 'node:path'
import { realpath, lstat, readFile, readlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { LIMITS } from '../shared/change-model.mjs'
export const hash = value => createHash('sha256').update(value).digest('hex')
export const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
export async function rootPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('missing')
  return realpath(value)
}
export function relative(root, file) {
  const value = path.relative(root, path.resolve(root, file))
  if (!value || value === '..' || value.startsWith('..' + path.sep) || path.isAbsolute(value)) return null
  return value.split(path.sep).join('/')
}
export function decode(buffer) {
  if (buffer.length > LIMITS.bytes) return { text: null, reason: 'large', hash: hash(buffer) }
  if (buffer.includes(0)) return { text: null, reason: 'binary', hash: hash(buffer) }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), reason: null, hash: hash(buffer) } }
  catch { return { text: null, reason: 'encoding', hash: hash(buffer) } }
}
export const absent = () => ({ exists: false, text: '', hash: null, reason: null, mode: null })
/** Never follow links outside the session root, including junction ancestors. */
export async function readEndpoint(root, file, options = {}) {
  if (!relative(root, file)) throw Error('outside-root')
  const absolute = path.resolve(root, file)
  try {
    const parent = await realpath(path.dirname(absolute))
    if (identity(parent) !== identity(root) && !relative(root, parent)) throw Error('outside-root')
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink()) return { exists: true, text: null, hash: hash(await readlink(absolute)), reason: 'symlink', mode: '120000' }
    if (!stat.isFile()) return { exists: true, text: null, hash: null, reason: 'submodule', mode: '160000' }
    const mode = stat.mode & 0o111 ? '100755' : '100644'
    const fingerprint = hash(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.mode}`)
    if (stat.size > LIMITS.bytes) return { exists: true, text: null, hash: fingerprint, fingerprint, reason: 'large', mode }
    if (stat.size > (options.maxBytes ?? Infinity)) return { exists: true, text: null, hash: fingerprint, fingerprint, reason: 'scan-content', mode }
    // Still stat every path, but share unchanged immutable endpoints with the
    // baseline instead of reading/hashing/allocating their contents again.
    const previous = options.previous
    if (previous?.fingerprint === fingerprint && previous.reason !== 'scan-content') return previous
    const data = await readFile(absolute), again = await lstat(absolute)
    if (stat.size !== again.size || stat.mtimeMs !== again.mtimeMs || stat.ino !== again.ino) throw Error('stale')
    return { exists: true, ...decode(data), fingerprint, mode }
  } catch (error) { if (error.code === 'ENOENT') return absent(); throw error }
}

// Resolve existing ancestors of newly created or deleted paths too.
export async function fileIdentity(file) {
  let current = path.resolve(file), suffix = []
  try { if ((await lstat(current)).isSymbolicLink()) return identity(path.join(await realpath(path.dirname(current)), path.basename(current))) }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
  while (true) {
    try { return identity(path.join(await realpath(current), ...suffix)) }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) return identity(file)
      suffix.unshift(path.basename(current)); current = parent
    }
  }
}
