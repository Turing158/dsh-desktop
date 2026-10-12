import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
