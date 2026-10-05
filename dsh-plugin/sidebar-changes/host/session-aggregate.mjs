import path from 'node:path'
import { hash, identity } from './paths.mjs'
import { diffText, unknownDiff } from '../shared/change-model.mjs'

const normalized = text => text.replace(/\r\n/g, '\n')
export function sameEndpoint(a, b) {
  if (a.exists !== b.exists) return false
  if (!a.exists) return true
  if (a.mode && b.mode && a.mode !== b.mode) return false
  if (typeof a.text === 'string' && typeof b.text === 'string') return normalized(a.text) === normalized(b.text)
  return Boolean(a.hash && b.hash && !['baseline', 'storage', 'scan'].includes(a.reason)
    && !['baseline', 'storage', 'scan'].includes(b.reason) && a.hash === b.hash)
}
export const endpointDiff = (before, after) => before.reason || after.reason
  ? unknownDiff(before.reason || after.reason) : diffText(before.text, after.text)
const interval = op => Number.isFinite(op.startedAt) && Number.isFinite(op.endedAt)
const overlaps = (a, b) => interval(a) && interval(b) && a.startedAt < b.endedAt && b.startedAt < a.endedAt
const concurrent = (a, b) => a.root === b.root && Number.isFinite(a.startOrder) && Number.isFinite(b.startOrder)
  ? a.startOrder < b.endOrder && b.startOrder < a.endOrder
  : a.clockId && a.clockId === b.clockId && overlaps(a, b)

/** Same physical file, regardless of tool, turn, root alias or capture source. */
export async function aggregateSession(indexes, content) {
  const groups = new Map(), loaded = new Map()
  const load = endpoint => {
    const key = JSON.stringify(endpoint)
    if (!loaded.has(key)) loaded.set(key, content(endpoint))
    return loaded.get(key)
  }
  for (const index of indexes) for (const raw of index.operations) {
    const absolute = raw.absolutePath || path.resolve(index.root, raw.path)
    const key = raw.fileIdentity || identity(absolute)
    if (!groups.has(key)) groups.set(key, [])
    const group = groups.get(key)
    if (group.some(op => op.id === raw.id)) continue
    group.push({ ...raw, root: index.root, absolutePath: absolute,
      before: await load(raw.before), after: await load(raw.after) })
  }
  const entries = [], restoredEntries = []
  for (const [key, history] of groups) {
    // New operations retain a host clock and interval. Legacy append order remains
    // intact; do not invent timestamps to reorder old or cross-process captures.
    history.sort((a, b) => a.root === b.root && Number.isFinite(a.startOrder) && Number.isFinite(b.startOrder)
      ? a.startOrder - b.startOrder || a.sequence - b.sequence
      : a.clockId && a.clockId === b.clockId ? a.startedAt - b.startedAt || a.sequence - b.sequence : 0)
    const aliases = [...new Set(history.flatMap(op => {
      const relativeKey = process.platform === 'win32' ? op.path.toLowerCase() : op.path
      return [hash(relativeKey), hash(relativeKey + '\0observed')]
    }))]
    const operations = history.filter(op => {
      if (op.origin !== 'observed' || !interval(op)) return true
      const children = history.filter(other => other !== op && other.origin === 'structured' && other.clockId === op.clockId
        && other.ancestors?.includes(op.execution) && other.startedAt >= op.startedAt && other.endedAt <= op.endedAt)
      if (!children.length || !sameEndpoint(op.before, children[0].before) || !sameEndpoint(op.after, children.at(-1).after)) return true
      if (children.some((child, i) => i && (overlaps(children[i - 1], child) || !sameEndpoint(children[i - 1].after, child.before)))) return true
      op.evidenceOnly = true
      return false
    })
    const segments = []
    for (const op of operations) {
      const previous = segments.at(-1)?.operations.at(-1)
      const uncertain = previous && (concurrent(previous, op) || previous.root !== op.root)
      if (!previous || uncertain || !sameEndpoint(previous.after, op.before)) {
        segments.push({ operations: [op], before: op.before, after: op.after, reason: uncertain ? 'concurrent' : null })
      } else {
        segments.at(-1).operations.push(op); segments.at(-1).after = op.after
      }
    }
    if (!segments.length) continue
    for (const [i, segment] of segments.entries()) {
      segment.id = 'segment-' + i
      segment.diff = endpointDiff(segment.before, segment.after)
    }
    const before = segments[0].before, after = segments.at(-1).after
    const continuity = segments.length > 1 ? 'broken' : 'continuous'
    const attribution = operations.every(op => op.origin === 'structured') ? 'confirmed' : 'observed'
    const diff = continuity === 'broken' ? unknownDiff(segments.some(s => s.reason === 'concurrent') ? 'concurrent' : 'interleaved') : endpointDiff(before, after)
    const restored = continuity === 'continuous' && sameEndpoint(before, after)
    const last = operations.at(-1)
    const entry = { fileId: hash(key), aliases, path: last.path, root: last.root, absolutePath: last.absolutePath, previousPath: null,
      status: restored ? 'restored' : continuity === 'broken' ? 'modified' : !before.exists ? 'added' : !after.exists ? 'deleted' : 'modified',
      diffAvailability: diff.reason ? segments.some(segment => !segment.diff.reason) ? 'partial' : 'unavailable' : 'available',
      attribution, continuity, statsKind: diff.reason ? 'unavailable' : attribution === 'confirmed' ? 'session' : 'observed',
      completeness: diff.reason ? 'partial' : 'complete', reason: diff.reason, stats: diff.stats, diff,
      operations: history, segments, before, after }
    ;(restored ? restoredEntries : entries).push(entry)
  }
  return { entries, restoredEntries }
}
