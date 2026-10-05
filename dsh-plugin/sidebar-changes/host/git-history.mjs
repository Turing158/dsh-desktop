import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { availability, git } from './git-provider.mjs'
import { hash, identity } from './paths.mjs'

const PAGE = 50, TTL = 5 * 60 * 1000
const oid = value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
const run = (root, args, signal, input) => git(root, ['--no-replace-objects', '-c', 'log.showSignature=false', ...args], signal, input)
async function optional(root, args, signal) {
  try { return (await run(root, args, signal)).toString('utf8').trim() }
  catch (error) { if (!signal?.aborted && error.code === 1) return ''; throw error }
}
async function shallowIds(root, signal) {
  const file = (await run(root, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow'], signal)).toString('utf8').trim()
  try { return (await readFile(file, 'utf8')).trim().split(/\s+/).filter(oid).sort() }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function snapshot(root, signal) {
  const available = await availability(root, signal)
  if (available.status !== 'available') throw Error(available.reason)
  const repo = available.root
  const [head, branch, raw, shallow] = await Promise.all([
    optional(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], signal),
    optional(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], signal),
    run(repo, ['for-each-ref', '--sort=refname', '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags'], signal),
    shallowIds(repo, signal),
  ])
  const refs = []
  if (head) refs.push({ id: head, name: 'HEAD', kind: 'head' })
  for (const row of raw.toString('utf8').split('\n').filter(Boolean)) {
    const [object, type, peeled, peeledType, ref, symbolic] = row.split('\0')
    if (symbolic) continue
    let id = type === 'commit' ? object : peeledType === 'commit' ? peeled : ''
    if (!id && type === 'tag') id = await optional(repo, ['rev-parse', '--verify', '--quiet', object + '^{commit}'], signal)
    if (!oid(id)) continue
    const kind = ref.startsWith('refs/heads/') ? 'branch' : ref.startsWith('refs/remotes/') ? 'remote' : 'tag'
    const name = ref.replace(/^refs\/(heads|remotes|tags)\//, '')
    refs.push({ id, name, kind, current: kind === 'branch' && name === branch })
  }
  const tips = [...new Set(refs.map(ref => ref.id))].sort()
  return { repositoryRoot: repo, head, branch, refs, tips, shallow,
    revision: hash(JSON.stringify([identity(repo), refs, shallow])) }
}

/** Scope-bound snapshots page from immutable tips while refs advance. Detail
 * lookup accepts only commits previously listed for this session and root. */
export class GitHistory {
  constructor() { this.snapshots = new Map(); this.active = 0 }
  key(scope, revision) { return JSON.stringify([scope.sessionId, identity(scope.root), revision]) }
  remember(scope, data) {
    const key = this.key(scope, data.revision), old = this.snapshots.get(key)
    const value = old && Date.now() - old.time < TTL ? old : { ...data, snapshotId: randomUUID(), allowed: new Set() }
    value.time = Date.now(); this.snapshots.delete(key); this.snapshots.set(key, value)
    while (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value)
    return value
  }
  get(scope, revision) {
    const data = this.snapshots.get(this.key(scope, revision))
    if (!data || Date.now() - data.time > TTL) throw Error('history-stale')
    data.time = Date.now()
    return data
  }
  async bounded(action) {
    if (this.active >= 8) throw Error('查询繁忙，请稍后重试')
    this.active++
    try { return await action() }
    catch (error) { if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('history-large'); throw error }
    finally { this.active-- }
  }
  list(scope, revision, offset, signal) {
    return this.bounded(async () => {
      if (typeof revision !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !revision && offset !== 0) throw Error('invalid-request')
      const data = revision ? this.get(scope, revision) : this.remember(scope, await snapshot(scope.root, signal))
      if (JSON.stringify(await shallowIds(data.repositoryRoot, signal)) !== JSON.stringify(data.shallow)) throw Error('history-stale')
      let entries = []
      if (data.tips.length) {
        const raw = await run(data.repositoryRoot, ['log', '--topo-order', '--no-decorate', '--no-color', '--encoding=UTF-8', '-z', '--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', `--skip=${offset}`, `--max-count=${PAGE + 1}`, '--stdin'], signal, data.tips.join('\n') + '\n')
        const fields = raw.toString('utf8').split('\0'); if (fields.at(-1) === '') fields.pop()
        if (fields.length % 9 !== 0) throw Error('invalid-history')
        for (let i = 0; i < fields.length; i += 9) {
          const [id, parentText, subject, author, authorEmail, authorDate, committer, committerEmail, commitDate] = fields.slice(i, i + 9)
          if (!oid(id)) throw Error('invalid-history')
          entries.push({ id, parents: parentText.split(' ').filter(oid), subject: subject.slice(0, 4096), author, authorEmail, authorDate, committer, committerEmail, commitDate,
            boundary: data.shallow.includes(id), refs: data.refs.filter(ref => ref.id === id) })
        }
      }
      signal?.throwIfAborted()
      if (JSON.stringify(await shallowIds(data.repositoryRoot, signal)) !== JSON.stringify(data.shallow)) throw Error('history-stale')
      const more = entries.length > PAGE; entries = entries.slice(0, PAGE)
      for (const entry of entries) data.allowed.add(entry.id)
      return { sessionId: scope.sessionId, workspaceRoot: scope.root, repositoryRoot: data.repositoryRoot,
        revision: data.revision, snapshotId: data.snapshotId, entries, nextOffset: more ? offset + entries.length : null, shallow: data.shallow.length > 0 }
    })
  }
  details(scope, revision, commitId, signal) {
    return this.bounded(async () => {
      const data = this.get(scope, revision)
      if (!oid(commitId) || !data.allowed.has(commitId)) throw Error('invalid-request')
      const raw = await run(data.repositoryRoot, ['show', '--no-patch', '--no-decorate', '--no-color', '--encoding=UTF-8', '--format=format:%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', commitId, '--'], signal)
      const [id, parents, author, authorEmail, authorDate, committer, committerEmail, commitDate, ...body] = raw.toString('utf8').split('\0')
      if (id !== commitId || body.length === 0) throw Error('invalid-history')
      signal?.throwIfAborted()
      return { id, parents: parents.split(' ').filter(oid), author, authorEmail, authorDate, committer, committerEmail, commitDate,
        message: body.join('\0'), refs: data.refs.filter(ref => ref.id === id), boundary: data.shallow.includes(id) }
    })
  }
}
