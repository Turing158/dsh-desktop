import { execFile } from 'node:child_process'
import path from 'node:path'
import { LIMITS, diffText, unknownDiff } from '../shared/change-model.mjs'
import { hash, relative, readEndpoint, decode, absent, rootPath } from './paths.mjs'

export function git(cwd, args, signal, input, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
      cwd, windowsHide: true, shell: false, encoding: 'buffer', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', ...environment }, signal,
    }, (error, stdout, stderr) => {
      if (error) { error.gitMessage = stderr?.toString('utf8') || ''; reject(error) }
      else resolve(stdout)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}
export async function availability(root, signal) {
  try {
    const repo = (await git(root, ['rev-parse', '--show-toplevel'], signal)).toString('utf8').trimEnd()
    return { status: 'available', root: await rootPath(repo), reason: null }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error.code === 'ENOENT') return { status: 'missing', reason: '未找到 Git 程序' }
    if (/not a git repository/i.test(error.gitMessage)) return { status: 'none', reason: '当前会话目录不在 Git 仓库中' }
    return { status: 'error', reason: 'Git 仓库读取失败，请重试' }
  }
}
function rawEntries(buffer) {
  const parts = buffer.toString('utf8').split('\0'), entries = []
  for (let i = 0; i < parts.length && parts[i];) {
    const [beforeMode, afterMode, beforeOid, afterOid, status] = parts[i++].slice(1).split(' ')
    const first = parts[i++], renamed = status.startsWith('R') || status.startsWith('C')
    entries.push({ beforeMode, afterMode, beforeOid, afterOid, status: status[0], beforePath: first, path: renamed ? parts[i++] : first })
  }
  return entries
}
async function blob(repo, oid, mode, signal) {
  if (/^0+$/.test(oid)) return absent()
  if (mode === '160000') return { exists: true, text: null, hash: oid, reason: 'submodule', mode }
  if (mode === '120000') return { exists: true, text: null, hash: oid, reason: 'symlink', mode }
  const size = Number((await git(repo, ['cat-file', '-s', oid], signal)).toString())
  if (size > LIMITS.bytes) return { exists: true, text: null, hash: oid, reason: 'large', mode }
  return { exists: true, ...decode(await git(repo, ['cat-file', 'blob', oid], signal)), mode }
}
async function base(repo, signal) {
  try { return (await git(repo, ['rev-parse', '--verify', 'HEAD'], signal)).toString().trim() }
  catch (error) {
    if (signal?.aborted) throw error
    // An unborn branch has no HEAD ref; corrupt or unreadable repositories fail.
    const symbolic = (await git(repo, ['symbolic-ref', '-q', 'HEAD'], signal)).toString().trim()
    try { await git(repo, ['show-ref', '--verify', symbolic], signal); throw Error('git-head') }
    catch (missing) { if (missing.code !== 1 && missing.code !== 128) throw missing }
    return (await git(repo, ['hash-object', '-t', 'tree', '--stdin'], signal, '')).toString().trim()
  }
}
export async function listGit(root, source, signal, environment = {}) {
  const query = (cwd, args, cancellation) => git(cwd, args, cancellation, undefined, environment)
  root = await rootPath(root)
  const available = await availability(root, signal)
  if (available.status !== 'available') throw Error(available.reason)
  const repo = available.root, head = await base(repo, signal)
  const args = ['diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--find-renames', ...(source === 'staged' ? ['--cached'] : []), head, '--']
  const raw = await query(repo, args, signal), candidates = rawEntries(raw)
  const unmerged = await query(repo, ['ls-files', '--unmerged', '-z'], signal)
  const conflicts = new Set(unmerged.toString('utf8').split('\0').filter(Boolean).map(record => record.slice(record.indexOf('\t') + 1)))
  for (const file of conflicts) {
    const item = candidates.find(item => item.path === file)
    if (item) item.status = 'U'
    else candidates.push({ path: file, beforePath: file, beforeMode: '000000', afterMode: '000000', beforeOid: '0', afterOid: '0', status: 'U' })
  }
  const untrackedArgs = ['ls-files', '--others', '--exclude-standard', '-z']
  const untracked = source === 'working' ? await query(repo, untrackedArgs, signal) : Buffer.alloc(0)
  for (const file of untracked.toString('utf8').split('\0').filter(Boolean)) candidates.push({ path: file, beforePath: file, beforeMode: '000000', afterMode: '100644', beforeOid: '0', afterOid: '0', status: 'A' })
  const unique = new Map()
  for (const item of candidates) if (!unique.has(item.path) || item.status === 'U') unique.set(item.path, item)
  const filtered = [...unique.values()].filter(item => relative(root, path.join(repo, item.path)) || relative(root, path.join(repo, item.beforePath)))
  if (filtered.length > LIMITS.files) throw Error('更改文件超过 2000 个，请缩小会话目录后重试')
  const entries = [], versions = []
  let bytes = 0
  for (const item of filtered) {
    signal?.throwIfAborted()
    const newPath = relative(root, path.join(repo, item.path)), oldPath = relative(root, path.join(repo, item.beforePath))
    const before = oldPath ? await blob(repo, item.beforeOid, item.beforeMode, signal) : absent()
    let after = absent()
    if (newPath && item.status !== 'D' && item.status !== 'U') {
      after = source === 'staged' ? await blob(repo, item.afterOid, item.afterMode, signal) : await readEndpoint(root, path.join(repo, item.path))
      // On Windows POSIX execute bits are synthesized; Git owns mode semantics.
      if (source === 'working' && after.mode !== '120000' && after.mode !== '160000' && item.afterMode !== '000000') after.mode = item.afterMode
    }
    let status = !before.exists ? 'added' : !after.exists ? 'deleted' : item.status === 'R' ? 'renamed' : 'modified'
    const reason = item.status === 'U' ? 'conflict' : before.reason || after.reason
    if (reason === 'conflict' || reason === 'submodule' || reason === 'symlink') status = reason
    if (!reason && before.exists === after.exists && before.mode === after.mode && status !== 'renamed' && before.hash === after.hash) continue
    const diff = reason ? unknownDiff(reason) : diffText(before.text, after.text)
    bytes += Buffer.byteLength(before.text || '') + Buffer.byteLength(after.text || '')
    if (bytes > LIMITS.scanBytes) throw Error('large')
    const name = newPath || oldPath
    entries.push({ fileId: hash(name), path: name, previousPath: status === 'renamed' ? oldPath : null, status,
      completeness: 'complete', reason: diff.reason, stats: diff.stats, diff, before, after, operations: [] })
    versions.push([name, before.hash, after.hash, before.mode, after.mode])
  }
  // Refuse a changing index/HEAD/file inventory. Details subsequently use these
  // immutable endpoints, rather than rereading a newer index or working file.
  if (head !== await base(repo, signal) || !raw.equals(await query(repo, args, signal)) || source === 'working' && !untracked.equals(await query(repo, untrackedArgs, signal))) throw Error('stale')
  if (!unmerged.equals(await query(repo, ['ls-files', '--unmerged', '-z'], signal))) throw Error('stale')
  if (source === 'working') for (const entry of entries) {
    if (entry.reason === 'conflict') continue
    const latest = await readEndpoint(root, entry.path)
    if (latest.hash !== entry.after.hash || latest.exists !== entry.after.exists) throw Error('stale')
  }
  return { revision: hash(JSON.stringify([head, source, versions])), entries, gaps: [], completeness: 'complete' }
}
