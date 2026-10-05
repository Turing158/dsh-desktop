/**
 * Pins the packet-handling contract of the terminal view against the REAL source.
 *
 * ## Why this file exists
 *
 * The view's transport is native and its surface is React, so the layer in
 * between — how `runtime.mjs` consumes the packets it is sent — is where a
 * protocol mistake hides with nothing to catch it. One did:
 *
 *   A STATE packet carries the last DATA record's `seq` (`pump` in
 *   `src-tauri/src/terminal/session.rs` stamps `Body::State` with `a.sent`), so it
 *   can repeat a number already consumed — and does: a shell announces `starting`
 *   and then `running` while the journal holds only its initial resize record, so
 *   the second announcement arrives at seq 1 again. The view applied its strict
 *   data-sequence guard to that packet, threw `terminal-sequence`, and rendered
 *   桌面连接中断 over a terminal whose transport was answering perfectly: chrome
 *   painted, every keystroke refused.
 *
 * The live reproduction that found this is `tools/lan-terminal-repro.mjs`, which
 * needs a real window, a real LAN bind and a real PTY. It is too heavy to be the
 * only guard, so the rule it proved is pinned here instead: the guard must sit on
 * the DATA branch, and a state packet must never be measured against it.
 *
 * A NOTE ON METHOD. This reads the shipped source rather than re-implementing the
 * rule, because a re-implementation proves only that this file agrees with
 * itself. The assertions are anchored to the branches they describe — the guard
 * inside `if (packet.type === 'data')`, and the `else` arm that takes the state —
 * so moving the guard back out fails them.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'sidebar-terminal', 'runtime.mjs'), 'utf8')

/** The packet consumer, from its declaration to the channel assignment. */
function consumerSection() {
  const start = source.indexOf('const consume = packet => {')
  assert.notEqual(start, -1, 'the view must still consume packets through `consume`')
  const end = source.indexOf('channel.onmessage', start)
  assert.notEqual(end, -1, '`consume` must still be wired to the channel')
  return source.slice(start, end)
}

test('the strict sequence guard applies to data packets only', () => {
  const section = consumerSection()
  const guard = section.indexOf("if (packet.seq !== seq + 1) throw 'terminal-sequence'")
  const dataBranch = section.indexOf("if (packet.type === 'data') {")
  const stateBranch = section.indexOf('} else {', dataBranch)
  assert.notEqual(guard, -1, 'the data sequence guard must exist')
  assert.notEqual(dataBranch, -1, 'the consumer must branch on the packet type')
  assert.notEqual(stateBranch, -1, 'the consumer must keep a state branch')

  // The guard lives after the data branch opens and before it closes: a state
  // packet therefore never reaches it. Moving the guard above the branch — the
  // regression this file exists for — puts it before `dataBranch` and fails here.
  assert.ok(dataBranch < guard, 'the guard must sit INSIDE the data branch')
  assert.ok(guard < stateBranch, 'the guard must not escape the data branch')

  // The window it advances and acknowledges is the data one.
  assert.match(section.slice(dataBranch, stateBranch), /seq = packet\.seq/, 'only a data packet advances the sequence')
  assert.match(section.slice(dataBranch, stateBranch), /terminal_ack/, 'only a data packet is acknowledged')
})

test('a state packet updates the view without touching the data sequence', () => {
  const section = consumerSection()
  const dataBranch = section.indexOf("if (packet.type === 'data') {")
  const stateBranch = section.indexOf('} else {', dataBranch)
  const state = section.slice(stateBranch)
  assert.match(state, /info = packet\.info/, 'a state packet must replace the view info')
  assert.match(state, /info\.error/, 'a reported error must still be surfaced')
  assert.doesNotMatch(state, /packet\.seq/, 'a state packet must never be measured against the data sequence')
  assert.doesNotMatch(state, /seq \+ 1/, 'the strict guard must not appear in the state arm')
})

test('a preference scope the Host cannot carry never blocks a terminal', () => {
  const open = source.slice(source.indexOf('async function open('), source.indexOf('function matchesProfile('))
  // The measured failure: `await preferences?.ready()` rejected on an
  // `unavailable` scope (every non-loopback page), and the PTY was never opened.
  const call = open.indexOf('preferences?.ready()')
  assert.notEqual(call, -1, 'opening must still consult the saved preferences')
  assert.match(open.slice(call, call + 80), /\.catch\(\(\) => \{\}\)/, 'a preference failure must not refuse the terminal')
})
