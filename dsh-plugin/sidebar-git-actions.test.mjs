import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, realpath, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ChangesApi } from './sidebar-changes/host/api.mjs'
import { SnapshotStore } from './sidebar-changes/host/snapshot-store.mjs'
import { git } from './sidebar-changes/host/git-provider.mjs'
import { hash, absent } from './sidebar-changes/host/paths.mjs'
import { contribution } from './sidebar-changes/shared/change-model.mjs'
import { createGitOperation, gitBusy } from './sidebar-changes/git-operation.mjs'
import { gitListStatistics } from './sidebar-changes/git-preview.mjs'
import { createCommitMessageGenerator } from './sidebar-changes/host/commit-message.mjs'

const signal = () => new AbortController().signal
const readGit = async (root, args) => (await git(root, args)).toString('utf8').trim()
const collect = async stream => { const values = []; for await (const value of stream) values.push(value); return values }
const last = values => values.at(-1)
async function fixture(t) {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(parent, 'dsh-git-actions-')))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent)
    assert.ok(path.basename(root).startsWith('dsh-git-actions-'))
    await rm(root, { recursive: true, force: true })
  })
  const workspace = path.join(root, '项目 空格'); await mkdir(workspace)
  await git(workspace, ['init', '-b', 'main'])
  for (const [name, value] of [['user.name', 'Git action test'], ['user.email', 'git-action@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', path.join(workspace, '.git/hooks')]]) await git(workspace, ['config', name, value])
  const scope = { sessionId: 'test', root: workspace }, store = new SnapshotStore(path.join(root, 'snapshots')), api = new ChangesApi(store)
  const run = async (action, source = 'working', message = '', committedId = '') => {
    const data = await api.listChanges(scope, source, signal())
    return collect(api.runGitAction(scope, action, source, data.revision, message, committedId, signal()))
  }
  const seed = async () => {
    await writeFile(path.join(workspace, 'code.txt'), 'before\n')
    await git(workspace, ['add', '--', 'code.txt']); await git(workspace, ['commit', '-m', 'base'])
  }
  const remote = async () => {
    const target = path.join(root, 'remote.git'); await mkdir(target)
    await git(target, ['init', '--bare', '-b', 'main']); await git(workspace, ['remote', 'add', 'origin', target])
    return target
  }
  return { root, workspace, scope, store, api, run, seed, remote }
}

test('stage uses literal view paths for additions, edits, deletes and renames without committing', async t => {
  const f = await fixture(t); await f.seed()
  await writeFile(path.join(f.workspace, 'deleted.txt'), 'remove\n')
  await git(f.workspace, ['add', '.']); await git(f.workspace, ['commit', '-m', 'second'])
  const head = await readGit(f.workspace, ['rev-parse', 'HEAD'])
  await rename(path.join(f.workspace, 'code.txt'), path.join(f.workspace, 'renamed 空格.txt'))
  await unlink(path.join(f.workspace, 'deleted.txt'))
  await writeFile(path.join(f.workspace, '-literal[1].txt'), 'new\n')
  await writeFile(path.join(f.workspace, 'literal1.txt'), 'untouched\n')
  const values = await f.run('stage')
  assert.deepEqual(values.map(v => v.phase), ['staging', 'done'])
  assert.equal(await readGit(f.workspace, ['rev-parse', 'HEAD']), head)
  assert.equal(await readGit(f.workspace, ['diff', '--name-only']), '')
  assert.equal(await readGit(f.workspace, ['show', ':renamed 空格.txt']), 'before')
  assert.equal(await readGit(f.workspace, ['show', ':-literal[1].txt']), 'new')
  assert.equal(await readFile(path.join(f.workspace, 'literal1.txt'), 'utf8'), 'untouched\n')
})

test('commit from working stages the view and preserves a multiline message without pushing', async t => {
  const f = await fixture(t), remote = await f.remote()
  await writeFile(path.join(f.workspace, 'code.txt'), 'working\n')
  await writeFile(path.join(f.workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  const message = 'feat: 完成工作\n\n# Keep this body\n`literal` $(literal) "quotes"\n'
  const values = await f.run('commit', 'working', message)
  assert.deepEqual(values.map(v => v.phase), ['staging', 'committing', 'done'])
  assert.equal(await readGit(f.workspace, ['log', '-1', '--format=%B']), message.trimEnd())
  assert.equal(await readGit(f.workspace, ['show', 'HEAD:code.txt']), 'working')
  assert.equal(await readGit(remote, ['for-each-ref', '--format=%(refname)']), '')
  assert.equal(await readGit(f.workspace, ['status', '--porcelain']), '')
})

test('repeated staging skips already-staged deletions and rename sources while keeping changes readable', async t => {
  const f = await fixture(t); await f.seed()
  const deleted = '新建 文本文档.txt', renamed = '-重命名[1].txt'
  await writeFile(path.join(f.workspace, deleted), 'remove\n')
  await git(f.workspace, ['add', '.']); await git(f.workspace, ['commit', '-m', 'deletion fixture'])
  await unlink(path.join(f.workspace, deleted))
  await rename(path.join(f.workspace, 'code.txt'), path.join(f.workspace, renamed))
  assert.equal(last(await f.run('stage')).phase, 'done')
  await writeFile(path.join(f.workspace, 'new.txt'), 'new\n')
  const result = last(await f.run('stage'))
  assert.equal(result.phase, 'done', JSON.stringify(result))
  assert.equal(await readGit(f.workspace, ['show', ':new.txt']), 'new')
  assert.equal(await readGit(f.workspace, ['show', ':' + renamed]), 'before')
  assert.equal(await readGit(f.workspace, ['ls-files', '--', deleted, 'code.txt']), '')
  for (const source of ['working', 'staged']) {
    const list = await f.api.listChanges(f.scope, source, signal())
    const entry = list.entries.find(entry => entry.path === deleted)
    assert.equal(entry.status, 'deleted')
    const diff = await f.api.getFileDiff(f.scope, source, entry.fileId, list.revision, 0, signal())
    assert.ok(diff.rows.some(row => row.kind === '-' && row.text === 'remove'))
    assert.equal((await f.api.getGitContext(f.scope, source, signal())).hasCommittableChanges, true)
  }
})

test('session staging is idempotent when all recorded deletions are already staged', async t => {
  const f = await fixture(t); await f.seed()
  const before = { exists: true, text: 'before\n', hash: hash('before\n'), reason: null, mode: null }
  await f.store.finish(f.scope, 'deletion', [{ path: 'code.txt', author: f.scope.sessionId, callId: 'delete', sequence: 0,
    origin: 'structured', finalStatus: 'success', execution: 'deletion', before, after: absent() }])
  await unlink(path.join(f.workspace, 'code.txt'))
  assert.equal(last(await f.run('stage', 'session')).phase, 'done')
  const index = await readFile(path.join(f.workspace, '.git/index'))
  const result = last(await f.run('stage', 'session'))
  assert.equal(result.phase, 'done', JSON.stringify(result))
  assert.deepEqual(await readFile(path.join(f.workspace, '.git/index')), index)
  assert.equal(await readGit(f.workspace, ['rev-list', '--count', 'HEAD']), '1')
})

test('commit from staged preserves the working file and untracked files', async t => {
  const f = await fixture(t); await f.seed()
  await writeFile(path.join(f.workspace, 'code.txt'), 'staged\n'); await git(f.workspace, ['add', '.'])
  await writeFile(path.join(f.workspace, 'code.txt'), 'later working edit\n')
  await writeFile(path.join(f.workspace, 'untracked.txt'), 'keep\n')
  const values = await f.run('commit', 'staged', 'index only')
  assert.deepEqual(values.map(v => v.phase), ['committing', 'done'])
  assert.equal(await readGit(f.workspace, ['show', 'HEAD:code.txt']), 'staged')
  assert.equal(await readFile(path.join(f.workspace, 'code.txt'), 'utf8'), 'later working edit\n')
  assert.equal(await readGit(f.workspace, ['ls-files', '--', 'untracked.txt']), '')
})

test('push commits then pushes only the current branch and sets its upstream', async t => {
  const f = await fixture(t), remote = await f.remote()
  await writeFile(path.join(f.workspace, 'code.txt'), 'push me\n')
  const values = await f.run('push', 'working', 'initial push')
  assert.deepEqual(values.map(v => v.phase), ['staging', 'committing', 'pushing', 'done'], JSON.stringify(values))
  assert.equal(await readGit(remote, ['rev-parse', 'refs/heads/main']), last(values).commitId)
  assert.equal(await readGit(f.workspace, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/main')
  assert.equal(await readGit(remote, ['for-each-ref', '--format=%(refname)']), 'refs/heads/main')
})

test('failed push retains the commit; retry neither creates another commit nor stages new edits', async t => {
  const f = await fixture(t), remote = await f.remote(), hook = path.join(remote, 'hooks/pre-receive')
  await git(remote, ['config', 'core.hooksPath', path.join(remote, 'hooks')])
  await writeFile(hook, '#!/bin/sh\necho "push blocked by test" >&2\nexit 1\n', { mode: 0o755 })
  await writeFile(path.join(f.workspace, 'code.txt'), 'saved locally\n')
  const first = last(await f.run('push', 'working', 'one commit'))
  assert.equal(first.phase, 'error'); assert.match(first.error.detail, /push blocked by test/)
  assert.ok(first.commitId)
  await unlink(hook); await writeFile(path.join(f.workspace, 'new.txt'), 'do not stage\n')
  const retry = await f.run('push', 'working', 'must not be committed', first.commitId)
  assert.deepEqual(retry.map(v => v.phase), ['pushing', 'done'])
  assert.equal(last(retry).commitId, first.commitId)
  assert.equal(await readGit(f.workspace, ['rev-list', '--count', 'HEAD']), '1')
  assert.equal(await readGit(f.workspace, ['ls-files', '--', 'new.txt']), '')
  assert.equal(await readGit(remote, ['rev-parse', 'refs/heads/main']), first.commitId)
})

test('stale lists and blank messages fail before writing, and the shared index lock blocks concurrent views', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.workspace, 'code.txt'), 'one\n')
  const before = await f.api.listChanges(f.scope, 'working', signal())
  await writeFile(path.join(f.workspace, 'code.txt'), 'two\n')
  const stale = last(await collect(f.api.runGitAction(f.scope, 'stage', 'working', before.revision, '', '', signal())))
  assert.equal(stale.error.code, 'stale'); assert.equal(await readGit(f.workspace, ['ls-files']), '')
  assert.equal(last(await f.run('commit', 'working', ' \n ')).error.code, 'git-message')
  const current = await f.api.listChanges(f.scope, 'working', signal())
  const running = f.api.runGitAction(f.scope, 'stage', 'working', current.revision, '', '', signal())
  assert.equal((await running.next()).value.phase, 'staging')
  t.after(() => running.return())
  const other = new ChangesApi(f.store)
  const concurrent = last(await collect(other.runGitAction({ ...f.scope, sessionId: 'another' }, 'stage', 'working', current.revision, '', '', signal())))
  assert.equal(concurrent.error.code, 'git-busy')
  assert.equal(last(await collect(running)).phase, 'done')
})

test('subdirectory staging stays in scope and commits refuse unrelated staged paths', async t => {
  const f = await fixture(t), sub = path.join(f.workspace, 'sub'); await mkdir(sub)
  await writeFile(path.join(f.workspace, 'outside.txt'), 'outside\n'); await writeFile(path.join(sub, 'inside.txt'), 'inside\n')
  const scope = { ...f.scope, root: sub }, data = await f.api.listChanges(scope, 'working', signal())
  assert.equal(last(await collect(f.api.runGitAction(scope, 'stage', 'working', data.revision, '', '', signal()))).phase, 'done')
  assert.equal(await readGit(f.workspace, ['diff', '--cached', '--name-only']), 'sub/inside.txt')
  await git(f.workspace, ['add', 'outside.txt'])
  const result = last(await collect(f.api.runGitAction(scope, 'commit', 'staged', '', 'scoped', '', signal())))
  assert.equal(result.error.code, 'git-outside-index')
  assert.equal(await readGit(f.workspace, ['for-each-ref', '--format=%(refname)']), '')
})

test('session staging uses recorded paths and refuses a changed on-disk endpoint', async t => {
  const f = await fixture(t), content = 'recorded\n'
  await writeFile(path.join(f.workspace, '-only[1].txt'), content)
  await writeFile(path.join(f.workspace, '-only1.txt'), 'unrelated\n')
  await f.store.finish(f.scope, 'record', [{ path: '-only[1].txt', author: f.scope.sessionId, callId: 'call', sequence: 0,
    execution: 'record', finalStatus: 'success', origin: 'structured', before: absent(),
    after: { exists: true, text: content, hash: hash(content), reason: null, mode: null } }])
  assert.equal(last(await f.run('stage', 'session')).phase, 'done')
  assert.equal(await readGit(f.workspace, ['diff', '--cached', '--name-only']), '-only[1].txt')
  await writeFile(path.join(f.workspace, '-only[1].txt'), 'external\n')
  assert.equal(last(await f.run('stage', 'session')).error.code, 'stale')
  assert.equal(await readGit(f.workspace, ['show', ':-only[1].txt']), 'recorded')
})

test('commit hooks and unresolved conflicts stop the pipeline before push', async t => {
  const f = await fixture(t); await f.seed(); const remote = await f.remote()
  await writeFile(path.join(f.workspace, '.git/hooks/pre-commit'), '#!/bin/sh\necho "commit blocked by test" >&2\nexit 1\n', { mode: 0o755 })
  await writeFile(path.join(f.workspace, 'code.txt'), 'new\n')
  const failure = last(await f.run('push', 'working', 'must fail'))
  assert.equal(failure.phase, 'error'); assert.equal(failure.commitId, ''); assert.match(failure.error.detail, /commit blocked by test/)
  assert.equal(await readGit(remote, ['for-each-ref', '--format=%(refname)']), '')
  await unlink(path.join(f.workspace, '.git/hooks/pre-commit'))
  const blob = await readGit(f.workspace, ['rev-parse', 'HEAD:code.txt'])
  await git(f.workspace, ['update-index', '--index-info'], undefined, `0 ${'0'.repeat(40)}\tcode.txt\n100644 ${blob} 1\tcode.txt\n100644 ${blob} 2\tcode.txt\n100644 ${blob} 3\tcode.txt\n`)
  assert.equal(last(await f.run('commit', 'working', 'conflict')).error.code, 'git-conflict')
  assert.notEqual(await readGit(f.workspace, ['ls-files', '--unmerged']), '')
})

test('Git mutation codecs reject invalid commands, oversized messages and malformed retry commits', () => {
  const descriptor = contribution.descriptors.find(value => value.method === 'runGitAction')
  assert.equal(descriptor.mode, 'stream')
  const parse = (name, value) => descriptor.parameters.find(p => p.name === name).codec.create().parse(value)
  assert.throws(() => parse('action', 'reset'))
  assert.throws(() => parse('message', 'x'.repeat(65537)))
  assert.throws(() => parse('message', 'a\0b'))
  assert.throws(() => parse('committedId', '--force'))
  assert.equal(parse('message', 'subject\n\nbody'), 'subject\n\nbody')
  assert.equal(parse('committedId', ''), '')
})

test('missing remotes, an empty index, changed staged snapshots and detached HEAD leave Git unchanged', async t => {
  const f = await fixture(t)
  assert.equal(last(await f.run('commit', 'staged', 'empty')).error.code, 'git-empty-index')
  await writeFile(path.join(f.workspace, 'code.txt'), 'one\n')
  assert.equal(last(await f.run('push', 'working', 'no remote')).error.code, 'git-no-remote')
  assert.equal(await readGit(f.workspace, ['ls-files']), '')
  await git(f.workspace, ['add', '.'])
  const staged = await f.api.listChanges(f.scope, 'staged', signal())
  await writeFile(path.join(f.workspace, 'code.txt'), 'two\n'); await git(f.workspace, ['add', '.'])
  const stale = last(await collect(f.api.runGitAction(f.scope, 'commit', 'staged', staged.revision, 'stale index', '', signal())))
  assert.equal(stale.error.code, 'stale')
  await git(f.workspace, ['commit', '-m', 'base']); await git(f.workspace, ['checkout', '--detach'])
  assert.equal(last(await f.run('push', 'staged', 'detached')).error.code, 'git-detached')
  assert.equal(await readGit(f.workspace, ['rev-list', '--count', 'HEAD']), '1')
})

test('client locks immediately, exposes each phase, retains failures and sends only a push on retry', async () => {
  let release, calls = 0, changed = 0, args
  const barrier = new Promise(resolve => { release = resolve })
  const remote = { async *runGitAction(...input) {
    calls++; args = input
    if (calls === 1) {
      yield { phase: 'staging' }; await barrier
      yield { phase: 'committing' }; yield { phase: 'pushing', commitId: 'a'.repeat(40) }
      throw Error('network interrupted')
    }
    yield { phase: 'pushing', commitId: input[5] }; yield { phase: 'done', commitId: input[5] }
  } }
  const operation = createGitOperation(remote, () => changed++), phases = []
  const off = operation.subscribe(() => phases.push(operation.getSnapshot().phase))
  const request = { sessionId: 'one', action: 'push', source: 'working', revision: 'r', message: 'keep this draft' }
  const first = operation.run(request)
  assert.equal(gitBusy(operation.getSnapshot()), true)
  assert.equal(await operation.run(request), null); assert.equal(calls, 1)
  release(); const failed = await first
  assert.equal(failed.phase, 'error'); assert.equal(failed.commitId, 'a'.repeat(40)); assert.equal(failed.message, request.message)
  assert.ok(phases.includes('committing')); assert.ok(phases.includes('pushing'))
  operation.dismissError()
  assert.equal(operation.getSnapshot().error, null)
  assert.equal(operation.getSnapshot().phase, 'error')
  assert.equal(operation.getSnapshot().commitId, failed.commitId)
  assert.equal(operation.getSnapshot().message, request.message)
  assert.equal((await operation.run({ ...request, committedId: failed.commitId })).phase, 'done')
  assert.equal(args[5], failed.commitId); assert.equal(changed, 2); assert.equal(gitBusy(operation.getSnapshot()), false)
  off()
})

test('dismissed stage errors allow retry, while an unknown write result remains protected', async () => {
  let calls = 0
  const remote = { async *runGitAction() {
    calls++
    yield calls === 1 ? { phase: 'error', error: { code: 'git-failed', detail: 'pathspec' } } : { phase: 'done' }
  } }
  const operation = createGitOperation(remote)
  const request = { sessionId: 'one', action: 'stage', source: 'working', revision: 'r' }
  await operation.run(request)
  operation.dismissError()
  assert.equal(operation.getSnapshot().error, null)
  assert.equal((await operation.run(request)).phase, 'done')
  const unknown = createGitOperation({ async *runGitAction() { throw Error('connection lost') },
    async getGitOperation() { return { phase: 'unknown', error: { code: 'git-result-unknown', detail: '' } } } })
  await unknown.run({ ...request, context: {} })
  unknown.dismissError()
  assert.equal(unknown.getSnapshot().phase, 'unknown')
  assert.equal(unknown.getSnapshot().error.code, 'git-result-unknown')
  assert.equal(await unknown.run(request), null)
})

test('commit previews reuse only matching list statistics and preserve unknown counts', () => {
  const capabilities = { endpointId: 'host-a', workspaceRoot: '/repo' }
  const data = { ...capabilities, sessionId: 'one', source: 'working', revision: 'r1',
    entries: [{ stats: { added: 4, removed: 2 } }, { stats: { added: 1, removed: 0 } }] }
  const summary = value => gitListStatistics(value, 'one', capabilities, 'working')
  assert.deepEqual(summary(data), { added: 5, removed: 2, statisticsComplete: true, listRevision: 'r1' })
  for (const mismatch of [{ source: 'session' }, { source: 'staged' }, { workspaceRoot: '/other' }, { endpointId: 'host-b' }, { sessionId: 'two' }]) {
    assert.equal(summary({ ...data, ...mismatch }), null)
  }
  assert.equal(summary(null), null)
  assert.deepEqual(summary({ ...data, entries: [] }), { added: 0, removed: 0, statisticsComplete: true, listRevision: 'r1' })
  const binary = { stats: { added: null, removed: null } }
  assert.deepEqual(summary({ ...data, entries: [binary] }), { added: null, removed: null, statisticsComplete: false, listRevision: 'r1' })
  assert.deepEqual(summary({ ...data, entries: [...data.entries, binary] }), { added: 5, removed: 2, statisticsComplete: false, listRevision: 'r1' })
})

test('branch selection accepts a pending preview but validates the scope before switching', async () => {
  const scope = { endpointId: 'host-a', workspaceRoot: '/repo', source: 'staged' }
  const context = { ...scope, contextRevision: 'git-context-v1:checked' }
  let release, switched = 0
  const pending = new Promise(resolve => { release = resolve })
  const remote = {
    async getGitContext(sessionId, source) { assert.equal(sessionId, 'one'); assert.equal(source, 'staged'); await pending; return context },
    async switchGitBranch(sessionId, branch, revision) {
      assert.equal(sessionId, 'one'); assert.equal(branch, 'feature'); assert.equal(revision, context.contextRevision)
      switched++; return { ...context, branch }
    },
  }
  const operation = createGitOperation(remote)
  const selection = operation.switchBranch('one', 'feature', scope)
  assert.equal(operation.getSnapshot().phase, 'switching')
  assert.equal(switched, 0)
  assert.equal(await operation.switchBranch('one', 'another', scope), null)
  release()
  assert.equal((await selection).branch, 'feature'); assert.equal(switched, 1)
  for (const mismatch of [{ workspaceRoot: '/other' }, { endpointId: 'host-b' }, { source: 'working' }]) {
    const invalid = createGitOperation({ ...remote, async getGitContext() { return { ...context, ...mismatch } } })
    assert.equal(await invalid.switchBranch('one', 'feature', scope), null)
    assert.equal(invalid.getSnapshot().error.code, 'stale'); assert.equal(switched, 1)
  }
})

const contextRun = async (f, action, source = 'working', message = 'reviewed change', context) => {
  context ||= await f.api.getGitContext(f.scope, source, signal())
  return collect(f.api.runGitAction(f.scope, action, source, context.contextRevision, message, '', signal()))
}

test('context previews final working tree without staging; a restored file cannot leak old index content', async t => {
  const f = await fixture(t); await f.seed()
  await writeFile(path.join(f.workspace, 'code.txt'), 'staged\n'); await git(f.workspace, ['add', '.'])
  await writeFile(path.join(f.workspace, 'code.txt'), 'before\n')
  await writeFile(path.join(f.workspace, 'new.txt'), 'new\n')
  const index = await readFile(path.join(f.workspace, '.git/index'))
  const staged = await f.api.getGitContext(f.scope, 'staged', signal()), working = await f.api.getGitContext(f.scope, 'working', signal())
  assert.deepEqual([staged.added, staged.removed], [1, 1]); assert.deepEqual([working.added, working.removed], [1, 0],
    JSON.stringify({ paths: f.api.gitContexts.snapshots.get(working.contextRevision).paths, entries: f.api.gitContexts.snapshots.get(working.contextRevision).data.entries.map(entry => ({ path: entry.path, before: entry.before.text, after: entry.after.text })) }))
  assert.equal(working.branch, 'main'); assert.equal(working.canPush, false); assert.equal(working.canGenerateMessage, false)
  assert.deepEqual(await readFile(path.join(f.workspace, '.git/index')), index)
  const result = last(await contextRun(f, 'commit', 'working', '中文\n\n保留换行', working))
  assert.equal(result.phase, 'done', JSON.stringify(result))
  assert.equal(await readGit(f.workspace, ['show', 'HEAD:code.txt']), 'before')
  assert.equal(await readGit(f.workspace, ['show', 'HEAD:new.txt']), 'new')
})

test('context handles staged-only partial edits, binary/empty changes, renames, deletions and ignored files', async t => {
  const f = await fixture(t); await f.seed()
  await writeFile(path.join(f.workspace, 'code.txt'), 'index\n'); await git(f.workspace, ['add', '.'])
  await writeFile(path.join(f.workspace, 'code.txt'), 'working\n')
  assert.equal(last(await contextRun(f, 'commit', 'staged')).phase, 'done')
  assert.equal(await readGit(f.workspace, ['show', 'HEAD:code.txt']), 'index')
  assert.equal(await readFile(path.join(f.workspace, 'code.txt'), 'utf8'), 'working\n')
  await rename(path.join(f.workspace, 'code.txt'), path.join(f.workspace, '-renamed[1].txt'))
  await writeFile(path.join(f.workspace, 'empty'), '')
  await writeFile(path.join(f.workspace, 'data.bin'), Buffer.from([0, 1, 2]))
  await writeFile(path.join(f.workspace, '.gitignore'), 'ignored\n')
  await writeFile(path.join(f.workspace, 'ignored'), 'never add\n')
  const context = await f.api.getGitContext(f.scope, 'working', signal())
  assert.equal(context.statisticsComplete, false); assert.equal(context.hasCommittableChanges, true)
  assert.equal(last(await contextRun(f, 'commit', 'working', 'types', context)).phase, 'done')
  assert.equal(await readGit(f.workspace, ['ls-files', '--', 'ignored']), '')
  await unlink(path.join(f.workspace, 'empty')); await git(f.workspace, ['add', '-A'])
  assert.equal(last(await contextRun(f, 'commit', 'working')).phase, 'done', 'already-staged deletion needs no nonexistent pathspec')
})

test('unborn binary-only and empty-file changes can commit with zero or unknown line counts', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.workspace, 'binary'), Buffer.from([0, 2]))
  const binary = await f.api.getGitContext(f.scope, 'working', signal())
  assert.equal(binary.unborn, true); assert.equal(binary.added, null); assert.equal(binary.hasCommittableChanges, true)
  assert.equal(last(await contextRun(f, 'commit', 'working', 'initial', binary)).phase, 'done')
  await writeFile(path.join(f.workspace, 'empty'), '')
  const empty = await f.api.getGitContext(f.scope, 'working', signal())
  assert.deepEqual([empty.added, empty.removed, empty.hasCommittableChanges], [0, 0, true])
})

test('pushOnly pushes existing HEAD, sets upstream and preserves index, worktree and commit count', async t => {
  const f = await fixture(t); await f.seed(); const remote = await f.remote()
  await writeFile(path.join(f.workspace, 'code.txt'), 'index\n'); await git(f.workspace, ['add', '.'])
  await writeFile(path.join(f.workspace, 'code.txt'), 'worktree\n')
  const head = await readGit(f.workspace, ['rev-parse', 'HEAD']), index = await readFile(path.join(f.workspace, '.git/index'))
  const context = await f.api.getGitContext(f.scope, 'working', signal())
  assert.equal(context.ahead, null); assert.equal(context.canPush, true)
  const result = last(await contextRun(f, 'pushOnly', 'working', '', context))
  assert.equal(result.phase, 'done', JSON.stringify(result)); assert.equal(result.commitId, head)
  assert.equal(await readGit(remote, ['rev-parse', 'main']), head)
  assert.deepEqual(await readFile(path.join(f.workspace, '.git/index')), index)
  assert.equal(await readFile(path.join(f.workspace, 'code.txt'), 'utf8'), 'worktree\n')
  const after = await f.api.getGitContext(f.scope, 'staged', signal())
  assert.equal(after.ahead, 0); assert.equal(after.canPush, false); assert.equal(after.canPushAfterCommit, true)
})

test('branch switch uses local refs, validates snapshots and refuses occupied branches', async t => {
  const f = await fixture(t); await f.seed()
  await git(f.workspace, ['branch', 'feature/中文'])
  const context = await f.api.getGitContext(f.scope, 'working', signal())
  assert.deepEqual((await f.api.listGitBranches(f.scope, signal())).branches.map(b => b.name).sort(), ['feature/中文', 'main'])
  const switched = await f.api.switchGitBranch(f.scope, 'feature/中文', context.contextRevision, signal())
  assert.equal(switched.branch, 'feature/中文')
  await assert.rejects(f.api.switchGitBranch(f.scope, 'main', context.contextRevision, signal()), /stale/)
  const other = path.join(f.root, 'other-worktree'); await git(f.workspace, ['worktree', 'add', other, 'main'])
  const branch = (await f.api.listGitBranches(f.scope, signal())).branches.find(b => b.name === 'main')
  assert.equal(branch.disabled, true)
  await assert.rejects(f.api.switchGitBranch(f.scope, 'main', switched.contextRevision, signal()))
  assert.equal(await readGit(f.workspace, ['branch', '--show-current']), 'feature/中文')
})

test('context detects external index, HEAD and worktree changes and rejects out-of-scope index', async t => {
  const f = await fixture(t); await f.seed()
  await writeFile(path.join(f.workspace, 'code.txt'), 'new\n')
  const context = await f.api.getGitContext(f.scope, 'working', signal())
  await git(f.workspace, ['add', '.'])
  assert.equal(last(await contextRun(f, 'commit', 'working', 'stale', context)).error.code, 'stale')
  const next = await f.api.getGitContext(f.scope, 'working', signal())
  await writeFile(path.join(f.workspace, 'code.txt'), 'changed again\n')
  assert.equal(last(await contextRun(f, 'commit', 'working', 'stale', next)).error.code, 'stale')
  const sub = path.join(f.workspace, 'sub'); await mkdir(sub); await writeFile(path.join(sub, 'inside'), 'in\n')
  const scoped = await f.api.getGitContext({ ...f.scope, root: sub }, 'working', signal())
  assert.equal(scoped.commitReason, 'git-outside-index'); assert.equal(scoped.hasCommittableChanges, false)
  await git(f.workspace, ['checkout', '--detach'])
  assert.equal((await f.api.getGitContext(f.scope, 'working', signal())).commitReason, 'git-detached')
})

test('generation uses a fixed snapshot and never writes Git on failure or stale output', async t => {
  const f = await fixture(t); await writeFile(path.join(f.workspace, 'code.txt'), 'one\n')
  let mode = 'success', calls = 0
  f.api.gitContexts.generator = { available: () => true, async generate(scope, data) {
    calls++; assert.equal(data.entries[0].after.text, 'one\n')
    if (mode === 'fail') throw Error('git-generation-failed')
    if (mode === 'stale') await writeFile(path.join(f.workspace, 'code.txt'), 'two\n')
    return 'feat: 中文说明\n\n第二行'
  } }
  const context = await f.api.getGitContext(f.scope, 'working', signal())
  assert.equal((await f.api.generateCommitMessage(f.scope, 'working', context.contextRevision, signal())).message, 'feat: 中文说明\n\n第二行')
  mode = 'fail'; await assert.rejects(f.api.generateCommitMessage(f.scope, 'working', context.contextRevision, signal()), /git-generation-failed/)
  mode = 'stale'; await assert.rejects(f.api.generateCommitMessage(f.scope, 'working', context.contextRevision, signal()), /stale/)
  assert.equal(calls, 3); assert.equal(await readGit(f.workspace, ['ls-files']), '')
})

test('client generation prevents reentry, preserves newer drafts and pushOnly never generates', async () => {
  let release, writes = 0, generations = 0
  const barrier = new Promise(resolve => { release = resolve })
  const context = { endpointId: 'e', repositoryRoot: 'r', workspaceRoot: 'r', branch: 'main', canGenerateMessage: true }
  const operation = createGitOperation({ async generateCommitMessage() { generations++; await barrier; return { message: 'generated', contextRevision: 'v1' } },
    async *runGitAction() { writes++; yield { phase: 'done' } } })
  const request = { sessionId: 's', action: 'commit', source: 'working', revision: 'v1', message: '', context }
  const running = operation.run(request)
  assert.equal(operation.getSnapshot().phase, 'generating'); assert.equal(await operation.run(request), null)
  operation.saveDraft(context, 'new user draft'); release()
  assert.equal((await running).phase, 'error'); assert.equal(writes, 0); assert.equal(operation.draft(context), 'new user draft')
  assert.equal((await operation.run({ ...request, action: 'pushOnly', message: 'invalid\0draft' })).phase, 'done')
  assert.equal(generations, 1); assert.equal(writes, 1)
  assert.equal(operation.draft(context), 'new user draft')
  assert.equal((await operation.run({ ...request, message: 'manual message' })).phase, 'done')
  assert.equal(generations, 1); assert.equal(writes, 2)
  assert.equal((await operation.run({ ...request, context: { ...context, canGenerateMessage: false } })).error.code, 'git-generation-unavailable')
  assert.equal(writes, 2)
  assert.equal((await operation.run({ ...request, message: 'invalid\0draft' })).error.code, 'git-message')
  assert.equal(writes, 2)
})

test('configured LLM adapter receives bounded read-only messages and requires a successful finish', async () => {
  let truncated = false
  const requests = [], ctx = { get(name) { return name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'configured', model: 'configured-model' }) }
    : { listProviders: () => [{ id: 'configured' }], async *stream(request) { requests.push(request); yield { type: 'text-delta', text: 'fix: 修复\n\n详情' }; if (!truncated) yield { type: 'finish' } } } } }
  const generator = createCommitMessageGenerator(ctx, async () => ({ createUserMessage: value => value,
    BlockAssembler: class { finish = { kind: 'stop' }; output = ''; push(chunk) { this.output += chunk.text || '' }; blocks() { return [{ type: 'text', text: this.output }] } } }))
  assert.equal(generator.available(), true)
  assert.equal(await generator.generate({ sessionId: 's' }, { entries: [] }, signal()), 'fix: 修复\n\n详情')
  assert.equal(requests[0].tools, undefined); assert.equal(requests[0].provider, 'configured'); assert.equal(requests[0].model, 'configured-model')
  truncated = true
  await assert.rejects(generator.generate({ sessionId: 's' }, { entries: [] }, signal()), /git-generation-failed/)
})

test('transport closure leaves the recorded writer running and recovery returns its actual result', async t => {
  const f = await fixture(t); await f.seed()
  await writeFile(path.join(f.workspace, 'code.txt'), 'reviewed\n')
  const context = await f.api.getGitContext(f.scope, 'working', signal()), cancellation = new AbortController()
  const stream = f.api.runGitAction(f.scope, 'commit', 'working', context.contextRevision, 'once', '', cancellation.signal)
  assert.equal((await stream.next()).value.phase, 'staging')
  cancellation.abort(); await stream.return()
  let state
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await f.api.getGitOperation(f.scope, context.contextRevision)
    if (['done', 'error'].includes(state.phase)) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(state.phase, 'done', JSON.stringify(state))
  assert.equal(await readGit(f.workspace, ['rev-list', '--count', 'HEAD']), '2')
  assert.equal(last(await contextRun(f, 'commit', 'working', 'must not duplicate', context)).error.code, 'stale')
})

test('a retained failed push rejects changed remote destinations and forged retry commits', async t => {
  const f = await fixture(t); await f.seed(); const remote = await f.remote()
  await git(remote, ['config', 'core.hooksPath', path.join(remote, 'hooks')])
  await writeFile(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const context = await f.api.getGitContext(f.scope, 'working', signal())
  const failed = last(await contextRun(f, 'pushOnly', 'working', '', context))
  assert.equal(failed.phase, 'error'); assert.equal(failed.commitId, context.head)
  const newTarget = path.join(f.root, 'other.git'); await mkdir(newTarget); await git(newTarget, ['init', '--bare'])
  await git(f.workspace, ['remote', 'set-url', '--push', 'origin', newTarget])
  const retry = last(await collect(f.api.runGitAction(f.scope, 'push', 'working', context.contextRevision, '', failed.commitId, signal())))
  assert.equal(retry.error.code, 'git-head-changed')
  const forged = last(await collect(f.api.runGitAction(f.scope, 'push', 'working', context.contextRevision, '', 'a'.repeat(40), signal())))
  assert.equal(forged.error.code, 'git-head-changed')
  assert.equal(await readGit(f.workspace, ['rev-list', '--count', 'HEAD']), '1')
})

test('client recovery checks the receipt instead of replaying a commit; drafts stay branch/endpoint scoped', async () => {
  let writes = 0, checks = 0
  const context = { endpointId: 'one', repositoryRoot: 'repo', workspaceRoot: 'repo/sub', branch: 'main' }
  const operation = createGitOperation({ async *runGitAction() { writes++; yield { phase: 'pushing', commitId: 'b'.repeat(40) }; throw Error('connection lost') },
    async getGitOperation() { checks++; return { ok: true, value: { phase: 'done', action: 'push', commitId: 'b'.repeat(40) } } } })
  operation.saveDraft(context, 'main message'); operation.saveDraft({ ...context, branch: 'feature' }, 'feature message')
  operation.saveDraft({ ...context, endpointId: 'two' }, 'other endpoint')
  const result = await operation.run({ sessionId: 's', action: 'push', source: 'working', revision: 'v1', message: 'main message', context })
  assert.equal(result.phase, 'done'); assert.equal(writes, 1); assert.equal(checks, 1)
  assert.equal(operation.draft(context), ''); assert.equal(operation.draft({ ...context, branch: 'feature' }), 'feature message')
  assert.equal(operation.draft({ ...context, endpointId: 'two' }), 'other endpoint')
})

test('staged mode and symlink changes remain committable with non-text statistics', async t => {
  const f = await fixture(t); await f.seed()
  await git(f.workspace, ['update-index', '--chmod=+x', '--', 'code.txt'])
  const mode = await f.api.getGitContext(f.scope, 'staged', signal())
  assert.deepEqual([mode.hasCommittableChanges, mode.added, mode.removed], [true, 0, 0])
  assert.equal(last(await contextRun(f, 'commit', 'staged', 'mode', mode)).phase, 'done')
  const oid = await readGit(f.workspace, ['hash-object', '-w', '--stdin'])
  await git(f.workspace, ['update-index', '--add', '--cacheinfo', `120000,${oid},link`])
  const link = await f.api.getGitContext(f.scope, 'staged', signal())
  assert.equal(link.hasCommittableChanges, true); assert.equal(link.statisticsComplete, false)
})

test('byte-only newline changes stay committable even when normalized line statistics are zero', async t => {
  const f = await fixture(t); await f.seed()
  await writeFile(path.join(f.workspace, 'code.txt'), 'before\r\n')
  const context = await f.api.getGitContext(f.scope, 'working', signal())
  assert.deepEqual([context.hasCommittableChanges, context.added, context.removed], [true, 0, 0])
  assert.equal(last(await contextRun(f, 'commit', 'working', 'line endings', context)).phase, 'done')
  assert.equal((await git(f.workspace, ['show', 'HEAD:code.txt'])).toString(), 'before\r\n')
})
