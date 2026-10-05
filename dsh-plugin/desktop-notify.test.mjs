/**
 * Unit tests for the desktop-notify host plugin.
 *
 * Run with: `node --test dsh-plugin/`
 *
 * These drive the plugin through a fake Cordis context, so they pin the two
 * things that are easy to get wrong and are not visible from the outside:
 * the `prepend: true` ordering requirement on the question waterfall, and the
 * exclusion of `reasoning` blocks from a notification body.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from './desktop-notify.mjs'

const MARKER = '__DSH_NOTIFY__'

/** Build a session stub shaped like the real `Session` surface this plugin reads. */
function makeSession(id, events, cwd = 'D:\\work\\my-project') {
  return {
    id,
    header: { cwd },
    seq: events.length,
    eventAt: (at) => events[at],
  }
}

/** A session whose only assistant text sits after a reasoning block. */
function sessionWithAssistantText(id, text, reasoning = 'private chain of thought', cwd) {
  return makeSession(
    id,
    [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [
              { type: 'reasoning', text: reasoning },
              { type: 'text', text },
            ],
          },
        },
      },
    ],
    cwd,
  )
}

/**
 * Capture `console.log` and the plugin's registered listeners.
 *
 * @returns the fake context, the recorded registrations, and a line reader.
 */
function harness(roots = []) {
  const registrations = []
  const lines = []
  const byId = new Map(roots.map((agent) => [agent.session.id, agent]))

  const ctx = {
    on(event, callback, options) {
      registrations.push({ event, callback, options })
      return () => {}
    },
    get(service) {
      if (service !== 'agents') return undefined
      return {
        roots: () => roots,
        get: (id) => byId.get(id),
      }
    },
  }

  const original = console.log
  console.log = (...args) => {
    lines.push(args.join(' '))
  }

  return {
    ctx,
    registrations,
    restore: () => {
      console.log = original
    },
    /** Every captured stdout line, in order. */
    lines,
    /** Parsed notification payloads only. */
    notifications() {
      return lines
        .filter((line) => line.startsWith(MARKER))
        .map((line) => JSON.parse(line.slice(MARKER.length + 1)))
    },
    /** The single recorded listener for an event. */
    listener(event) {
      const found = registrations.filter((entry) => entry.event === event)
      assert.equal(found.length, 1, `expected exactly one ${event} listener, got ${found.length}`)
      return found[0]
    },
  }
}

test('exports the Cordis plugin shape and injects nothing', () => {
  assert.equal(name, 'desktop-notify')
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
})

test('registers the question observer BEFORE the UI answerer (prepend)', () => {
  const h = harness()
  try {
    apply(h.ctx, {})
    const registration = h.listener('user-questions/request')
    // Load-bearing: api-remotes answers without calling next(), so an observer
    // registered after it would never run.
    assert.equal(registration.options?.prepend, true)
  } finally {
    h.restore()
  }
})

test('reports a question and still delegates to the UI answerer', async () => {
  const h = harness()
  try {
    apply(h.ctx, {})
    const answer = { answers: [{ id: 'q1', selected: ['yes'] }] }
    const delegate = () => Promise.resolve(answer)
    const request = {
      questions: [{ id: 'q1', header: '选择模式', question: '用哪种模式？', options: [{ label: 'yes' }] }],
      agent: undefined,
    }

    const returned = h.listener('user-questions/request').callback(request, delegate)
    assert.equal(await returned, answer, 'must return the delegate result unchanged')

    const [notification] = h.notifications()
    assert.equal(notification.kind, 'question')
    assert.equal(notification.title, 'DSH 需要你的选择')
    assert.equal(notification.body, '选择模式')
  } finally {
    h.restore()
  }
})

test('labels a plan review distinctly from a plain question', () => {
  const h = harness()
  try {
    apply(h.ctx, {})
    const request = {
      questions: [
        { id: 'plan-review', header: '计划待确认', question: '批准吗？', intent: { kind: 'plan-review', approve: '批准' } },
      ],
    }
    h.listener('user-questions/request').callback(request, () => Promise.resolve({}))
    assert.equal(h.notifications()[0].title, 'DSH 计划待确认')
  } finally {
    h.restore()
  }
})

test('never leaks reasoning text into a notification body', () => {
  const agent = { id: 's1', session: sessionWithAssistantText('s1', '这里是最终回答') }
  const h = harness([agent])
  try {
    apply(h.ctx, {})

    const session = agent.session
    const status = h.listener('agent/status')
    const events = h.listener('session/event')

    status.callback({ agent, status: 'running' })
    events.callback(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    status.callback({ agent, status: 'idle' })

    const [notification] = h.notifications()
    assert.equal(notification.kind, 'task-end')
    assert.equal(notification.title, 'DSH 任务完成')
    assert.match(notification.body, /这里是最终回答/)
    assert.doesNotMatch(notification.body, /private chain of thought/)
  } finally {
    h.restore()
  }
})

test('a throwing observer body cannot break the question flow', async () => {
  const h = harness()
  try {
    apply(h.ctx, {})
    // `questions` is a getter that throws, standing in for any malformed request.
    const request = {
      get questions() {
        throw new Error('boom')
      },
    }
    const delegate = () => Promise.resolve({ ok: true })
    const returned = h.listener('user-questions/request').callback(request, delegate)
    assert.deepEqual(await returned, { ok: true })
  } finally {
    h.restore()
  }
})

test('stays quiet for a delegated (non-root) agent', () => {
  const root = { id: 'root', session: sessionWithAssistantText('root', 'root answer') }
  const child = { id: 'child', session: sessionWithAssistantText('child', 'child answer') }
  const h = harness([root]) // only `root` is a top-level agent
  try {
    apply(h.ctx, {})
    const status = h.listener('agent/status')
    const events = h.listener('session/event')

    status.callback({ agent: child, status: 'running' })
    events.callback(child.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    status.callback({ agent: child, status: 'idle' })

    assert.deepEqual(h.notifications(), [])
  } finally {
    h.restore()
  }
})

test('an idle transition with no completed turn raises nothing', () => {
  const agent = { id: 's2', session: sessionWithAssistantText('s2', 'unused') }
  const h = harness([agent])
  try {
    apply(h.ctx, {})
    const status = h.listener('agent/status')

    // runMaintenance: reaches idle without ever being `running` or closing a turn.
    status.callback({ agent, status: 'idle' })
    assert.deepEqual(h.notifications(), [])

    // Cancellation during a turn: running, but no turn/end was recorded.
    status.callback({ agent, status: 'running' })
    status.callback({ agent, status: 'idle' })
    assert.deepEqual(h.notifications(), [])
  } finally {
    h.restore()
  }
})

test('honours notifyOnError=false for both live errors and turn endings', () => {
  const agent = { id: 's3', session: sessionWithAssistantText('s3', 'partial output') }
  const h = harness([agent])
  try {
    apply(h.ctx, { notifyOnError: false })
    const status = h.listener('agent/status')
    const events = h.listener('session/event')

    status.callback({ agent, status: 'running' })
    h.listener('agent/error').callback({ agent, turn: 1, step: 1, error: new Error('Insufficient Balance') })
    events.callback(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
    status.callback({ agent, status: 'idle' })

    assert.deepEqual(h.notifications(), [], 'error notifications are disabled')
  } finally {
    h.restore()
  }
})

test('reports quota exhaustion immediately, even without a turn/end or idle event', () => {
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA']) {
    const agent = { session: sessionWithAssistantText('quota', 'unrelated partial answer') }
    const h = harness([agent])
    try {
      apply(h.ctx, {})
      h.listener('agent/status').callback({ agent, status: 'running' })
      const error = Object.assign(new Error('Insufficient Balance'), {
        failure: { code, message: 'Insufficient Balance', status: 402 },
      })
      h.listener('agent/error').callback({ agent, turn: 1, step: 1, error })
      assert.equal(h.notifications().length, 1)
      const [notification] = h.notifications()
      assert.equal(notification.reason, 'error')
      assert.equal(notification.sessionId, 'quota')
      assert.match(notification.title, /额度不足/)
      assert.match(notification.body, /额度或余额已耗尽/)
      assert.match(notification.body, /my-project/)
      assert.doesNotMatch(notification.body, /unrelated partial answer|private chain of thought/)
    } finally {
      h.restore()
    }
  }
})

test('reports errors before the first running transition', () => {
  const agent = { session: makeSession('early', []) }
  const h = harness([agent])
  try {
    apply(h.ctx, {})
    h.listener('agent/error').callback({ agent, turn: 0, step: 0, error: new Error('Cannot write session') })
    assert.equal(h.notifications().length, 1)
    assert.match(h.notifications()[0].body, /Cannot write session/)
  } finally {
    h.restore()
  }
})

test('uses durable failure details when only turn/end is available', () => {
  for (const error of [{ code: 'NETWORK', message: 'Connection reset' }, 'Connection reset', null]) {
    const agent = { session: sessionWithAssistantText('durable', 'old answer') }
    const h = harness([agent])
    try {
      apply(h.ctx, {})
      h.listener('agent/status').callback({ agent, status: 'running' })
      h.listener('session/event').callback(agent.session, {
        type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error } },
      })
      h.listener('agent/status').callback({ agent, status: 'idle' })
      assert.equal(h.notifications().length, 1)
      assert.equal(h.notifications()[0].title, 'DSH 任务出错')
      assert.match(h.notifications()[0].body, error ? /Connection reset/ : /任务因错误中断/)
      assert.doesNotMatch(h.notifications()[0].body, /old answer/)
    } finally {
      h.restore()
    }
  }
})

test('deduplicates a live failure and its turn/end, then permits the next run', () => {
  const agent = { session: makeSession('recovery', []) }
  const h = harness([agent])
  try {
    apply(h.ctx, {})
    const status = h.listener('agent/status').callback
    const event = h.listener('session/event').callback
    const failed = h.listener('agent/error').callback
    status({ agent, status: 'running' })
    failed({ agent, turn: 1, step: 1, error: new Error('Connection reset') })
    status({ agent, status: 'running' }) // duplicate publication must not reset deduplication
    failed({ agent, turn: 1, step: 1, error: new Error('Cannot record turn/end') })
    event(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
    status({ agent, status: 'idle' })
    status({ agent, status: 'idle' })
    assert.equal(h.notifications().length, 1)

    status({ agent, status: 'running' })
    event(agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    status({ agent, status: 'idle' })
    assert.deepEqual(h.notifications().map(item => item.reason), ['error', 'completed'])

    status({ agent, status: 'running' })
    failed({ agent, turn: 3, step: 1, error: new Error('Another failure') })
    assert.deepEqual(h.notifications().map(item => item.reason), ['error', 'completed', 'error'])
  } finally {
    h.restore()
  }
})

test('a failure after an earlier completed turn never reports task completion', () => {
  const agent = { session: makeSession('multi', []) }
  const h = harness([agent])
  try {
    apply(h.ctx, {})
    h.listener('agent/status').callback({ agent, status: 'running' })
    h.listener('session/event').callback(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    h.listener('agent/error').callback({ agent, turn: 2, step: 0, error: new Error('Cannot start next turn') })
    h.listener('agent/status').callback({ agent, status: 'idle' })
    assert.deepEqual(h.notifications().map(item => item.reason), ['error'])
  } finally {
    h.restore()
  }
})

test('delegated failures and recoverable request retries stay quiet', () => {
  const root = { session: makeSession('root', []) }
  const child = { session: makeSession('child', []) }
  const h = harness([root, child])
  try {
    // Keep the child discoverable by ID, but exclude it from the root list.
    const get = h.ctx.get.bind(h.ctx)
    h.ctx.get = service => ({ ...get(service), roots: () => [root] })
    apply(h.ctx, {})
    const status = h.listener('agent/status').callback
    status({ agent: child, status: 'running' })
    h.listener('agent/error').callback({ agent: child, turn: 1, step: 1, error: new Error('child failure') })
    h.listener('session/event').callback(child.session, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    status({ agent: child, status: 'idle' })
    status({ agent: root, status: 'running' })
    h.listener('session/event').callback(root.session, { type: 'llm/retry', data: { failure: { code: 'NETWORK' } } })
    assert.deepEqual(h.notifications(), [])
  } finally {
    h.restore()
  }
})

test('malformed errors still notify with a bounded generic body', () => {
  const agent = { session: makeSession('malformed', [], '') }
  const h = harness([agent])
  try {
    apply(h.ctx, { maxBodyChars: 40 })
    const error = { get failure() { throw new Error('bad getter') } }
    h.listener('agent/error').callback({ agent, error })
    assert.match(h.notifications()[0].body, /任务因错误中断/)
    h.listener('agent/status').callback({ agent, status: 'running' })
    h.listener('agent/error').callback({ agent, error: new Error('x'.repeat(500)) })
    assert.equal(h.notifications()[1].body.length, 40)
  } finally {
    h.restore()
  }
})

test('a deliberate stop is silent by default, audible when enabled', () => {
  const agent = { id: 's4', session: sessionWithAssistantText('s4', 'stopped here') }
  const h = harness([agent])
  try {
    apply(h.ctx, {})
    const status = h.listener('agent/status')
    const events = h.listener('session/event')

    status.callback({ agent, status: 'running' })
    events.callback(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    status.callback({ agent, status: 'idle' })
    assert.deepEqual(h.notifications(), [], 'aborted is silent by default')
  } finally {
    h.restore()
  }

  const agent2 = { id: 's5', session: sessionWithAssistantText('s5', 'stopped here') }
  const h2 = harness([agent2])
  try {
    apply(h2.ctx, { notifyOnAborted: true })
    h2.listener('agent/status').callback({ agent: agent2, status: 'running' })
    h2.listener('session/event').callback(agent2.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    h2.listener('agent/status').callback({ agent: agent2, status: 'idle' })
    assert.equal(h2.notifications()[0].title, 'DSH 任务已中止')
  } finally {
    h2.restore()
  }
})

test('a multi-turn task produces exactly one notification', () => {
  const agent = { id: 's6', session: sessionWithAssistantText('s6', 'final answer') }
  const h = harness([agent])
  try {
    apply(h.ctx, {})
    const status = h.listener('agent/status')
    const events = h.listener('session/event')

    status.callback({ agent, status: 'running' })
    for (const turn of [1, 2, 3]) {
      events.callback(agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }
    status.callback({ agent, status: 'idle' })

    assert.equal(h.notifications().length, 1, 'one toast for the whole task, not one per turn')
  } finally {
    h.restore()
  }
})

test('truncates a long body to maxBodyChars', () => {
  const long = 'x'.repeat(500)
  const agent = { id: 's7', session: sessionWithAssistantText('s7', long, 'think') }
  const h = harness([agent])
  try {
    apply(h.ctx, { maxBodyChars: 80 })
    const status = h.listener('agent/status')
    status.callback({ agent, status: 'running' })
    h.listener('session/event').callback(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    status.callback({ agent, status: 'idle' })

    const body = h.notifications()[0].body
    assert.ok(body.length <= 80 + ' · my-project'.length, `body too long: ${body.length}`)
    assert.match(body, /^x+…/)
    assert.match(body, /my-project/, 'workspace label is appended as context')
  } finally {
    h.restore()
  }
})
