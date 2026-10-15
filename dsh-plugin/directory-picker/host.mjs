import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, posix, resolve, win32 } from 'node:path'

const MAX_ENTRIES = 1000
export const MAX_FILE_BYTES = 100 * 1024 * 1024
function absolutePath(path) {
  if (typeof path !== 'string' || path.includes('\0') || !(process.platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path))) throw Error('Invalid absolute file path')
  return resolve(path)
}
const compare = (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)

/** Browse regular files alongside folders, with the same host paths as workspace selection. */
export async function listFiles(path, signal) {
  signal?.throwIfAborted()
  const target = absolutePath(path ?? homedir()), entries = []
  let truncated = false
  for await (const entry of await opendir(target)) {
    signal?.throwIfAborted()
    let directory = entry.isDirectory(), file = entry.isFile()
    if (entry.isSymbolicLink()) {
      try { const info = await stat(join(target, entry.name)); directory = info.isDirectory(); file = info.isFile() }
      catch { signal?.throwIfAborted(); continue }
    }
    if (!directory && !file) continue
    const row = { name: entry.name, path: join(target, entry.name), hidden: entry.name.startsWith('.'), directory }
    // Keep only the first sorted page, even for very large directories.
    let lo = 0, hi = entries.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (compare(entries[mid], row) < 0) lo = mid + 1; else hi = mid }
    entries.splice(lo, 0, row)
    if (entries.length > MAX_ENTRIES) { entries.pop(); truncated = true }
  }
  signal?.throwIfAborted()
  const crumbs = []
  for (let current = target;; current = dirname(current)) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current })
    if (parent === current) break
  }
  return { path: target, home: homedir(), entries, crumbs, truncated }
}

/** Read a bounded regular file; preserve bytes and media type for the existing attachment intake. */
export async function readAttachment(path, signal) {
  signal?.throwIfAborted()
  const target = absolutePath(path), handle = await open(target, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw Error('请选择文件')
    if (info.size > MAX_FILE_BYTES) throw Error('文件超过 100 MB，请选择较小的文件')
    const data = Buffer.alloc(info.size)
    let offset = 0
    while (offset < data.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset)
      if (!bytesRead) throw Error('文件已更改，请重新选择')
      offset += bytesRead
    }
    signal?.throwIfAborted()
    const after = await handle.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw Error('文件已更改，请重新选择')
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.csv': 'text/csv', '.html': 'text/html' }[extname(target).toLowerCase()] || 'application/octet-stream'
    return { name: basename(target), type, lastModified: info.mtimeMs, data: data.toString('base64') }
  } finally { await handle.close() }
}

const execute = promisify(execFile)
async function windowsDrives(signal) {
  // Query the OS drive table without scanning disks or waiting for network shares.
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[System.Environment]::GetLogicalDrives() | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 5000, maxBuffer: 16384, signal })
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]')
}

export async function listRoots(signal, { platform = process.platform, readDrives = windowsDrives } = {}) {
  signal?.throwIfAborted()
  if (platform !== 'win32') return [{ name: '/', path: '/', hidden: false }]
  const drives = await readDrives(signal)
  signal?.throwIfAborted()
  const paths = Array.isArray(drives) ? drives : [drives]
  if (!paths.every(path => typeof path === 'string' && /^[A-Za-z]:\\$/.test(path))) throw Error('Invalid drive list')
  return [...new Set(paths.map(path => path.toUpperCase()))].sort()
    .map(path => ({ name: path, path, hidden: false }))
}
