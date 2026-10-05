import { mkdir, readFile, writeFile, rename, readdir, stat, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hash, identity } from './paths.mjs'
import { LIMITS } from '../shared/change-model.mjs'
import { aggregateSession } from './session-aggregate.mjs'

async function atomic(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}
export class SnapshotStore {
  constructor(directory, limits = LIMITS) {
    this.directory = directory; this.limits = limits; this.queue = Promise.resolve()
    this.listeners = new Set(); this.failures = new Map(); this.revision = 0; this.live = new Set(); this.owner = randomUUID()
    this.ready = this.initialize()
    // Rejections are observed even when the feature has no open panel.
    this.ready.catch(() => {})
  }
  async initialize() {
    await mkdir(path.join(this.directory, 'objects'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(this.directory, 'sessions'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(this.directory, 'sessions-v2'), { recursive: true, mode: 0o700 })
    this.bytes = 0
    for (const folder of ['objects', 'sessions', 'sessions-v2']) for (const name of await readdir(path.join(this.directory, folder))) {
      this.bytes += (await stat(path.join(this.directory, folder, name))).size
    }
  }
  key(scope) { return hash(JSON.stringify([scope.sessionId, identity(scope.root)])) }
  indexPath(scope) { return path.join(this.directory, 'sessions-v2', this.key(scope) + '.json') }
  async read(scope) {
    await this.ready
    try {
      let value
      try { value = JSON.parse(await readFile(this.indexPath(scope), 'utf8')) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        value = JSON.parse(await readFile(path.join(this.directory, 'sessions', this.key(scope) + '.json'), 'utf8'))
      }
      if (![1, 2].includes(value.schemaVersion) || value.sessionId !== scope.sessionId || identity(value.root) !== identity(scope.root)) throw Error('storage')
      value.coverageEvents ||= []
      value.schemaVersion = 2
      return value
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('storage')
      return { schemaVersion: 2, sessionId: scope.sessionId, root: scope.root, startedAt: Date.now(), revision: 0, operations: [], pending: {}, gaps: [], coverageEvents: [] }
    }
  }
  enqueue(scope, update) {
    const task = this.queue.then(async () => {
      await this.ready
      const release = await this.lock()
      try {
      const index = await this.read(scope)
      index.eventSequence = (index.eventSequence || 0) + 1
      await update(index)
      index.revision++
      const bytes = Buffer.byteLength(JSON.stringify(index))
      let previous = 0
      try { previous = (await stat(this.indexPath(scope))).size } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (this.bytes + bytes - previous > this.limits.disk) throw Error('quota')
      await atomic(this.indexPath(scope), index)
      this.bytes += bytes - previous
      await atomic(path.join(this.directory, 'usage.json'), { bytes: this.bytes })
      this.revision++
      this.listeners.forEach(listener => listener())
      } finally { await release() }
    })
    this.queue = task.catch(error => {
      this.failures.set(this.key(scope), error.message === 'quota' ? 'quota' : 'storage')
      this.revision++; this.listeners.forEach(listener => listener())
    })
    return task
  }
  async lock() {
    const file = path.join(this.directory, 'write.lock'), deadline = Date.now() + 5000
    while (true) {
      try {
        const handle = await open(file, 'wx')
        await handle.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner }))
        await handle.close()
        try {
          const usage = JSON.parse(await readFile(path.join(this.directory, 'usage.json'), 'utf8'))
          this.bytes = Math.max(this.bytes, usage.bytes || 0)
        } catch { /* First writer uses the measured on-disk size. */ }
        return async () => { await unlink(file) }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        // Never steal a live writer's lock. An abandoned lock is explicit until
        // recovered by the next host; PID liveness prevents timeout corruption.
        try {
          const raw = await readFile(file, 'utf8'), owner = JSON.parse(raw)
          let dead = false
          try { process.kill(owner.pid, 0) } catch (error) { dead = error.code === 'ESRCH' }
          if (dead && await readFile(file, 'utf8') === raw) await unlink(file)
        } catch { /* A competing writer may just have released the lock. */ }
        if (Date.now() >= deadline) throw Error('storage')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }
  async snapshot(endpoint) {
    if (typeof endpoint.text !== 'string') return { ...endpoint, text: undefined, ref: null }
    const data = Buffer.from(endpoint.text), ref = hash(data)
    if (data.length > this.limits.bytes) return { ...endpoint, text: undefined, ref: null, reason: 'large' }
    const file = path.join(this.directory, 'objects', ref)
    try { await stat(file) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (this.bytes + data.length > this.limits.disk) throw Error('quota')
      // Content-addressed objects are committed before their index references.
      const tmp = file + '.' + randomUUID() + '.tmp'
      await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, file); this.bytes += data.length
    }
    return { ...endpoint, text: undefined, ref }
  }
  async content(endpoint) {
    if (!endpoint.ref) return { ...endpoint, text: endpoint.exists === false ? '' : null }
    try {
      if (!/^[a-f0-9]{64}$/.test(endpoint.ref)) throw Error('storage')
      const data = await readFile(path.join(this.directory, 'objects', endpoint.ref))
      if (hash(data) !== endpoint.ref) throw Error('storage')
      return { ...endpoint, text: data.toString('utf8') }
    } catch { return { ...endpoint, text: null, reason: 'storage' } }
  }
  begin(scope, token, callId) {
    this.live.add(token)
    return this.enqueue(scope, index => { index.pending[token] = { callId, owner: this.owner, pid: process.pid, startedAt: Date.now(), sequence: index.eventSequence }; })
  }
  finish(scope, token, operations, gap = null) {
    return this.enqueue(scope, async index => {
      for (const operation of operations) {
        const before = await this.snapshot(operation.before), after = await this.snapshot(operation.after)
        const id = operation.id || hash(JSON.stringify([operation.author, token, operation.sequence, operation.path]))
        if (!index.operations.some(op => op.id === id)) index.operations.push({ ...operation, before, after, id,
          startOrder: index.pending[token]?.sequence, endOrder: index.eventSequence })
      }
      delete index.pending[token]
      this.live.delete(token)
      if (gap) {
        const events = typeof gap === 'string' ? [{ reason: gap }] : gap
        for (const event of events) index.coverageEvents.push({ ...event, execution: token, at: Date.now() })
      }
    }).finally(() => this.live.delete(token))
  }
  final(scope, token, status) {
    return this.enqueue(scope, index => {
      for (const operation of index.operations) if (operation.execution === token) operation.finalStatus = status
    })
  }
  async list(scope, allRoots = false) {
    await this.ready
    await this.queue
    const roots = new Map([[identity(scope.root), scope.root]]), discoveryGaps = []
    if (allRoots) for (const folder of ['sessions', 'sessions-v2']) for (const name of await readdir(path.join(this.directory, folder))) {
      if (!name.endsWith('.json')) continue
      try {
        const value = JSON.parse(await readFile(path.join(this.directory, folder, name), 'utf8'))
        if (value.sessionId === scope.sessionId && typeof value.root === 'string') roots.set(identity(value.root), value.root)
      } catch { discoveryGaps.push('storage') }
    }
    const indexes = []
    for (const root of [...roots.values()].sort()) {
      try { indexes.push(await this.read({ ...scope, root })) }
      catch { discoveryGaps.push('storage') }
    }
    const gaps = new Set(discoveryGaps), coverageEvents = []; let pendingCount = 0
    for (const index of indexes) {
      for (const gap of index.gaps) gaps.add(gap === 'scan' ? 'legacy-scan' : gap)
      coverageEvents.push(...index.coverageEvents.map(event => ({ ...event, root: index.root })))
      for (const event of index.coverageEvents) if (event.reason) gaps.add(event.reason)
      for (const [token, pending] of Object.entries(index.pending)) {
        if (this.live.has(token)) pendingCount++
        else if (pending.owner && pending.owner !== this.owner && pending.pid !== process.pid) {
          try { process.kill(pending.pid, 0); pendingCount++ } catch { gaps.add('interrupted') }
        } else gaps.add('interrupted')
      }
      const failure = this.failures.get(this.key({ ...scope, root: index.root }))
      if (failure) gaps.add(failure)
    }
    const result = await aggregateSession(indexes, endpoint => this.content(endpoint))
    return { ...result, revision: hash(JSON.stringify([indexes.map(i => [i.root, i.revision]), [...gaps], pendingCount,
      [...result.entries, ...result.restoredEntries].map(e => [e.fileId, e.reason, e.segments.map(s => s.diff.reason)])])),
      gaps: [...gaps], coverageEvents, pendingCount, roots: [...roots.values()], startedAt: indexes.length ? Math.min(...indexes.map(i => i.startedAt)) : null,
      coverage: 'structured-and-observed', completeness: gaps.size || result.entries.some(e => e.completeness !== 'complete') ? 'partial' : 'complete' }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  flush() { return this.queue }
}
