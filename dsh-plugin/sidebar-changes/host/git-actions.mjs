import { execFile } from 'node:child_process'
import path from 'node:path'
import { git, availability } from './git-provider.mjs'
import { identity, relative, rootPath, fileIdentity, readEndpoint } from './paths.mjs'
import { SOURCES, REASONS } from '../shared/change-model.mjs'

// One index writer per worktree, shared by all sessions and API instances.
const writers = new Set()
const receipts = new Map()
const fail = code => { throw Error(code) }
const text = buffer => buffer.toString('utf8').trim()

function writeGit(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
      cwd, windowsHide: true, shell: false, encoding: 'buffer', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      error.gitMessage = (stderr?.toString('utf8') || stdout?.toString('utf8') || '').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 4000)
      reject(error)
    })
    // A closed view must not kill Git halfway through a hook or index write.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

async function config(root, key, signal) {
  try { return text(await git(root, ['config', '--get', key], signal)) }
  catch (error) { if (error.code === 1) return ''; throw error }
}

export async function pushTarget(root, signal) {
  let branch
  try { branch = text(await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)) }
  catch (error) { if (error.code === 1) fail('git-detached'); throw error }
  const trackedRemote = await config(root, `branch.${branch}.remote`, signal)
  const pushRemote = await config(root, `branch.${branch}.pushRemote`, signal) || await config(root, 'remote.pushDefault', signal)
  const remotes = text(await git(root, ['remote'], signal)).split('\n').filter(Boolean)
  const remote = pushRemote || trackedRemote || (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '')
  if (!remote || remote !== '.' && !remotes.includes(remote)) fail('git-no-remote')
  const merge = await config(root, `branch.${branch}.merge`, signal)
  const ref = remote === trackedRemote && merge ? merge : `refs/heads/${branch}`
  if (!ref.startsWith('refs/heads/')) fail('git-no-remote')
  await git(root, ['check-ref-format', ref], signal)
  const urls = remote === '.' ? ['.'] : text(await git(root, ['remote', 'get-url', '--push', '--all', remote], signal)).split('\n')
  return { branch, remote, ref, urls, setUpstream: !trackedRemote || !merge }
}

async function checkIndex(root, signal) {
  if ((await git(root, ['ls-files', '--unmerged', '-z'], signal)).length) fail('git-conflict')
  const names = (await git(root, ['diff', '--cached', '--name-only', '--no-relative', '--no-renames', '-z'], signal)).toString('utf8').split('\0').filter(Boolean)
  // git commit consumes the whole index, even when cwd is a repository subtree.
  const repo = (await availability(root, signal)).root
  if (!repo) fail('git-unavailable')
  if (names.some(name => !relative(root, path.join(repo, name)))) fail('git-outside-index')
  return names
}

/** Fixed Git commands only; paths come from the server's reviewed change list. */
export class GitActions {
  constructor(readChanges, contexts) { this.readChanges = readChanges; this.contexts = contexts }

  async key(scope) { return identity(await rootPath(text(await git(scope.root, ['rev-parse', '--absolute-git-dir'])))) }
  async switchBranch(scope, branch, revision, signal) {
    const saved = this.contexts.snapshots.get(revision)
    if (!saved) fail('stale')
    const key = await this.key(scope)
    if (writers.has(key)) fail('git-busy')
    writers.add(key)
    try {
      await this.contexts.validate(scope, saved.context.source, revision, signal)
      if (branch !== saved.context.branch) {
        if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.includes('\0')) fail('git-invalid-action')
        await git(scope.root, ['check-ref-format', 'refs/heads/' + branch], signal)
        await git(scope.root, ['show-ref', '--verify', '--', 'refs/heads/' + branch], signal)
        signal?.throwIfAborted()
        await writeGit(scope.root, ['switch', '--no-guess', '--', branch])
      }
      return await this.contexts.read(scope, saved.context.source, signal)
    } finally { writers.delete(key) }
  }

  async status(scope, revision) {
    const record = receipts.get(await this.key(scope))
    return record?.revision === revision ? record.state : { phase: 'unknown', error: { code: 'git-result-unknown', detail: '' } }
  }

  async *tracked(scope, action, source, revision, message, committedId, signal) {
    const key = await this.key(scope), previous = receipts.get(key)
    if (previous?.running) { yield { phase: 'error', error: { code: 'git-busy', detail: '' } }; return }
    const record = { revision, running: true, state: { phase: 'starting', action, commitId: committedId || '' }, listeners: new Set() }
    receipts.set(key, record)
    // Drain independently of the transport iterator. Losing a view/connection never aborts a write.
    const queue = []; let wake
    const changed = state => { queue.push(state); wake?.() }
    record.listeners.add(changed)
    void (async () => {
      try {
        for await (const state of this.run(scope, action, source, revision, message, committedId, new AbortController().signal)) {
          record.state = state; for (const listener of record.listeners) listener(state)
        }
      } finally { record.running = false; wake?.() }
    })()
    const abort = () => wake?.()
    signal?.addEventListener('abort', abort)
    try {
      while (!signal?.aborted) {
        if (queue.length) { yield queue.shift(); continue }
        if (!record.running) break
        await new Promise(resolve => { wake = resolve; if (queue.length || !record.running || signal?.aborted) resolve() })
      }
    } finally { record.listeners.delete(changed); signal?.removeEventListener('abort', abort) }
  }

  async stage(scope, source, revision, signal) {
    if (source === 'staged') fail('git-invalid-action')
    const data = await this.readChanges(scope, source, signal)
    if (data.revision !== revision) fail('stale')
    if (!data.entries.length) fail('git-empty-stage')
    const paths = new Set()
    for (const entry of data.entries) {
      if (entry.root && identity(entry.root) !== identity(scope.root)) fail('git-other-root')
      if (source === 'session') {
        const current = await readEndpoint(scope.root, entry.path)
        if (current.hash !== entry.after.hash || current.exists !== entry.after.exists) fail('stale')
      }
      for (const name of [entry.path, entry.previousPath].filter(Boolean)) {
        const absolute = path.resolve(scope.root, name)
        if (!relative(scope.root, absolute) || !relative(scope.root, await fileIdentity(absolute))) fail('git-other-root')
        paths.add(relative(scope.root, absolute))
      }
    }
    signal?.throwIfAborted()
    // NUL-delimited literal paths cover spaces, renames, removals and leading '-'.
    await writeGit(scope.root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], [...paths].join('\0') + '\0')
  }

  async *run(scope, action, source, revision, message, committedId, signal) {
    let lock, commitId = committedId || '', target, snapshot
    try {
      if (!['stage', 'commit', 'push', 'pushOnly'].includes(action) || !SOURCES.includes(source) || action === 'stage' && source === 'staged') fail('git-invalid-action')
      if (typeof revision !== 'string' || typeof committedId !== 'string' || committedId && (action !== 'push' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(committedId))) fail('git-invalid-action')
      if (!['stage', 'pushOnly'].includes(action) && !committedId && (typeof message !== 'string' || !message.trim() || message.length > 65536 || message.includes('\0'))) fail('git-message')
      const root = await rootPath(scope.root), available = await availability(root, signal)
      if (available.status !== 'available') fail('git-unavailable')
      scope = { ...scope, root }
      const key = identity(await rootPath(text(await git(root, ['rev-parse', '--absolute-git-dir'], signal))))
      if (writers.has(key)) fail('git-busy')
      writers.add(key); lock = key
      if (action === 'push' || action === 'pushOnly') target = await pushTarget(root, signal)
      if (revision.startsWith('git-context-v1:') && !committedId) {
        snapshot = await this.contexts.validate(scope, source, revision, signal)
        if (action === 'pushOnly' && !snapshot.context.canPush) fail(snapshot.context.pushReason || 'git-no-head')
        if (action !== 'pushOnly' && !snapshot.context.hasCommittableChanges) fail(snapshot.context.commitReason || 'git-empty-index')
      } else if (action === 'pushOnly') fail('stale')
      if (committedId) {
        const retry = this.retries?.get(key + committedId)
        if (!retry || retry.root !== identity(root) || JSON.stringify(retry.target) !== JSON.stringify(target)) fail('git-head-changed')
      }
      if (!committedId && action !== 'pushOnly') {
        // Reject unresolved conflicts before auto-staging can mark them resolved.
        if (action !== 'stage') await checkIndex(root, signal)
        if (source !== 'staged') {
          yield { phase: 'staging', commitId }
          if (snapshot) {
            // Stage precisely the reviewed path set, including index/worktree reversals.
            await this.contexts.validate(scope, source, revision, signal)
            if (snapshot.paths.length) await writeGit(snapshot.meta.repositoryRoot, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], snapshot.paths.join('\0') + '\0')
          } else await this.stage(scope, source, revision, signal)
        } else if (!snapshot && (await this.readChanges(scope, source, signal)).revision !== revision) {
          fail('stale')
        }
        if (action !== 'stage') {
          yield { phase: 'committing', commitId }
          if (!(await checkIndex(root, signal)).length) fail('git-empty-index')
          if (snapshot) {
            const current = await this.contexts.read(scope, source, signal)
            if (current.branch !== snapshot.context.branch || current.head !== snapshot.context.head
              || this.contexts.snapshots.get(current.contextRevision).tree !== snapshot.tree
              || text(await git(root, ['write-tree'], signal)) !== snapshot.tree) fail('stale')
            await this.contexts.validateFiles(scope, snapshot, signal)
          }
          signal?.throwIfAborted()
          await writeGit(root, ['commit', '--file=-', '--cleanup=verbatim'], message.replace(/\r\n?/g, '\n').replace(/\n?$/, '\n'))
          commitId = text(await git(root, ['rev-parse', '--verify', 'HEAD']))
        }
      }
      if (action === 'pushOnly') commitId = snapshot.context.head
      if (action === 'push' || action === 'pushOnly') {
        this.retries ||= new Map()
        this.retries.set(key + commitId, { root: identity(root), target })
        yield { phase: 'pushing', commitId }
        signal?.throwIfAborted()
        if (text(await git(root, ['rev-parse', '--verify', 'HEAD'], signal)) !== commitId || text(await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)) !== target.branch) fail('git-head-changed')
        if (JSON.stringify(await pushTarget(root, signal)) !== JSON.stringify(target)) fail('git-head-changed')
        // Push only this branch, never force, mirror, or implicitly include tags.
        await writeGit(root, ['push', '--no-force', '--no-mirror', '--no-follow-tags', ...(target.setUpstream ? ['--set-upstream'] : []), '--', target.remote, `refs/heads/${target.branch}:${target.ref}`])
      }
      yield { phase: 'done', action, commitId }
    } catch (error) {
      const code = REASONS[error?.message] ? error.message : error?.killed ? 'git-timeout' : 'git-failed'
      yield { phase: 'error', action, commitId, error: { code, detail: error.gitMessage || '' } }
    } finally { if (lock) writers.delete(lock) }
  }
}
