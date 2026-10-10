import path from 'node:path'
import { readFile, writeFile, unlink, utimes } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { git, availability, listGit } from './git-provider.mjs'
import { hash, identity, relative, rootPath, readEndpoint, fileIdentity } from './paths.mjs'
import { LIMITS } from '../shared/change-model.mjs'
import { pushTarget } from './git-actions.mjs'

const text = value => value.toString('utf8').trim()
const names = value => value.toString('utf8').split('\0').filter(Boolean)
export const CONTEXT_PREFIX = 'git-context-v1:'
export async function gitIdentity(root, signal) {
  const available = await availability(root, signal)
  if (available.status !== 'available') throw Error('git-unavailable')
  const gitDir = await rootPath(text(await git(root, ['rev-parse', '--absolute-git-dir'], signal)))
  let branch = null, head = null
  try { branch = text(await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)) }
  catch (error) { if (error.code !== 1) throw error }
  try { head = text(await git(root, ['rev-parse', '--verify', 'HEAD'], signal)) }
  catch (error) { if (!branch || error.code !== 128 && error.code !== 1) throw error }
  let target = null, pushReason = null
  try { target = await pushTarget(root, signal) }
  catch (error) { if (!['git-no-remote', 'git-detached'].includes(error.message)) throw error; pushReason = error.message }
  return { repositoryRoot: available.root, worktreeId: identity(gitDir), gitDir, branch, head, target, pushReason }
}

/** The index copy is disposable. Queries never stage into the user's index. */
export class GitContexts {
  constructor(endpointId, generator) { this.endpointId = endpointId; this.generator = generator; this.snapshots = new Map() }
  async endpoints(root, meta, signal) {
    const base = meta.head || text(await git(root, ['hash-object', '-t', 'tree', '--stdin'], signal, ''))
    const sets = await Promise.all([
      git(meta.repositoryRoot, ['diff', '--cached', '--name-only', '--no-renames', '-z', base, '--'], signal),
      git(meta.repositoryRoot, ['diff', '--name-only', '--no-renames', '-z', '--'], signal),
      git(meta.repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
    ])
    const paths = [...new Set(sets.flatMap(names))].filter(name => relative(root, path.join(meta.repositoryRoot, name))).sort()
    const tracked = new Set(names(await git(meta.repositoryRoot, ['ls-files', '-z'], signal)))
    if (paths.length > LIMITS.files) throw Error('large')
    const versions = []
    let bytes = 0
    for (const name of paths) {
      signal?.throwIfAborted()
      const absolute = path.join(meta.repositoryRoot, name), local = relative(root, absolute)
      if (!relative(root, await fileIdentity(absolute))) throw Error('git-other-root')
      const endpoint = await readEndpoint(root, local)
      bytes += Buffer.byteLength(endpoint.text || '')
      if (bytes > LIMITS.scanBytes) throw Error('large')
      versions.push([name, endpoint.exists, endpoint.hash, endpoint.mode, endpoint.fingerprint])
    }
    const indexPath = path.resolve(root, text(await git(root, ['rev-parse', '--git-path', 'index'], signal)))
    let index = null
    try { index = await readFile(indexPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { paths: paths.filter((name, i) => versions[i][1] || tracked.has(name)), versions, index, fingerprint: hash(JSON.stringify([versions, index && hash(index)])) }
  }
  async read(scope, source, signal) {
    if (!['working', 'staged'].includes(source)) throw Error('invalid-source')
    const root = await rootPath(scope.root), meta = await gitIdentity(root, signal)
    const before = await this.endpoints(root, meta, signal)
    const unmerged = await git(root, ['ls-files', '--unmerged', '-z'], signal)
    const indexPath = path.join(meta.gitDir, 'dsh-preview-' + randomUUID()), environment = { GIT_INDEX_FILE: indexPath }
    let data, tree = null, commitReason = unmerged.length ? 'git-conflict' : !meta.branch ? 'git-detached' : null
    const stagedNames = names(await git(meta.repositoryRoot, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--'], signal))
    if (stagedNames.some(name => !relative(root, path.join(meta.repositoryRoot, name)))) commitReason = 'git-outside-index'
    try {
      if (unmerged.length) data = await listGit(root, source, signal)
      else {
        if (before.index) {
          await writeFile(indexPath, before.index, { flag: 'wx' })
          // A fresh copy's mtime must not make racy cached stat entries look clean.
          // Git rehashes selected files whose mtime is newer than the index timestamp.
          await utimes(indexPath, 1, 1)
        }
        else await git(root, ['read-tree', '--empty'], signal, undefined, environment)
        // Include both ends of staged reversals/renames, even if HEAD -> worktree has no diff.
        if (source === 'working' && before.paths.length) await git(meta.repositoryRoot,
          ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], signal, before.paths.join('\0') + '\0', environment)
        tree = text(await git(root, ['write-tree'], signal, undefined, environment))
        data = await listGit(root, 'staged', signal, environment)
      }
    } finally {
      await Promise.all([indexPath, indexPath + '.lock'].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })))
    }
    const afterMeta = await gitIdentity(root, signal), after = await this.endpoints(root, afterMeta, signal)
    if (before.fingerprint !== after.fingerprint || JSON.stringify(meta) !== JSON.stringify(afterMeta)) throw Error('stale')
    let upstream = null, ahead = null, behind = null, pushAhead = null
    if (meta.head && meta.branch) {
      const tracking = text(await git(root, ['for-each-ref', '--format=%(upstream)', 'refs/heads/' + meta.branch], signal))
      if (tracking) {
        upstream = tracking
        try { [ahead, behind] = text(await git(root, ['rev-list', '--left-right', '--count', `HEAD...${tracking}`, '--'], signal)).split(/\s+/).map(Number) }
        catch (error) { if (signal?.aborted) throw error }
      }
      // Only call it up to date when the configured push target is the tracked branch.
      if (meta.target && upstream) {
        const pushRef = meta.target.remote === '.' ? meta.target.ref : `refs/remotes/${meta.target.remote}/${meta.target.ref.slice(11)}`
        if (pushRef === upstream) pushAhead = ahead
      }
    }
    const known = data.entries.filter(entry => entry.stats.added !== null && entry.stats.removed !== null)
    const statisticsComplete = known.length === data.entries.length
    const contextRevision = CONTEXT_PREFIX + hash(JSON.stringify([this.endpointId, identity(root), meta, source, before.fingerprint, tree]))
    const canGenerateMessage = Boolean(await this.generator?.available(scope, signal))
    const context = { endpointId: this.endpointId, repositoryRoot: meta.repositoryRoot, workspaceRoot: root, worktreeId: meta.worktreeId,
      branch: meta.branch, head: meta.head, unborn: !meta.head && Boolean(meta.branch), source, contextRevision,
      upstream, ahead, behind, target: meta.target && { branch: meta.target.branch, remote: meta.target.remote, ref: meta.target.ref,
        destinationId: hash(JSON.stringify(meta.target.urls)) }, canPush: Boolean(meta.head && meta.target && pushAhead !== 0),
      canPushAfterCommit: Boolean(meta.branch && meta.target), pushReason: meta.pushReason || (!meta.head ? 'git-no-head' : pushAhead === 0 ? 'git-up-to-date' : null),
      hasCommittableChanges: data.entries.length > 0 && !commitReason, commitReason: commitReason || (!data.entries.length ? 'git-empty-index' : null),
      added: known.length || statisticsComplete ? known.reduce((sum, entry) => sum + entry.stats.added, 0) : null,
      removed: known.length || statisticsComplete ? known.reduce((sum, entry) => sum + entry.stats.removed, 0) : null,
      statisticsComplete, canGenerateMessage }
    this.snapshots.set(contextRevision, { context, meta, tree, paths: before.paths, versions: before.versions, endpoints: before.fingerprint, data, time: Date.now() })
    while (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value)
    return context
  }
  snapshot(scope, source, revision) {
    const value = this.snapshots.get(revision)
    if (!value || Date.now() - value.time > 300000 || identity(scope.root) !== identity(value.context.workspaceRoot) || source !== value.context.source) throw Error('stale')
    return value
  }
  async validate(scope, source, revision, signal) {
    const expected = this.snapshot(scope, source, revision)
    if ((await this.read(scope, source, signal)).contextRevision !== revision) throw Error('stale')
    return expected
  }
  async validateFiles(scope, snapshot, signal) {
    for (const [name, exists, fingerprint, mode, stat] of snapshot.versions) {
      signal?.throwIfAborted()
      const current = await readEndpoint(scope.root, path.join(snapshot.meta.repositoryRoot, name))
      if (current.exists !== exists || current.hash !== fingerprint || current.mode !== mode || current.fingerprint !== stat) throw Error('stale')
    }
  }
  async branches(scope, signal) {
    // This menu does not need HEAD objects, push targets or commit snapshots.
    const [repo, current, refs] = await Promise.all([
      availability(scope.root, signal),
      git(scope.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal).catch(error => { if (error.code === 1) return null; throw error }),
      git(scope.root, ['for-each-ref', '--format=%(refname:short)%00%(worktreepath)', 'refs/heads/'], signal),
    ])
    if (repo.status !== 'available') throw Error('git-unavailable')
    const rows = text(refs)
    return { branch: current ? text(current) : null, branches: rows ? rows.split('\n').map(row => {
      const [name, worktree] = row.split('\0')
      return { name, disabled: Boolean(worktree && identity(worktree) !== identity(repo.root)), reason: worktree && identity(worktree) !== identity(repo.root) ? 'git-branch-in-use' : null }
    }) : [] }
  }
  async generate(scope, source, revision, signal) {
    const snapshot = await this.validate(scope, source, revision, signal)
    if (!snapshot.context.canGenerateMessage) throw Error('git-generation-unavailable')
    if (!snapshot.context.hasCommittableChanges) throw Error(snapshot.context.commitReason || 'git-empty-index')
    const message = await this.generator.generate(scope, snapshot.data, signal)
    if (typeof message !== 'string' || !message.trim() || message.length > 65536 || message.includes('\0')) throw Error('git-generation-failed')
    await this.validate(scope, source, revision, signal)
    return { message, contextRevision: revision }
  }
}
