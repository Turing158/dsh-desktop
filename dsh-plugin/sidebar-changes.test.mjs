import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { diffText, LIMITS } from './sidebar-changes/shared/change-model.mjs'
import { SnapshotStore } from './sidebar-changes/host/snapshot-store.mjs'
import { installRecorder } from './sidebar-changes/host/session-recorder.mjs'
import { ChangesApi } from './sidebar-changes/host/api.mjs'
import { git, listGit, availability } from './sidebar-changes/host/git-provider.mjs'
import { absent, hash, relative } from './sidebar-changes/host/paths.mjs'
import { GitHistory } from './sidebar-changes/host/git-history.mjs'
import { layoutCommits } from './sidebar-changes/shared/commit-graph.mjs'
import { createViewStates } from './sidebar-changes/client-state.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-changes-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, '项目 空格'); await mkdir(workspace)
  return { root, workspace, store: new SnapshotStore(path.join(root, 'snapshots')) }
}
const endpoint = text => ({ exists: true, text, reason: null, hash: hash(text), mode: null })
async function record(store, scope, before, after, name = 'a.txt', execution = Math.random().toString()) {
  await store.finish(scope, execution, [{ path: name, author: scope.sessionId, callId: 'call', execution, sequence: 0, finalStatus: 'pending', origin: 'structured', before, after }])
}
test('bounded exact diff, normalized line endings, empty files and complexity', () => {
  assert.deepEqual(diffText('a\r\nb\r\n', 'a\nb\n').stats, { added: 0, removed: 0 })
  assert.deepEqual(diffText('a\nb\n', 'a\nc\n').stats, { added: 1, removed: 1 })
  assert.deepEqual(diffText('', '').stats, { added: 0, removed: 0 })
  assert.equal(diffText('a\nb\nc', 'x\ny\nz', { ...LIMITS, cells: 3 }).reason, 'complexity')
  assert.equal(diffText('a', 'a\n').beforeNewline, false)
})
test('session endpoints persist, net changes cancel, and interleaving never produces false totals', async t => {
  const { workspace, store, root } = await fixture(t), scope = { sessionId: 'A', root: workspace }
  await record(store, scope, endpoint('a\n'), endpoint('b\n'))
  await record(store, scope, endpoint('b\n'), endpoint('c\n'))
  let data = await new SnapshotStore(path.join(root, 'snapshots')).list(scope)
  assert.deepEqual(data.entries[0].stats, { added: 1, removed: 1 })
  await writeFile(path.join(workspace, 'a.txt'), 'external')
  assert.equal((await store.list(scope)).entries[0].after.text, 'c\n')
  await record(store, scope, endpoint('other\n'), endpoint('last\n'))
  data = await store.list(scope)
  assert.equal(data.entries[0].reason, 'interleaved'); assert.equal(data.entries[0].stats.added, null)
  const independent = { sessionId: 'B', root: workspace }
  assert.equal((await store.list(independent)).entries.length, 0)
  await record(store, independent, endpoint('a'), endpoint('b'))
  await record(store, independent, endpoint('b'), endpoint('a'))
  assert.equal((await store.list(independent)).entries.length, 0)
  await record(store, independent, absent(), endpoint(''), 'empty')
  assert.equal((await store.list(independent)).entries[0].status, 'added')
  await record(store, independent, endpoint(''), absent(), 'empty')
  assert.equal((await store.list(independent)).entries.length, 0)
})
test('incomplete baseline, interrupted journal and quotas remain explicit', async t => {
  const { workspace, store, root } = await fixture(t), scope = { sessionId: 'A', root: workspace }
  await record(store, scope, { exists: true, text: null, reason: 'baseline', hash: null }, endpoint('new'))
  assert.equal((await store.list(scope)).entries[0].stats.added, null)
  await store.begin(scope, 'pending', 'call2')
  assert.ok((await new SnapshotStore(path.join(root, 'snapshots')).list(scope)).gaps.includes('interrupted'))
  const limited = new SnapshotStore(path.join(root, 'quota'), { ...LIMITS, disk: 1 })
  await assert.rejects(record(limited, scope, endpoint('a'), endpoint('b')), /quota/)
  assert.ok((await limited.list(scope)).gaps.includes('quota'))
})
async function initRepo(root) { await git(root, ['init']); await git(root, ['config', 'user.email', 'test@example.invalid']); await git(root, ['config', 'user.name', 'Test']) }
async function commitObject(root, tree, parents, message) {
  return (await git(root, ['commit-tree', tree, ...parents.flatMap(id => ['-p', id])], undefined, message)).toString().trim()
}
test('commit history keeps paged snapshots stable, scopes details, and retains full messages', async t => {
  const { workspace } = await fixture(t); await initRepo(workspace)
  const history = new GitHistory(), scope = { sessionId: 'history', root: workspace }
  assert.deepEqual((await history.list(scope, '', 0)).entries, [])
  const tree = (await git(workspace, ['mktree'], undefined, '')).toString().trim(), ids = []
  for (let i = 0; i < 58; i++) ids.push(await commitObject(workspace, tree, ids.length ? [ids.at(-1)] : [], `提交 ${i}\n\n正文第 ${i} 行\n\n<img src=x onerror=alert(1)>\n`))
  await git(workspace, ['update-ref', 'refs/heads/main', ids.at(-1)]); await git(workspace, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(workspace, ['tag', '-a', 'v1.0', '-m', '标注标签', ids.at(-1)])
  await git(workspace, ['update-ref', 'refs/remotes/origin/main', ids[20]])
  const first = await history.list(scope, '', 0)
  assert.equal(first.entries.length, 50); assert.equal(first.nextOffset, 50)
  assert.equal(first.entries[0].authorEmail, 'test@example.invalid')
  assert.equal(first.entries[0].committer, 'Test'); assert.equal(first.entries[0].committerEmail, 'test@example.invalid')
  assert.deepEqual(first.entries[0].refs.map(ref => ref.kind), ['head', 'branch', 'tag'])
  const newest = await commitObject(workspace, tree, [ids.at(-1)], 'later\n'); await git(workspace, ['update-ref', 'refs/heads/main', newest])
  const second = await history.list(scope, first.revision, first.nextOffset)
  assert.equal(second.entries.length, 8); assert.equal(second.nextOffset, null)
  assert.deepEqual([...first.entries, ...second.entries].map(row => row.id), [...ids].reverse())
  const detail = await history.details(scope, first.revision, ids.at(-1))
  assert.equal(detail.message, '提交 57\n\n正文第 57 行\n\n<img src=x onerror=alert(1)>\n')
  assert.equal(detail.authorEmail, 'test@example.invalid'); assert.deepEqual(detail.parents, [ids[56]])
  await assert.rejects(history.details({ ...scope, sessionId: 'other' }, first.revision, ids.at(-1)), /history-stale/)
  await assert.rejects(history.details(scope, first.revision, newest), /invalid-request/)
  await assert.rejects(history.details(scope, first.revision, '--all'), /invalid-request/)
  const next = await history.list(scope, '', 0); assert.notEqual(next.revision, first.revision); assert.equal(next.entries[0].id, newest)
  assert.equal((await history.details(scope, first.revision, ids[0])).id, ids[0])
  await history.list(scope, next.revision, 50)
  assert.equal((await history.list(scope, '', 0)).snapshotId, next.snapshotId)
  assert.equal((await history.details(scope, next.revision, ids[0])).id, ids[0])
  history.snapshots.get(history.key(scope, next.revision)).time = 0
  const renewed = await history.list(scope, '', 0)
  assert.equal(renewed.revision, next.revision); assert.notEqual(renewed.snapshotId, next.snapshotId)
  await assert.rejects(history.details(scope, renewed.revision, ids[0]), /invalid-request/)
  await history.list(scope, renewed.revision, 50)
  assert.equal((await history.details(scope, renewed.revision, ids[0])).id, ids[0])
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(history.list(scope, '', 0, aborted.signal))
})
test('commit graph preserves merge lanes across page boundaries and terminates at roots', () => {
  const entries = [{ id: 'merge', parents: ['main', 'side', 'third'] }, { id: 'side', parents: ['base'] }, { id: 'third', parents: ['base'] }, { id: 'main', parents: ['base'] }, { id: 'base', parents: [] }]
  const graph = layoutCommits(entries)
  assert.deepEqual(layoutCommits(entries.slice(0, 2)), graph.slice(0, 2))
  assert.equal(graph[0].parents.length, 3)
  for (let i = 0; i < graph.length - 1; i++) {
    assert.equal(new Set(graph[i].frontier.map(lane => lane.id)).size, graph[i].frontier.length)
    assert.ok(graph[i].passing.every(edge => edge.to >= 0))
  }
  assert.deepEqual(graph.at(-1).frontier, [])
})
test('history handles merge details, repository subdirectories, detached HEAD and shallow boundaries', async t => {
  const { workspace, root } = await fixture(t); await initRepo(workspace)
  const tree = (await git(workspace, ['mktree'], undefined, '')).toString().trim()
  const base = await commitObject(workspace, tree, [], 'base\n'), main = await commitObject(workspace, tree, [base], 'main\n'), side = await commitObject(workspace, tree, [base], 'side\n')
  const merge = await commitObject(workspace, tree, [main, side], 'merge\n\ncomplete message\n')
  await git(workspace, ['update-ref', 'refs/heads/main', merge]); await git(workspace, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const sub = path.join(workspace, 'sub'); await mkdir(sub)
  const history = new GitHistory(), scope = { sessionId: 'merge', root: sub }, list = await history.list(scope, '', 0)
  assert.equal(list.repositoryRoot, workspace); assert.equal(list.entries.length, 4)
  assert.deepEqual((await history.details(scope, list.revision, merge)).parents, [main, side])
  await git(workspace, ['checkout', '--detach', base])
  const detached = await history.list(scope, '', 0)
  assert.ok(detached.entries.find(row => row.id === base).refs.some(ref => ref.kind === 'head'))
  await git(workspace, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const clone = path.join(root, 'shallow'); await git(root, ['clone', '--depth=1', pathToFileURL(workspace).href, clone])
  const shallowScope = { sessionId: 'shallow', root: clone }, shallow = await history.list(shallowScope, '', 0)
  assert.equal(shallow.shallow, true); assert.equal(shallow.entries.length, 1); assert.equal(shallow.entries[0].boundary, true)
  await git(clone, ['fetch', '--deepen=2'])
  await assert.rejects(history.list(shallowScope, shallow.revision, 0), /history-stale/)
})
test('view state preserves each scope and migrates legacy file selection without nesting snapshots', () => {
  const states = new Map([['panel', { source: 'session', fileId: 'old', listScroll: 12 }]])
  const session = createViewStates(states, 'session'), history = createViewStates(states, 'history')
  assert.equal(session.get('panel').fileId, 'old')
  session.set('panel', { ...session.get('panel'), fileIds: ['old'] })
  states.set('panel', { ...states.get('panel'), source: 'history' })
  history.set('panel', { source: 'history', commitIds: ['commit'], listScroll: 300, loadedCount: 100 })
  session.set('panel', { ...session.get('panel'), listScroll: 20 })
  assert.equal(states.get('panel').source, 'history'); assert.equal(history.get('panel').listScroll, 300)
  assert.equal(session.get('panel').listScroll, 20); assert.equal(session.get('panel').views, undefined)
})
test('Git HEAD→worktree and HEAD→index are distinct, including reverted worktree', async t => {
  const { workspace } = await fixture(t); await initRepo(workspace)
  await writeFile(path.join(workspace, '中文 文件.txt'), 'A\n'); await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'base'])
  await writeFile(path.join(workspace, '中文 文件.txt'), 'B\n'); await git(workspace, ['add', '.'])
  await writeFile(path.join(workspace, '中文 文件.txt'), 'C\n')
  const working = await listGit(workspace, 'working'), staged = await listGit(workspace, 'staged')
  assert.equal(working.entries[0].after.text, 'C\n'); assert.equal(staged.entries[0].after.text, 'B\n')
  await writeFile(path.join(workspace, '中文 文件.txt'), 'A\n')
  assert.equal((await listGit(workspace, 'working')).entries.length, 0)
  assert.equal((await listGit(workspace, 'staged')).entries.length, 1)
})
test('Git unborn, ignored/untracked, binary and subtree confinement', async t => {
  const { workspace } = await fixture(t); await initRepo(workspace)
  await mkdir(path.join(workspace, 'sub'))
  await writeFile(path.join(workspace, 'sub', 'empty'), ''); await writeFile(path.join(workspace, 'outside'), 'out')
  await git(workspace, ['add', '.'])
  const entries = (await listGit(path.join(workspace, 'sub'), 'staged')).entries
  assert.equal(entries.length, 1); assert.equal(entries[0].path, 'empty'); assert.equal(entries[0].stats.added, 0)
  await writeFile(path.join(workspace, '.gitignore'), '*.ignored\n'); await writeFile(path.join(workspace, 'hidden.ignored'), 'secret')
  await writeFile(path.join(workspace, 'binary'), Buffer.from([0, 1, 2]))
  const working = await listGit(workspace, 'working')
  assert.ok(!working.entries.some(e => e.path === 'hidden.ignored'))
  assert.equal(working.entries.find(e => e.path === 'binary').stats.added, null)
  assert.equal(relative(workspace, path.dirname(workspace)), null)
  assert.equal((await availability(path.dirname(workspace))).status, 'none')
})
test('Git rename, delete, worktree and immutable detail revision', async t => {
  const { workspace, root, store } = await fixture(t); await initRepo(workspace)
  await writeFile(path.join(workspace, 'old'), 'content\n'); await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'base'])
  await rename(path.join(workspace, 'old'), path.join(workspace, 'new')); await git(workspace, ['add', '-A'])
  const entries = (await listGit(workspace, 'staged')).entries
  assert.equal(entries[0].status, 'renamed'); assert.equal(entries[0].previousPath, 'old')
  const worktree = path.join(root, 'worktree'); await git(workspace, ['worktree', 'add', '--detach', worktree, 'HEAD'])
  assert.equal((await availability(worktree)).status, 'available')
  const api = new ChangesApi(store), scope = { sessionId: 's', root: workspace }
  const data = await api.listChanges(scope, 'staged')
  await writeFile(path.join(workspace, 'new'), 'later')
  const detail = await api.getFileDiff(scope, 'staged', data.entries[0].fileId, data.revision, 0)
  assert.equal(detail.rows[0].kind, 'gap')
  const context = await api.getFileContext(scope, 'staged', data.entries[0].fileId, data.revision, 0)
  assert.equal(context.rows[0].text, 'content')
  await assert.rejects(api.getFileDiff({ ...scope, sessionId: 'other' }, 'staged', data.entries[0].fileId, data.revision, 0), /stale/)
})

test('real DSH execution records write/edit, nested calls, cancelled post-policy and shell failures', async t => {
  const bin = process.env.DSH_DESKTOP_DSH_BIN || path.join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
  let runtime
  try { runtime = createRequire(bin) } catch { t.skip('DSH runtime unavailable'); return }
  const imp = name => import(pathToFileURL(runtime.resolve(name)).href)
  const { Context } = await imp('@deepseek-ai/cordis')
  const { default: Tools } = await imp('@deepseek-ai/dsh-tools')
  const { default: SystemPrompt } = await imp('@deepseek-ai/dsh-system-prompt')
  const { LocalFileSystem } = await imp('@deepseek-ai/dsh-fs-local')
  const fsTools = await imp('@deepseek-ai/dsh-tool-fs')
  const { workspace, store } = await fixture(t), ctx = new Context()
  ctx.plugin(SystemPrompt, {}); ctx.plugin(Tools, {}); ctx.plugin(LocalFileSystem, { cwd: workspace })
  await new Promise(resolve => setTimeout(resolve, 20))
  const agent = { id: 'session', session: { header: { cwd: workspace } } }
  installRecorder(ctx, store)
  // Register the shipped file tools against the actual runtime and local FS.
  fsTools.apply(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 1024 * 1024, readStreamMinSize: 1024 * 1024 })
  const run = (name, args, extra = {}) => ctx.tools.execute({ name, arguments: args, callId: Math.random().toString(), signal: new AbortController().signal, agent, ...extra })
  const write = await run('write', { file_path: path.join(workspace, 'a'), content: 'one\n' })
  assert.equal(write.isError, false, JSON.stringify(write))
  const edit = await run('edit', { file_path: path.join(workspace, 'a'), old_string: 'one', new_string: 'two' })
  assert.equal(edit.isError, false, JSON.stringify(edit))
  assert.equal(await readFile(path.join(workspace, 'a'), 'utf8'), 'two\n')
  let data = await store.list({ sessionId: agent.id, root: workspace })
  assert.equal(data.entries[0].operations.length, 2)
  assert.deepEqual(data.entries[0].stats, { added: 1, removed: 0 })
  const stop = ctx.on('tools/post-execute', async (exec, result, next) => exec.name === 'write' ? { kind: 'block', reason: 'test policy' } : next())
  await run('write', { file_path: path.join(workspace, 'a'), content: 'physical\n' }); stop()
  data = await store.list({ sessionId: agent.id, root: workspace })
  assert.equal(data.entries[0].after.text, 'physical\n')
  assert.equal(data.entries[0].operations.at(-1).finalStatus, 'error')
  ctx.tools.register({ name: 'composite', description: 'nested dispatch', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] },
    async execute(args, exec) {
      const result = await run('write', { file_path: path.join(workspace, 'nested'), content: 'nested\n' }, { parent: exec.token, rootCallId: exec.rootCallId })
      assert.equal(result.isError, false)
      return null
    } })
  assert.equal((await run('composite', {})).isError, false)
  assert.ok((await store.list({ sessionId: agent.id, root: workspace })).entries.some(e => e.path === 'nested' && e.stats.added === 1))
  const cancelled = new AbortController()
  const offCancel = ctx.on('tools/post-execute', async (exec, result, next) => { if (exec.name === 'write') cancelled.abort(); return next() })
  const cancelledWrite = await run('write', { file_path: path.join(workspace, 'cancelled'), content: 'written\n' }, { signal: cancelled.signal })
  offCancel(); assert.equal(cancelledWrite.isError, true)
  assert.ok((await store.list({ sessionId: agent.id, root: workspace })).entries.some(e => e.path === 'cancelled' && e.after.text === 'written\n'))
  ctx.tools.register({ name: 'bash', description: 'test foreground command', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] },
    async execute() { await rm(path.join(workspace, 'a')); throw Error('partial command failure') } })
  assert.equal((await run('bash', {})).isError, true)
  data = await store.list({ sessionId: agent.id, root: workspace })
  const restored = data.restoredEntries.find(e => e.path === 'a')
  assert.equal(restored.attribution, 'observed')
  assert.equal(restored.operations.at(-1).after.exists, false)
  assert.equal(restored.operations.at(-1).finalStatus, 'error')
  await store.flush()
})

test('Git conflicts are one explicit entry and never zero-change text', async t => {
  const { workspace } = await fixture(t); await initRepo(workspace)
  await writeFile(path.join(workspace, 'a'), 'base\n'); await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'base'])
  await git(workspace, ['checkout', '-b', 'side'])
  await writeFile(path.join(workspace, 'a'), 'side\n'); await git(workspace, ['commit', '-am', 'side'])
  await git(workspace, ['checkout', '-b', 'main-test', 'HEAD~1'])
  await writeFile(path.join(workspace, 'a'), 'main\n'); await git(workspace, ['commit', '-am', 'main'])
  await assert.rejects(git(workspace, ['merge', 'side']))
  const data = await listGit(workspace, 'working')
  assert.equal(data.entries.length, 1); assert.equal(data.entries[0].reason, 'conflict'); assert.equal(data.entries[0].stats.added, null)
})

test('verified parent ownership aggregates new operations; independent and fork history do not', async t => {
  const { workspace, store } = await fixture(t)
  const parent = { id: 'parent', session: { header: { cwd: workspace } } }, child = { id: 'child', session: { header: { cwd: workspace } } }
  const handlers = new Map()
  const ctx = { on(name, fn) { handlers.set(name, fn) }, effect() {}, get() { return { list: () => [parent, child], isOwnedBy: (id, owner) => id === child.id && owner === parent } } }
  installRecorder(ctx, store)
  const exec = { agent: child, name: 'write', arguments: {}, callId: 'owned', token: Symbol() }
  await handlers.get('tools/execute')(exec, async () => ({ isError: false, value: { path: path.join(workspace, 'child.txt'), before: null, after: 'new', operation: 'create' } }))
  handlers.get('tools/result')(exec, { isError: false })
  const parentData = await store.list({ sessionId: 'parent', root: workspace }), childData = await store.list({ sessionId: 'child', root: workspace })
  assert.equal(parentData.entries[0].operations[0].author, 'child')
  assert.deepEqual(parentData.entries[0].stats, childData.entries[0].stats)
  assert.equal((await store.list({ sessionId: 'fork', root: workspace })).entries.length, 0)
  const elsewhere = path.join(workspace, 'other'); await mkdir(elsewhere)
  assert.equal((await store.list({ sessionId: 'parent', root: elsewhere })).entries.length, 0)
})

test('large unchanged prefix is folded and context can be paged independently', async t => {
  const { workspace, store } = await fixture(t), scope = { sessionId: 's', root: workspace }, api = new ChangesApi(store)
  const prefix = Array.from({ length: 2000 }, (_, i) => 'line ' + i).join('\n') + '\n'
  await record(store, scope, endpoint(prefix + 'old\n'), endpoint(prefix + 'new\n'))
  const list = await api.listChanges(scope, 'session'), file = list.entries[0]
  const diff = await api.getFileDiff(scope, 'session', file.fileId, list.revision, 0)
  assert.ok(diff.rows.some(row => row.kind === '+' && row.text === 'new'))
  assert.ok(diff.rows.length < 10)
  const context = await api.getFileContext(scope, 'session', file.fileId, list.revision, 0)
  assert.equal(context.rows.length, 400); assert.equal(context.nextOffset, 400)
})

test('Windows path case aliases share one cumulative file identity', { skip: process.platform !== 'win32' }, async t => {
  const { workspace, store } = await fixture(t), scope = { sessionId: 's', root: workspace }
  await record(store, scope, endpoint('a'), endpoint('b'), 'A.TXT')
  await record(store, scope, endpoint('b'), endpoint('c'), 'a.txt')
  const data = await store.list(scope)
  assert.equal(data.entries.length, 1); assert.equal(data.entries[0].reason, null)
  assert.deepEqual(data.entries[0].stats, { added: 1, removed: 1 })
})
