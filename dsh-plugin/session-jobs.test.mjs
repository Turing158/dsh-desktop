/**
 * Guards the session-jobs control's placement and its reading of the roster.
 *
 * Two classes of bug are invisible in the live app until it is too late:
 *
 *   1. A regression in the seat geometry, which is arithmetic over three rects
 *      and therefore not something a screenshot review catches reliably.
 *   2. A regression in what counts as interruptible — a settled job listed as
 *      running, or a live one dropped — which only shows up in a conversation
 *      that happens to have that mix.
 *
 * The model is data in and data out; the geometry is rects in and offsets out.
 * Both are exercised here without React or a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  cancellableJobs, orderCancellable, liveSummary, formatDuration,
  triggerLabel, badgeText, summaryText, isCancellable,
} from './session-jobs/model.mjs'
import { seatGeometry, panelGeometry } from './session-jobs/geometry.mjs'

const t = (source, values) => String(source).replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match)
const job = (id, status, startedAt = 0, extra = {}) => ({ id, status, startedAt, kind: 'pwsh', label: id, output: { total: 0, earliest: 0 }, ...extra })

test('only live rows are listed, and settling removes a row without touching the others', () => {
  const rows = [job('a', 'running'), job('b', 'completed'), job('c', 'stopping'), job('d', 'killed'), job('e', 'failed')]
  assert.deepEqual(cancellableJobs(rows).map(row => row.id), ['a', 'c'])
  assert.equal(isCancellable(undefined), false)
  assert.equal(isCancellable({ status: 'completed' }), false)
  assert.deepEqual(cancellableJobs(undefined), [])
  assert.deepEqual(cancellableJobs([job('z', 'running')]).map(row => row.id), ['z'])
})

test('ordering is stable: running before stopping, then oldest first', () => {
  const rows = [job('late', 'running', 30), job('stop', 'stopping', 1), job('early', 'running', 10), job('tie-b', 'running', 20), job('tie-a', 'running', 20)]
  assert.deepEqual(orderCancellable(rows).map(row => row.id), ['early', 'tie-a', 'tie-b', 'late', 'stop'])
  // The input array is not sorted in place: the caller renders from a snapshot.
  assert.equal(rows[0].id, 'late')
})

test('counts drive both the badge and the summary line', () => {
  assert.deepEqual(liveSummary([]), { running: 0, stopping: 0, total: 0 })
  assert.deepEqual(liveSummary([job('a', 'running'), job('b', 'running'), job('c', 'stopping')]), { running: 2, stopping: 1, total: 3 })
  assert.equal(summaryText({ running: 0, stopping: 0, total: 0 }, t), '空闲')
  assert.equal(summaryText({ running: 2, stopping: 1, total: 3 }, t), '2 个运行中')
  assert.equal(summaryText({ running: 0, stopping: 1, total: 1 }, t), '1 个正在停止')
  assert.equal(badgeText(1), '1')
  assert.equal(badgeText(9), '9')
  assert.equal(badgeText(10), '9+')
})

test('durations omit zero units and retain zero seconds only at startup', () => {
  assert.equal(formatDuration(-5000, t), '0秒')
  assert.equal(formatDuration(0, t), '0秒')
  assert.equal(formatDuration(59_400, t), '59秒')
  assert.equal(formatDuration(60_000, t), '1分钟')
  assert.equal(formatDuration(90_000, t), '1分钟30秒')
  assert.equal(formatDuration(3_600_000, t), '1小时')
  assert.equal(formatDuration(3_601_000, t), '1小时1秒')
  assert.equal(formatDuration(3_900_000, t), '1小时5分钟')
  assert.equal(formatDuration(3_901_000, t), '1小时5分钟1秒')
})

test('the trigger name carries the count only while work is live', () => {
  assert.equal(triggerLabel(0, t), '后台任务')
  assert.equal(triggerLabel(2, t), '后台任务 · 2 个运行中')
})

test('seat geometry right-aligns to the corner control and centres on the tabs row', () => {
  const header = { left: 0, top: 44, right: 1005, bottom: 120, width: 1005, height: 76 }
  // The header measured in the reported screenshot: corner control x=965..993,
  // tabs row y=94..119, header y=44..120.
  const corner = { left: 965, top: 55, right: 993, bottom: 83, width: 28, height: 28 }
  const tabs = { left: 20, top: 94, right: 977, bottom: 119, width: 957, height: 25 }
  assert.deepEqual(seatGeometry(header, corner, tabs), { right: 12, top: 48 })
  // Without a corner control the tabs strip's own edge takes over.
  assert.equal(seatGeometry(header, null, tabs).right, 28)
  // Without tabs it sits on the header's bottom padding instead of over content.
  assert.equal(seatGeometry(header, corner, null).top, 40)
  // A zero-sized corner (not painted before a session exists) is not a handle.
  assert.equal(seatGeometry(header, { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, tabs).right, 28)
  // A short header cannot push the control below its own bottom edge.
  assert.equal(seatGeometry({ left: 0, top: 0, right: 400, bottom: 20, width: 400, height: 20 }, null, null).top, 0)
})

test('panel geometry stays on screen and flips above the trigger when needed', () => {
  const anchor = { left: 900, right: 928, top: 50, bottom: 78, width: 28, height: 28 }
  // Right-aligned to the trigger's edge: a 360px panel under a trigger ending at x=928.
  assert.deepEqual(panelGeometry(anchor, { width: 0, height: 200 }, { width: 1005, height: 700 }), { left: 568, top: 84, width: 360 })
  // A 240px tall panel under a trigger 100px from the bottom has to flip.
  assert.equal(panelGeometry({ ...anchor, top: 600, bottom: 628 }, { width: 360, height: 240 }, { width: 1005, height: 700 }).top, 354)
  // A narrow viewport clamps the width, and both edges stay off the glass.
  assert.deepEqual(panelGeometry({ left: 4, right: 32, top: 20, bottom: 48, width: 28, height: 28 }, { width: 0, height: 100 }, { width: 300, height: 500 }), { left: 8, top: 54, width: 284 })
  // An unmeasured panel opens downward on the first frame rather than guessing.
  assert.equal(panelGeometry(anchor, { width: 0, height: 0 }, { width: 1005, height: 700 }).top, 84)
})

test('the packaged client is the built bundle, not a stale copy', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const patch = readFileSync(new URL('./desktop-notify.patch.yml', import.meta.url), 'utf8')
  assert.ok(patch.includes('./session-jobs/index.js'), 'the patch must mount the control, or nothing serves its browser half')
  for (const file of ['package.json', 'index.js', 'client.js']) {
    assert.equal(config.bundle.resources[`../dsh-plugin/session-jobs/${file}`], `dsh-plugin/session-jobs/${file}`, `${file} is mounted but not packaged`)
  }
  const bundle = readFileSync(new URL('./session-jobs/client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('@dsh-desktop/session-jobs'), 'the built client must announce the plugin id')
  assert.ok(bundle.includes('conversation.session.header.utilities'), 'the built client must register in the header utilities')
  assert.ok(bundle.includes('dshSessionJobs__seat'), 'the built client must carry its stylesheet')
})
