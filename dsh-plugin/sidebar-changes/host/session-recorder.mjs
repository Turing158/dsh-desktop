import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { rootPath, relative, readEndpoint, absent, hash, fileIdentity } from './paths.mjs'
import { LIMITS } from '../shared/change-model.mjs'

const STRUCTURED = new Set(['write', 'edit', 'str_replace_editor'])
export const DEFAULT_EXCLUDES = ['.git']
export async function scan(root, excludes = DEFAULT_EXCLUDES, options = {}) {
  const files = new Map(), gaps = [], excluded = [], directories = [root]
  let bytes = 0, visited = 0
  const deadline = Date.now() + (options.milliseconds ?? 10000), maxFiles = options.files ?? 100000
  const maxBytes = options.bytes ?? LIMITS.scanBytes
  // Breadth first: a generated subtree must not starve sibling source files.
  for (let cursor = 0; cursor < directories.length; cursor++) {
    const directory = directories[cursor]
    if (++visited > maxFiles || Date.now() > deadline) { gaps.push({ reason: 'scan', path: relative(root, directory) || '.', detail: '扫描时间或目录预算耗尽' }); break }
    let children
    try { children = await readdir(directory, { withFileTypes: true }) }
    catch { gaps.push({ reason: 'scan', path: relative(root, directory) || '.', detail: '无法读取目录' }); continue }
    for (const child of children) {
      const file = path.join(directory, child.name), name = relative(root, file)
      if (child.name === '.git' || excludes.includes(child.name)) { excluded.push(name); continue }
      if (files.size >= maxFiles || Date.now() > deadline) { gaps.push({ reason: 'scan', path: relative(root, directory) || '.', detail: '扫描时间或文件预算耗尽' }); break }
      if (child.isDirectory()) { directories.push(file); continue }
      try {
        const value = await readEndpoint(root, file, { maxBytes: Math.max(0, maxBytes - bytes) })
        files.set(name, value); bytes += Buffer.byteLength(value.text || '')
        if (value.reason === 'scan-content') gaps.push({ reason: 'scan-content', path: name })
      } catch { gaps.push({ reason: 'scan', path: name, detail: '无法读取文件快照' }) }
    }
  }
  return { files, incomplete: gaps.some(g => g.reason === 'scan'), gaps, excluded }
}
const endpoint = (text, exists, reason = null) => ({ exists, text, reason, hash: typeof text === 'string' ? hash(text) : null, mode: null })
async function compareScans(root, beforeScan, afterScan) {
  const operations = [], gaps = [...beforeScan.gaps, ...afterScan.gaps]
  const excluded = [...new Set([...beforeScan.excluded, ...afterScan.excluded])].filter(p => path.basename(p) !== '.git')
  if (excluded.length) gaps.push({ reason: 'excluded', paths: excluded })
  for (const name of new Set([...beforeScan.files.keys(), ...afterScan.files.keys()])) {
    const before = beforeScan.files.get(name) || (beforeScan.incomplete ? endpoint(null, true, 'scan') : absent())
    let after = afterScan.files.get(name)
    if (!after) {
      try { after = afterScan.incomplete ? await readEndpoint(root, name) : absent() }
      catch { gaps.push({ reason: 'scan', path: name }); continue }
    }
    // A content-budget change must not manufacture an edit to an unchanged file.
    const same = before.fingerprint && before.fingerprint === after.fingerprint || before.hash === after.hash
    if (!same || before.exists !== after.exists || before.mode !== after.mode) operations.push({ path: name, before, after, origin: 'observed' })
  }
  return { operations, gaps }
}
export function structuredOperation(exec, value, root) {
  if (!STRUCTURED.has(exec.name) || !value || typeof value.path !== 'string' || typeof value.after !== 'string') return null
  if (value.before !== null && typeof value.before !== 'string') return null
  const absolutePath = path.resolve(root, value.path), file = relative(root, absolutePath) || absolutePath.replaceAll('\\', '/')
  const created = value.operation === 'create'
  return { path: file, absolutePath, before: endpoint(created ? '' : value.before, !created, value.before === null && !created ? 'baseline' : null), after: endpoint(value.after, true), origin: 'structured' }
}
export const persistentSessionId = agent => agent?.session?.id || agent?.session?.header?.id || agent?.id

/** Collection belongs to the Host lifetime, never to a turn or browser tab. */
export function installRecorder(ctx, store, options = {}) {
  const executions = new Map(), nesting = new AsyncLocalStorage(), clockId = randomUUID()
  const tails = new Set()
  const now = () => performance.timeOrigin + performance.now()
  const safe = async action => { try { return await action() } catch { return undefined } }
  ctx.on('tools/execute', async (exec, next) => {
    const sessionId = persistentSessionId(exec.agent)
    if (!sessionId) return next()
    const root = await safe(() => rootPath(exec.agent.session?.header?.cwd))
    if (!root) return next()
    const scope = { sessionId, root }, token = randomUUID(), startedAt = now(), ancestors = nesting.getStore() || []
    const jobs = await safe(() => ctx.get?.('jobs'))
    const priorJobs = new Set((await safe(() => jobs?.list(sessionId)) || []).map(job => job.id))
    const owners = [scope]
    let agent = exec.agent
    const agents = await safe(() => ctx.get?.('agents')), visited = new Set([agent.id])
    while (agents?.isOwnedBy && (agent = await safe(() => agents.list().find(candidate => agents.isOwnedBy(agent.id, candidate))))) {
      if (visited.has(agent.id)) break
      visited.add(agent.id)
      const parentRoot = await safe(() => rootPath(agent.session?.header?.cwd))
      if (parentRoot) owners.push({ sessionId: persistentSessionId(agent), root: parentRoot })
    }
    executions.set(exec.token, { owners, token })
    for (const owner of owners) await safe(() => store.begin(owner, token, exec.callId))
    let previous = null
    const file = exec.arguments?.path || exec.arguments?.file_path
    if (STRUCTURED.has(exec.name) && typeof file === 'string' && relative(root, file)) previous = await safe(() => readEndpoint(root, file))
    // Unknown tools can invoke arbitrary scripts/MCP writes, so observe them too.
    const needsScan = !STRUCTURED.has(exec.name)
    const beforeScan = needsScan ? await safe(() => scan(root, options.excludes, options.scanLimits)) : null
    let result, threw = true
    try { result = await nesting.run([...ancestors, token], next); threw = false; return result }
    finally {
      const captured = await safe(async () => {
        let operations = [], gaps = [], finalScan
        const authoritative = structuredOperation(exec, result?.value, root)
        if (authoritative) operations.push(authoritative)
        else if (beforeScan) {
          finalScan = await safe(() => scan(root, options.excludes, options.scanLimits))
          if (!finalScan) gaps.push(...beforeScan.gaps, { reason: 'scan', path: '.', detail: '执行后快照失败' })
          else {
            ;({ operations, gaps } = await compareScans(root, beforeScan, finalScan))
          }
        } else {
          if (needsScan) gaps.push({ reason: 'scan', path: '.', detail: '执行前快照失败' })
          else if (previous) {
            const after = await safe(() => readEndpoint(root, file))
            if (after && (after.hash !== previous.hash || after.exists !== previous.exists || after.mode !== previous.mode)) operations.push({ path: relative(root, file), before: previous, after, origin: 'observed' })
            if (!after) gaps.push({ reason: 'storage', path: file })
          } else gaps.push({ reason: 'legacy' })
        }
        const endedAt = now()
        operations = await Promise.all(operations.map(async (op, sequence) => {
          const absolutePath = op.absolutePath || path.resolve(root, op.path)
          return { ...op, absolutePath, fileIdentity: await fileIdentity(absolutePath), author: sessionId, callId: exec.callId,
            rootCallId: exec.rootCallId || exec.callId, execution: token, ancestors, clockId, startedAt, endedAt,
            sequence, finalStatus: threw || result?.isError ? 'error' : 'success', physicalModification: true }
        }))
        for (const owner of owners) {
          const owned = operations.map(op => ({ ...op, path: relative(owner.root, op.absolutePath) || op.absolutePath.replaceAll('\\', '/') }))
          await store.finish(owner, token, owned, gaps.length ? gaps : null)
        }
        // Only jobs created inside this execution are associated with its tail.
        // Unowned or detached processes have no trustworthy lifecycle here.
        const newJobs = (await safe(() => jobs?.list(sessionId)) || []).filter(job => job.owner === sessionId && !priorJobs.has(job.id))
        if (finalScan && newJobs.length) {
          await followJobs({ jobs, ids: newJobs.map(job => job.id), owners, sessionId, root, baseline: finalScan, callId: exec.callId })
        }
        return true
      })
      if (!captured) for (const owner of owners) await safe(() => store.finish(owner, token, [], 'storage'))
    }
  })
  ctx.on('tools/result', (exec, result) => {
    const state = executions.get(exec.token)
    if (!state) return
    executions.delete(exec.token)
    for (const owner of state.owners) void store.final(owner, state.token, result.isError ? 'error' : 'success').catch(() => {})
  })
  async function followJobs({ jobs, ids, owners, sessionId, root, baseline, callId }) {
    let before = baseline, startedAt = now(), token = randomUUID(), running, stopped = false, rerun = false
    for (const owner of owners) await store.begin(owner, token, callId)
    const activeJobs = () => ids.map(id => { try { return jobs.get(id, sessionId) } catch { return null } })
    const tick = () => {
      if (stopped) return Promise.resolve()
      if (running) { rerun = true; return running }
      running = (async () => {
        const state = activeJobs(), done = state.every(job => !job || !['running', 'stopping'].includes(job.status))
        const after = await scan(root, options.excludes, options.scanLimits)
        const { operations, gaps } = await compareScans(root, before, after), endedAt = now()
        for (const owner of owners) await store.finish(owner, token, await Promise.all(operations.map(async (op, sequence) => {
          const absolutePath = path.resolve(root, op.path)
          return { ...op, absolutePath, path: relative(owner.root, absolutePath) || absolutePath.replaceAll('\\', '/'),
            fileIdentity: await fileIdentity(absolutePath), author: sessionId, execution: token, callId, clockId, startedAt, endedAt,
            sequence, channel: 'background-job', finalStatus: state.some(job => job?.status === 'failed' || job?.status === 'killed') ? 'error' : 'success' }
        })), gaps.length ? gaps : null)
        before = after; startedAt = endedAt
        if (done || stopped) stop()
        else { token = randomUUID(); for (const owner of owners) await store.begin(owner, token, callId) }
      })().catch(async () => {
        stop(); for (const owner of owners) await safe(() => store.finish(owner, token, [], 'storage'))
      }).finally(() => { running = null; if (rerun && !stopped) { rerun = false; void tick() } })
      return running
    }
    const off = jobs.events?.subscribe({ owner: sessionId }, event => { if (event.type === 'settled' && ids.includes(event.job.id)) void tick() })
    const timer = setInterval(tick, options.jobPollMs ?? 1000); timer.unref?.()
    const stop = () => { stopped = true; clearInterval(timer); off?.(); tails.delete(dispose) }
    const dispose = async () => {
      stop(); await running
      for (const owner of owners) await safe(() => store.finish(owner, token, [], 'interrupted'))
    }
    tails.add(dispose)
    // The job may have settled while the pending journal was being committed.
    if (activeJobs().every(job => !job || !['running', 'stopping'].includes(job.status))) void tick()
  }
  ctx.effect(() => async () => { await Promise.all([...tails].map(dispose => dispose())); await store.flush() }, 'desktop changes recorder')
}
