/**
 * Integration test for the one assumption the notification plugin rests on.
 *
 * The plugin observes `user-questions/request` by registering a waterfall
 * listener with `{ prepend: true }` and delegating with `next()`. That is
 * required because DSH's browser bridge (`@deepseek-ai/dsh-api-remotes`)
 * registers an ordinary listener that forwards the question to the UI and
 * resolves WITHOUT calling `next()`. A listener registered after it would never
 * be reached, and the question would silently never produce a notification.
 *
 * This test drives the REAL `@deepseek-ai/cordis` dispatcher — not a fake — so
 * the ordering conclusion is executed rather than inferred. It needs the DSH
 * installation on disk, so it is skipped (not failed) when that is absent.
 *
 * Run with: `node --test dsh-plugin/`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Candidate roots where the DSH installation's dependencies might live. */
function dependencyRoots() {
  const roots = []
  const appData = process.env.APPDATA
  if (appData) {
    // The shared module fallback a profile resolves through.
    roots.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
    roots.push(path.join(appData, '.dsh', 'profiles', 'node_modules'))
  }
  return roots.filter((root) => existsSync(root))
}

/** Load the real Cordis package from wherever the DSH installation keeps it. */
function loadCordis() {
  for (const root of dependencyRoots()) {
    try {
      const require = createRequire(path.join(root, 'noop.js'))
      return { cordis: require('@deepseek-ai/cordis'), root }
    } catch {
      /* try the next root */
    }
  }
  return null
}

const loaded = loadCordis()

test('the real Cordis dispatcher runs a prepended observer before a non-delegating handler', async (t) => {
  if (loaded === null) {
    t.skip('DSH installation not found; cannot load @deepseek-ai/cordis')
    return
  }

  const { Context } = loaded.cordis
  const ctx = new Context()
  const order = []

  // Stand-in for `dsh-api-remotes`: forwards to the UI and RESOLVES WITHOUT
  // calling next(), exactly as the shipped bridge does on the happy path.
  ctx.on('user-questions/request', async () => {
    order.push('bridge')
    return { answers: [{ id: 'q1', selected: ['from-ui'] }] }
  })

  // The observer under test: prepended, delegates with next(), returns its result.
  ctx.on(
    'user-questions/request',
    (request, next) => {
      order.push('observer')
      return next()
    },
    { prepend: true },
  )

  const answer = await ctx.waterfall('user-questions/request', { questions: [] }, () =>
    Promise.reject(new Error('no answerer')),
  )

  assert.deepEqual(
    order,
    ['observer', 'bridge'],
    'the prepended observer must run before the non-delegating bridge',
  )
  assert.deepEqual(
    answer,
    { answers: [{ id: 'q1', selected: ['from-ui'] }] },
    'the bridge answer must travel back unchanged through the observer',
  )
})

test('without prepend, the observer is never reached (the failure this guards)', async (t) => {
  if (loaded === null) {
    t.skip('DSH installation not found; cannot load @deepseek-ai/cordis')
    return
  }

  const { Context } = loaded.cordis
  const ctx = new Context()
  const order = []

  // The non-delegating bridge registers first, as it does in the shipped tree.
  ctx.on('user-questions/request', async () => {
    order.push('bridge')
    return { answers: [] }
  })

  // An ordinary (non-prepended) observer, which is what a naive implementation
  // would write.
  ctx.on('user-questions/request', (request, next) => {
    order.push('observer')
    return next()
  })

  await ctx.waterfall('user-questions/request', { questions: [] }, () =>
    Promise.reject(new Error('no answerer')),
  )

  assert.deepEqual(
    order,
    ['bridge'],
    'an ordinary listener after the bridge never runs — hence prepend: true',
  )
})

/**
 * Capture the notification lines the plugin writes to stdout.
 *
 * @returns a restore function plus a reader for the parsed payloads.
 */
function captureStdout() {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  return {
    restore: () => {
      console.log = original
    },
    payloads: () =>
      lines
        .filter((line) => line.startsWith('__DSH_NOTIFY__'))
        .map((line) => JSON.parse(line.slice('__DSH_NOTIFY__'.length + 1))),
  }
}

test('the real plugin, mounted in a real Cordis context, reports a question', async (t) => {
  if (loaded === null) {
    t.skip('DSH installation not found; cannot load @deepseek-ai/cordis')
    return
  }

  const { Context } = loaded.cordis
  const { apply } = await import('./desktop-notify.mjs')
  const ctx = new Context()

  // The shipped bridge registers first and does not delegate.
  ctx.on('user-questions/request', async () => ({ answers: [{ id: 'q1', selected: ['ok'] }] }))

  const captured = captureStdout()
  try {
    apply(ctx, {})

    const answer = await ctx.waterfall(
      'user-questions/request',
      { questions: [{ id: 'q1', header: '选择工作区', question: '用哪个？' }] },
      () => Promise.reject(new Error('no answerer')),
    )

    const [payload] = captured.payloads()
    assert.ok(payload, 'the plugin must emit a notification line')
    assert.equal(payload.kind, 'question')
    assert.equal(payload.title, 'DSH 需要你的选择')
    assert.equal(payload.body, '选择工作区')
    assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['ok'] }] }, 'the UI answer still wins')
  } finally {
    captured.restore()
  }
})

test('real scoped agent events deliver quota errors once, before turn cleanup', async (t) => {
  if (loaded === null) {
    t.skip('DSH installation not found; cannot load the scoped agent dispatcher')
    return
  }
  const require = createRequire(path.join(loaded.root, 'noop.js'))
  const { agentEvents, agentCarrier } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')))
  const { LlmError } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
  const { apply } = await import('./desktop-notify.mjs')
  const ctx = new loaded.cordis.Context()
  const session = { id: 'quota-live', header: { cwd: 'D:\\work\\quota-project' }, seq: 0 }
  const agent = { session }
  ctx.provide('agents', { roots: () => [agent], get: id => id === session.id ? agent : undefined })
  const dispatch = agentEvents(ctx, agent)
  const captured = captureStdout()
  try {
    apply(ctx, {})
    dispatch.emit('agent/status', { status: 'running' })
    const error = new LlmError('Insufficient Balance', 'QUOTA', { status: 402 })
    dispatch.emit('agent/error', { turn: 1, step: 1, error })
    assert.equal(captured.payloads().length, 1, 'toast must precede durable cleanup and idle')
    assert.match(captured.payloads()[0].title, /额度不足/)
    assert.match(captured.payloads()[0].body, /quota-project/)

    ctx.emit(agentCarrier(agent), 'session/event', session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: error.failure } },
    })
    dispatch.emit('agent/status', { status: 'idle' })
    assert.equal(captured.payloads().length, 1, 'live and durable errors are one failure')
  } finally {
    captured.restore()
  }
})
