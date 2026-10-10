import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { rootPath, identity } from './paths.mjs'
import { availability, listGit } from './git-provider.mjs'
import { GitHistory } from './git-history.mjs'
import { GitActions } from './git-actions.mjs'
import { GitContexts, CONTEXT_PREFIX } from './git-context.mjs'
import { endpointDiff } from './session-aggregate.mjs'
import { SOURCES, VIEWS, BASES, REASONS, contextBlocks } from '../shared/change-model.mjs'

export class ChangesApi {
  constructor(store, generator) {
    this.store = store; this.cache = new Map(); this.active = 0; this.endpointId = randomUUID(); this.history = new GitHistory()
    this.gitContexts = new GitContexts(this.endpointId, generator)
    this.gitActions = new GitActions((scope, source, signal) => source === 'session' ? store.list(scope, true) : listGit(scope.root, source, signal), this.gitContexts)
  }
  runGitAction(scope, action, source, revision, message, committedId, signal) {
    return this.gitActions[revision.startsWith(CONTEXT_PREFIX) || action === 'pushOnly' ? 'tracked' : 'run'](scope, action, source, revision, message, committedId, signal)
  }
  getGitContext(scope, source, signal) { return this.gitContexts.read(scope, source, signal) }
  listGitBranches(scope, signal) { return this.gitContexts.branches(scope, signal) }
  switchGitBranch(scope, branch, contextRevision, signal) { return this.gitActions.switchBranch(scope, branch, contextRevision, signal) }
  generateCommitMessage(scope, source, contextRevision, signal) { return this.gitContexts.generate(scope, source, contextRevision, signal) }
  getGitOperation(scope, contextRevision) { return this.gitActions.status(scope, contextRevision) }
  listCommits(scope, revision, offset, signal) { return this.history.list(scope, revision, offset, signal) }
  getCommitDetails(scope, revision, commitId, signal) { return this.history.details(scope, revision, commitId, signal) }
  async getCapabilities(scope, signal) {
    return { workspaceRoot: scope.root, endpointId: this.endpointId, supportedViews: VIEWS, gitAvailability: await availability(scope.root, signal), gitContextVersion: 1,
      supportedSources: SOURCES, recordingCoverage: '从开始采集起跨轮累计。文件工具保存前后内容；其他工具及其受管后台任务保存本地观察差异。扫描有时间和内容预算；原生终端、未受管后台进程及远程文件系统不能保证覆盖。观察记录不能证明修改作者。' }
  }
  key(scope, source) { return JSON.stringify([scope.sessionId, identity(scope.root), source]) }
  async listChanges(scope, source, signal) {
    if (!SOURCES.includes(source)) throw Error('invalid-source')
    if (this.active >= 4) throw Error('查询繁忙，请稍后重试')
    this.active++
    try {
      const data = source === 'session' ? await this.store.list(scope, true) : await listGit(scope.root, source, signal)
      signal?.throwIfAborted()
      const compare = (a, b) => (a.root || '').localeCompare(b.root || '') || a.path.localeCompare(b.path, 'zh-CN', { numeric: true })
      data.entries.sort(compare); data.restoredEntries?.sort(compare)
      // Bounded TTL cache holds exact list versions, with no filesystem paths accepted by detail.
      const key = this.key(scope, source) + data.revision
      this.cache.set(key, { ...data, time: Date.now() })
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value)
      const summarize = ({ diff, before, after, operations, segments, ...entry }) => ({ ...entry, operationCount: operations?.length || 0 })
      const totals = { session: { added: 0, removed: 0, files: 0 }, observed: { added: 0, removed: 0, files: 0 }, unavailable: 0 }
      for (const entry of data.entries) {
        if (entry.stats.added === null || entry.stats.removed === null) { totals.unavailable++; continue }
        const total = totals[entry.statsKind === 'observed' ? 'observed' : 'session']
        total.added += entry.stats.added; total.removed += entry.stats.removed; total.files++
      }
      return { ...data, workspaceRoot: scope.root, source, sessionId: scope.sessionId, totals,
        entries: data.entries.map(summarize), restoredEntries: (data.restoredEntries || []).map(summarize) }
    } finally { this.active-- }
  }
  file(scope, source, fileId, revision, offset) {
    if (!SOURCES.includes(source) || typeof fileId !== 'string' || typeof revision !== 'string' || !Number.isInteger(offset) || offset < 0) throw Error('invalid-request')
    const data = this.cache.get(this.key(scope, source) + revision)
    if (!data || Date.now() - data.time > 300000) throw Error('stale')
    const entry = [...data.entries, ...(data.restoredEntries || [])].find(entry => entry.fileId === fileId)
    if (!entry) throw Error('stale')
    return entry
  }
  async getFileContext(scope, source, fileId, revision, offset, signal) {
    const entry = this.file(scope, source, fileId, revision, offset)
    signal?.throwIfAborted()
    const block = contextBlocks(entry.diff.rows).find(block => block.hidden && offset >= block.id && offset < block.id + block.rows.length)
    if (!block) throw Error('invalid-request')
    const end = Math.min(offset + 400, block.id + block.rows.length)
    return { rows: entry.diff.rows.slice(offset, end), nextOffset: end < block.id + block.rows.length ? end : null }
  }
  async getFileDiff(scope, source, fileId, revision, offset, signal) {
    const entry = this.file(scope, source, fileId, revision, offset)
    signal?.throwIfAborted()
    const blocks = contextBlocks(entry.diff.rows)
    // Unchanged runs are placeholders, so the first page always reaches actual
    // changes instead of making the reader page through thousands of context lines.
    const folded = blocks.flatMap(block => block.hidden ? [{ kind: 'gap', offset: block.id, length: block.rows.length }] : block.rows)
    const rows = folded.slice(offset, offset + 400)
    return { fileId, revision, source, path: entry.path, status: entry.status, previousPath: entry.previousPath,
      beforeLabel: BASES[source][0], afterLabel: BASES[source][1], stats: entry.stats, reason: entry.reason,
      beforeNewline: entry.before.exists && entry.before.text ? entry.diff.beforeNewline : null,
      afterNewline: entry.after.exists && entry.after.text ? entry.diff.afterNewline : null, completeness: entry.completeness,
      attribution: entry.attribution, continuity: entry.continuity, statsKind: entry.statsKind,
      operationCount: entry.operations.length, segmentCount: entry.segments?.length || 0,
      rows, nextOffset: offset + rows.length < folded.length ? offset + rows.length : null, totalRows: folded.length, operations: [] }
  }
  async listFileOperations(scope, fileId, revision, recordKind, offset, signal) {
    const entry = this.file(scope, 'session', fileId, revision, offset)
    signal?.throwIfAborted()
    if (!['operations', 'segments'].includes(recordKind)) throw Error('invalid-request')
    const all = recordKind === 'segments' ? entry.segments : entry.operations
    const ordered = recordKind === 'operations' ? [...all].reverse() : all
    const records = ordered.slice(offset, offset + 20).map((record, i) => {
      const diff = record.diff || endpointDiff(record.before, record.after)
      const status = !record.before.exists && record.after.exists ? 'added'
        : record.before.exists && !record.after.exists ? 'deleted' : 'modified'
      const index = recordKind === 'operations' ? all.length - offset - i : offset + i + 1
      return { id: record.id, index, stats: diff.stats, reason: diff.reason, origin: record.origin,
        callId: record.callId, author: record.author, finalStatus: record.finalStatus, evidenceOnly: record.evidenceOnly || false,
        startedAt: record.startedAt, endedAt: record.endedAt, status,
        noTextChange: !diff.reason && diff.stats.added === 0 && diff.stats.removed === 0 }
    })
    return { records, total: all.length, nextOffset: offset + records.length < all.length ? offset + records.length : null }
  }
  async getOperationDiff(scope, fileId, revision, operationId, offset, signal) {
    const entry = this.file(scope, 'session', fileId, revision, offset)
    signal?.throwIfAborted()
    const record = [...entry.operations, ...entry.segments].find(record => record.id === operationId)
    if (!record) throw Error('stale')
    const diff = record.diff || endpointDiff(record.before, record.after), rows = diff.rows.slice(offset, offset + 400)
    return { rows, stats: diff.stats, reason: diff.reason, totalRows: diff.rows.length,
      beforeNewline: record.before.exists && record.before.text ? diff.beforeNewline : null,
      afterNewline: record.after.exists && record.after.text ? diff.afterNewline : null,
      nextOffset: offset + rows.length < diff.rows.length ? offset + rows.length : null }
  }
  async *subscribeChanges(scope, sinceRevision, signal) {
    let wake, changed = true
    const off = this.store.subscribe(() => { changed = true; wake?.() })
    const abort = () => wake?.()
    signal.addEventListener('abort', abort)
    try {
      while (!signal.aborted) {
        if (changed) { changed = false; yield { revision: String(this.store.revision) } }
        await new Promise(resolve => { wake = resolve; if (changed || signal.aborted) resolve() })
      }
    } finally { off(); signal.removeEventListener('abort', abort) }
  }
}

export async function resolveScope(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length > 256) return undefined
  const header = ctx.sessions.get(sessionId)?.header ?? (await ctx.get('sessionPersistence')?.stat(sessionId))?.header
  if (!header) return undefined
  if (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw Error('missing')
  try { return { sessionId, root: await rootPath(header.cwd) } }
  catch { return { sessionId, root: path.resolve(header.cwd) } }
}
export const explain = error => REASONS[error?.message] || '更改查询失败，请重试'
