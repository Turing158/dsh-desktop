import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmIdleWatchdog, LlmRequestGate, repairDeepSeekPayload, requestScope, retryAfterMs, streamWithDesktopControls } from './llm-request-control.mjs'

function fakeClock() {
  let now = 1_000_000, id = 0
  const timers = new Map()
  return { now: () => now,
    setTimer: (fn, delay) => { const key = ++id; timers.set(key, { at: now + delay, fn }); return key },
    clearTimer: key => timers.delete(key),
    async advance(ms) {
      const end = now + ms
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        timers.delete(next[0])
        next[1].fn()
        await Promise.resolve()
      }
      now = end
      await Promise.resolve()
    },
  }
}

test('16 simultaneous requests cannot exceed 15 in any rolling minute or burst on release', async () => {
  const clock = fakeClock(), gate = new LlmRequestGate(clock), starts = []
  const calls = Array.from({ length: 16 }, () => gate.acquire('gateway').then(() => starts.push(clock.now())))
  await Promise.resolve()
  assert.equal(starts.length, 1)
  await clock.advance(61_005)
  await Promise.all(calls)
  assert.equal(starts.length, 16)
  for (const start of starts) assert.ok(starts.filter(time => time >= start && time < start + 60_000).length <= 15)
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 4067)
})

test('failed HTTP and transport requests consume slots; other credentials remain independent', async () => {
  const clock = fakeClock(), gate = new LlmRequestGate(clock), sent = []
  const send = gate.wrapFetch(async input => { sent.push({ input, at: clock.now() }); throw new Error('network failed') }, 'mock-key')
  await assert.rejects(send('https://gateway.test/v1/chat/completions'), /network failed/)
  const retry = assert.rejects(send('https://gateway.test/v1/responses'), /network failed/)
  const other = gate.wrapFetch(async () => new Response('', { status: 400 }), 'different-mock-key')
  assert.equal((await other('https://gateway.test/v1/chat/completions')).status, 400)
  assert.equal(sent.length, 1)
  await clock.advance(4067)
  await retry
  assert.equal(sent.length, 2)
  assert.equal(sent[1].at - sent[0].at, 4067)
})

test('429 freezes a shared queue for at least a minute and respects a longer Retry-After', async () => {
  const clock = fakeClock(), gate = new LlmRequestGate(clock), sent = []
  let fail = true
  const send = gate.wrapFetch(async () => { sent.push(clock.now()); return new Response('', {
    status: fail ? 429 : 200, headers: fail ? { 'retry-after': '90' } : {},
  }) }, 'mock-key')
  await send('https://gateway.test/v1/chat/completions')
  fail = false
  const retry = send('https://gateway.test/v1/responses')
  await clock.advance(89_999)
  assert.equal(sent.length, 1)
  await clock.advance(1)
  await retry
  assert.equal(sent[1] - sent[0], 90_000)
  gate.cooldown(requestScope('https://gateway.test/v1/responses', undefined, 'mock-key'), 'invalid')
  const next = send('https://gateway.test/v1/responses')
  await clock.advance(60_999)
  assert.equal(sent.length, 2)
  await clock.advance(1)
  await next
  assert.equal(sent[2] - sent[1], 61_000)
})

test('cancelling a queued request releases its place without consuming a slot', async () => {
  const clock = fakeClock(), gate = new LlmRequestGate(clock), controller = new AbortController()
  await gate.acquire('gateway')
  const cancelled = assert.rejects(gate.acquire('gateway', controller.signal), /cancelled/)
  const next = gate.acquire('gateway')
  controller.abort(new Error('cancelled'))
  await cancelled
  await clock.advance(4067)
  await next
  assert.equal(gate.scopes.get('gateway').starts.length, 2)
  await clock.advance(60_000)
  assert.equal(gate.scopes.size, 0, 'expired idle budgets should release their storage')
})

test('HTTP origins, model aliases and actual auth headers scope budgets without retaining keys', () => {
  const alias = requestScope('http://localhost:9173/v1/chat/completions', { headers: { authorization: 'Bearer mock-key' } })
  assert.equal(alias, requestScope(new Request('http://127.0.0.1:9173/v1/responses', { headers: { authorization: 'Bearer mock-key' } })))
  assert.equal(alias, requestScope('http://localhost:9173/v1/messages', { headers: { 'x-api-key': 'mock-key' } }))
  assert.notEqual(alias, requestScope('http://localhost:9173/v1/chat/completions', { headers: { authorization: 'Bearer another-key' } }))
  assert.notEqual(alias, requestScope('http://localhost:9174/v1/chat/completions', { headers: { authorization: 'Bearer mock-key' } }))
  assert.match(alias, /^[a-f0-9]{64}$/)
})

test('Retry-After accepts seconds and HTTP dates, including delays beyond the timer range', () => {
  assert.equal(retryAfterMs('120', 0), 120_000)
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 30_000), 90_000)
  assert.equal(retryAfterMs('invalid', 0), 0)
  assert.equal(retryAfterMs('-1', 0), 0)
  assert.equal(retryAfterMs('9'.repeat(400), 0), 0)
  assert.equal(retryAfterMs('9999999', 0), 9_999_999_000)
})

const model = { api: 'openai-completions', provider: 'gateway', id: 'deepseek-v4.1', baseUrl: 'https://gateway.test/v1' }
test('raw reasoning is restored, explicit opt-outs and non-DeepSeek models remain intact', () => {
  const details = [{ type: 'reasoning.summary', summary: 'not original reasoning' },
    { type: 'reasoning.text', text: 'part one' }, { type: 'reasoning.text', text: ' and two' },
    { type: 'reasoning.encrypted', data: 'opaque-metadata' }]
  const payload = { messages: [{ role: 'assistant', content: 'answer', reasoning_content: '', reasoning_details: details }] }
  const before = JSON.stringify(payload)
  assert.equal(repairDeepSeekPayload(payload, model, { messages: [] }).messages[0].reasoning_content, 'part one and two')
  assert.equal(JSON.stringify(payload), before)
  assert.equal(repairDeepSeekPayload(payload, { ...model, compat: { requiresReasoningContentOnAssistantMessages: false } }, { messages: [] }), payload)
  assert.equal(repairDeepSeekPayload(payload, { ...model, id: 'glm-model' }, { messages: [] }), payload)
  const existing = { messages: [{ role: 'assistant', reasoning_content: 'existing', reasoning_details: details }] }
  assert.equal(repairDeepSeekPayload(existing, model, { messages: [] }).messages[0].reasoning_content, 'existing')
  const encrypted = { messages: [{ role: 'assistant', reasoning_details: details.filter(detail => detail.type !== 'reasoning.text') }] }
  assert.equal(repairDeepSeekPayload(encrypted, model, { messages: [] }).messages[0].reasoning_content, '')
})

test('an alias is recognized from its own response model, without importing another model reasoning', () => {
  const alias = { ...model, id: 'alias' }, payload = { messages: [{ role: 'assistant', reasoning: 'original' }] }
  const history = [{ role: 'assistant', api: alias.api, provider: alias.provider, model: alias.id, responseModel: 'deepseek/deepseek-v4.1' }]
  assert.equal(repairDeepSeekPayload(payload, alias, { messages: history }).messages[0].reasoning_content, 'original')
  assert.equal(repairDeepSeekPayload(payload, alias, { messages: [{ ...history[0], model: 'another-model' }] }), payload)
})

test('native Google and Vertex contracts pass through without an unsupported fetch hook', () => {
  const options = { apiKey: 'mock-key' }, context = { messages: [] }, gate = new LlmRequestGate()
  for (const api of ['google-generative-ai', 'google-vertex', 'bedrock-converse-stream']) {
    const result = streamWithDesktopControls((target, history, offered) => {
      assert.equal(offered, options)
      assert.equal(offered.fetch, undefined)
      assert.equal(history, context)
      return 'native-stream'
    }, { ...model, api }, context, options, gate)
    assert.equal(result, 'native-stream')
  }
})

test('idle timeout settles independently of an iterator that ignores cancellation', async () => {
  const idle = new LlmIdleWatchdog(undefined, 20)
  try {
    await assert.rejects(idle.next({ next: () => new Promise(() => {}) }), /LLM_STREAM_IDLE_TIMEOUT/)
    assert.equal(idle.timedOut, true)
    assert.equal(idle.waiting, false)
  } finally { idle.dispose() }
})

test('caller cancellation also settles an unresponsive iterator without a timeout', async () => {
  const controller = new AbortController(), idle = new LlmIdleWatchdog(controller.signal, 1000)
  try {
    const waiting = assert.rejects(idle.next({ next: () => new Promise(() => {}) }), /caller cancelled/)
    controller.abort(new Error('caller cancelled'))
    await waiting
    assert.equal(idle.timedOut, false)
  } finally { idle.dispose() }
})
