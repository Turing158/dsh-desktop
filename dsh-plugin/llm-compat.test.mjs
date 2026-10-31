/** Exercise the installed DSH adapter and its HTTP serializers, without any
 * real credentials, user settings or external model calls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { LlmRequestGate } from './llm-request-control.mjs'

const bin = process.env.DSH_DESKTOP_DSH_BIN
  || (process.env.APPDATA && join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'))
let runtime
if (bin && existsSync(bin)) {
  process.env.DSH_DESKTOP_DSH_BIN = bin
  const { runtimeImport } = await import('./runtime-import.mjs')
  const { Context } = await runtimeImport('@deepseek-ai/cordis')
  const upstream = await runtimeImport('@deepseek-ai/dsh-llm-pi-ai')
  const llm = await runtimeImport('@deepseek-ai/dsh-llm')
  const desktop = await import('./llm-compat.mjs')
  runtime = { Context, upstream, llm, ...desktop }
}

function assertRefused(chunks) {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /Unsupported reasoning effort/)
}

async function fixture(t, overrides = {}, controls = {}) {
  if (!runtime) { t.skip('Requires an installed DSH runtime'); return }
  const requests = []
  let refuse = false
  let respond
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    requests.push({ url: req.url, body, time: Date.now() })
    if (respond) return respond(body, res)
    if (refuse || req.url !== '/v1/chat/completions') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Unsupported reasoning effort at mock endpoint', type: 'invalid_request_error' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]) res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: body.model, ...chunk }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const profile = { api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}${overrides.api === 'anthropic-messages' ? '' : '/v1'}`,
    apiKeyEnv: 'MOCK_KEY', models: [{ id: 'custom-alias' }], ...overrides }
  let providers = { 'private-gateway': profile }
  const ctx = new runtime.Context()
  ctx.provide('launchEnvironment', { get: () => ({ value: 'mock-key' }) })
  new runtime.default(ctx, { requestGate: controls.requestGate
    ?? new LlmRequestGate({ maxRequests: 0, windowMs: 80, marginMs: 0 }) })
  runtime.upstream.apply(ctx, { providers: { get: () => providers } })
  t.after(() => ctx.fiber.dispose())
  const config = effort => ({ provider: 'private-gateway', model: 'custom-alias',
    ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  const consume = async (prepared, messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], signal) => {
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config,
      messages, signal,
    })) chunks.push(chunk)
    return chunks
  }
  return { ctx, profile, requests, config, consume,
    refuse: () => { refuse = true },
    respond: handler => { respond = handler },
    update: next => { providers = next; ctx.emit('loader/volatile-update') },
    call: async effort => consume(await ctx.llm.prepareCall(config(effort))),
  }
}

test('custom model selection offers six efforts, defaults to High and sends the selection', async t => {
  const h = await fixture(t); if (!h) return
  const model = await h.ctx.llm.resolveModelInfo('private-gateway', 'custom-alias')
  assert.deepEqual(model.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(model.reasoning.defaultEffort, 'high')
  for (const effort of runtime.CUSTOM_REASONING_LEVELS) {
    const chunks = await h.call(effort)
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'OK'))
    assert.equal(h.requests.at(-1).body.reasoning_effort, effort === 'off' ? 'none' : effort)
  }
  await h.call(undefined)
  assert.equal(h.requests.at(-1).body.reasoning_effort, 'high')
  const sent = h.requests.length
  for (const effort of ['minimal', 'xhight']) {
    await assert.rejects(h.call(effort), /reasoning/i)
  }
  assert.equal(h.requests.length, sent, 'removed choices cannot bypass call validation')
})

test('Responses receives the selected effort; endpoint refusal remains visible', async t => {
  const h = await fixture(t, { api: 'openai-responses' }); if (!h) return
  for (const effort of runtime.CUSTOM_REASONING_LEVELS) {
    assertRefused(await h.call(effort))
    assert.equal(h.requests.at(-1).url, '/v1/responses')
    assert.equal(h.requests.at(-1).body.reasoning.effort, effort === 'off' ? 'none' : effort)
  }
  assertRefused(await h.call(undefined))
  assert.equal(h.requests.at(-1).body.reasoning.effort, 'high')
})

test('Anthropic model aliases receive adaptive effort without model-name detection', async t => {
  const h = await fixture(t, { api: 'anthropic-messages' }); if (!h) return
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assertRefused(await h.call(effort))
    const { body, url } = h.requests.at(-1)
    assert.equal(new URL(url, 'http://localhost').pathname, '/v1/messages')
    assert.equal(body.thinking.type, 'adaptive')
    assert.equal(body.output_config.effort, effort)
  }
})

test('custom models with a restrictive declaration still offer fixed efforts and preserve wire mappings', async t => {
  const h = await fixture(t, { compat: { supportsReasoningEffort: false },
    models: [{ id: 'custom-alias', reasoningEfforts: { high: 'vendor-high' } }] }); if (!h) return
  const model = await h.ctx.llm.resolveModelInfo('private-gateway', 'custom-alias')
  assert.deepEqual(model.reasoning.efforts.map(effort => effort.id), runtime.CUSTOM_REASONING_LEVELS)
  await h.call('high')
  assert.equal(h.requests.at(-1).body.reasoning_effort, 'vendor-high')
  await h.call('max')
  assert.equal(h.requests.at(-1).body.reasoning_effort, 'max')
  h.refuse()
  assertRefused(await h.call('max'))
})

test('provider defaults, live edits and prepared calls retain their exact configuration', async t => {
  const h = await fixture(t); if (!h) return
  const prepared = await h.ctx.llm.prepareCall(h.config('high'))
  const defaultPrepared = await h.ctx.llm.prepareCall(h.config())
  h.update({ 'private-gateway': { ...h.profile, reasoning: 'low',
    models: [{ id: 'custom-alias', reasoningEfforts: false }] } })
  await h.consume(prepared)
  assert.equal(h.requests.at(-1).body.reasoning_effort, 'high')
  await h.consume(defaultPrepared)
  assert.equal(h.requests.at(-1).body.reasoning_effort, 'high')
  await h.call(undefined)
  assert.equal(h.requests.at(-1).body.reasoning_effort, 'low')
  h.update({ 'private-gateway': { ...h.profile, reasoning: 'medium',
    models: [{ id: 'custom-alias', reasoningEfforts: { medium: 'medium', xhigh: 'xhigh' } }] } })
  const narrowed = await h.ctx.llm.resolveModelInfo('private-gateway', 'custom-alias')
  assert.deepEqual(narrowed.reasoning.efforts.map(effort => effort.id), runtime.CUSTOM_REASONING_LEVELS)
  assert.equal(narrowed.reasoning.defaultEffort, 'medium')
  await h.call(undefined)
  assert.equal(h.requests.at(-1).body.reasoning_effort, 'medium')
  h.update({})
  assert.deepEqual(h.ctx.llm.listProviders(), [])
  h.update({ 'second-gateway': { ...h.profile, models: [{ id: 'new-model' }] } })
  const model = await h.ctx.llm.resolveModelInfo('second-gateway', 'new-model')
  assert.deepEqual(model.reasoning.efforts.map(effort => effort.id), runtime.CUSTOM_REASONING_LEVELS)
})

test('built-in providers keep upstream capabilities and reject unsupported efforts', async t => {
  const h = await fixture(t); if (!h) return
  h.update({ openai: { ...h.profile, models: [{ id: 'gpt-4o', reasoningEfforts: false }] } })
  const model = await h.ctx.llm.resolveModelInfo('openai', 'gpt-4o')
  assert.equal(model.reasoning, undefined)
  await assert.rejects(h.ctx.llm.prepareCall({ provider: 'openai', model: 'gpt-4o', reasoningEffort: 'high' }), /reasoning/i)
  assert.equal(h.requests.length, 0)
})

const replay = () => [
  runtime.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }),
  runtime.llm.createAssistantMessage({ source: { provider: 'private-gateway', model: 'custom-alias' },
    content: [{ type: 'text', text: 'hello' }] }),
  runtime.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'again' }] }),
]

test('DeepSeek models behind a gateway replay reasoning_content on assistant turns', async t => {
  const h = await fixture(t, { models: [{ id: 'deepseek-v4.1-flash' }] }); if (!h) return
  const prepared = await h.ctx.llm.prepareCall({ provider: 'private-gateway', model: 'deepseek-v4.1-flash' })
  for await (const _ of prepared.stream({ ...prepared.config, messages: replay() })) { /* drain */ }
  const assistant = h.requests.at(-1).body.messages.find(message => message.role === 'assistant')
  assert.equal(assistant?.reasoning_content, '',
    'a gateway cannot be detected from its base URL, so the model id must enable the field')
})

test('a non-DeepSeek gateway alias keeps the transcript free of reasoning_content', async t => {
  const h = await fixture(t); if (!h) return
  const prepared = await h.ctx.llm.prepareCall(h.config('high'))
  for await (const _ of prepared.stream({ ...prepared.config, messages: replay() })) { /* drain */ }
  const assistant = h.requests.at(-1).body.messages.find(message => message.role === 'assistant')
  assert.equal(assistant?.reasoning_content, undefined,
    'other OpenAI-compatible endpoints must not receive an unknown field')
})

test('DeepSeek model and provider compatibility opt-outs survive automatic detection', async t => {
  for (const declaration of [
    { models: [{ id: 'deepseek-v4.1-flash', compat: { requiresReasoningContentOnAssistantMessages: false } }] },
    { compat: { requiresReasoningContentOnAssistantMessages: false }, models: [{ id: 'deepseek-v4.1-flash' }] },
  ]) {
    const h = await fixture(t, declaration); if (!h) return
    const prepared = await h.ctx.llm.prepareCall({ provider: 'private-gateway', model: 'deepseek-v4.1-flash' })
    await h.consume(prepared, replay())
    assert.equal(h.requests.at(-1).body.messages.find(message => message.role === 'assistant').reasoning_content, undefined)
  }
})

test('gateway reasoning_details survive durable replay through a tool result', async t => {
  // Use an alias: the actual response model identifies DeepSeek on later calls.
  const h = await fixture(t); if (!h) return
  const details = [{ type: 'reasoning.text', text: 'inspect the file first', format: 'unknown', index: 0 }]
  h.respond((body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ id: 'tool-round', model: 'deepseek/deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { role: 'assistant', reasoning_details: details,
        tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"sample.txt"}' } }] }, finish_reason: null }] }) + '\n\n')
    res.end('data: ' + JSON.stringify({ id: 'tool-round', model: 'deepseek/deepseek-v4.1-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n')
  })
  const user = runtime.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect' }] })
  const first = await h.ctx.llm.prepareCall(h.config('high'))
  const assembler = new runtime.llm.BlockAssembler()
  for (const chunk of await h.consume(first, [user])) assembler.push(chunk)
  assert.equal(assembler.finish.kind, 'tool-calls')
  const assistant = runtime.llm.createAssistantMessage({ content: assembler.blocks(),
    source: { provider: 'private-gateway', model: 'custom-alias', replayState: assembler.replayState } })
  // The actual session format is JSON, so exercise a persistence round trip.
  const restored = runtime.llm.freezeMessage(JSON.parse(JSON.stringify(assistant)))
  const messages = [user, restored, runtime.llm.createToolResultMessage({ callId: 'read-1', isError: false,
    content: [{ type: 'text', text: 'file contents' }] })]
  const before = JSON.stringify(messages)
  h.respond(undefined)
  const second = await h.ctx.llm.prepareCall(h.config('high'))
  const chunks = await h.consume(second, messages)
  assert.equal(chunks.find(chunk => chunk.type === 'finish').reason.kind, 'stop')
  const wire = h.requests.at(-1).body.messages
  const replayed = wire.find(message => message.role === 'assistant')
  assert.equal(replayed.reasoning_content, 'inspect the file first')
  assert.deepEqual(replayed.reasoning_details, details)
  assert.equal(replayed.tool_calls[0].id, 'read-1')
  assert.equal(wire.find(message => message.role === 'tool').tool_call_id, 'read-1')
  assert.equal(JSON.stringify(messages), before, 'wire adaptation must not mutate the session log')
})

test('aliases and models sharing a gateway use one HTTP budget, including a failed call', async t => {
  const h = await fixture(t, {}, { requestGate: new LlmRequestGate({ maxRequests: 2, windowMs: 80, marginMs: 0 }) }); if (!h) return
  h.update({ 'private-gateway': h.profile, 'another-alias': { ...h.profile, api: 'anthropic-messages',
    baseURL: h.profile.baseURL.replace(/\/v1$/, ''), models: [{ id: 'another-model' }] } })
  h.refuse()
  const configs = [h.config('high'), { provider: 'another-alias', model: 'another-model' }, h.config('low')]
  const calls = await Promise.all(configs.map(config => h.ctx.llm.prepareCall(config)))
  await Promise.all(calls.map(call => h.consume(call)))
  assert.equal(h.requests.length, 3)
  assert.ok(h.requests[1].time - h.requests[0].time >= 35)
  assert.ok(h.requests[2].time - h.requests[0].time >= 75)
})

test('a gateway 429 cools down other calls and remains cancellable', async t => {
  const h = await fixture(t); if (!h) return
  h.respond((body, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.12' })
    res.end(JSON.stringify({ error: { message: 'one minute request limit reached', type: 'new_api_error' } }))
  })
  const first = await h.call('high')
  assert.equal(first.find(chunk => chunk.type === 'finish').reason.failure.code, 'RATE_LIMIT')
  h.respond(undefined)
  h.update({ 'private-gateway': { ...h.profile, reasoning: 'low' } })
  const controller = new AbortController()
  const cancelled = h.consume(await h.ctx.llm.prepareCall(h.config('high')), undefined, controller.signal)
  controller.abort()
  const cancelledChunks = await cancelled
  assert.equal(cancelledChunks.find(chunk => chunk.type === 'finish').reason.kind, 'aborted')
  assert.equal(h.requests.length, 1, 'cancellation during cooldown must not send HTTP')
  const retry = await h.call('high')
  assert.equal(retry.find(chunk => chunk.type === 'finish').reason.kind, 'stop')
  assert.equal(h.requests.length, 2)
  assert.ok(h.requests[1].time - h.requests[0].time >= 110, 'Retry-After outlasts the local test window')
})

test('local admission waits do not consume stream idle time or mutate shared profile snapshots', async t => {
  const h = await fixture(t, { streamIdleTimeoutMs: 120 }, {
    requestGate: new LlmRequestGate({ maxRequests: 2, windowMs: 800, marginMs: 0 }),
  }); if (!h) return
  const adapter = h.ctx.llm.registration('private-gateway').adapter
  const snapshot = adapter.current()
  for (const effort of ['high', 'low']) {
    const chunks = await h.call(effort)
    assert.equal(chunks.find(chunk => chunk.type === 'finish').reason.kind, 'stop')
  }
  assert.ok(h.requests[1].time - h.requests[0].time >= 350)
  assert.equal(snapshot.profiles.get('private-gateway').streamIdleTimeoutMs, 120)
  assert.equal(adapter.current(), snapshot)
})

test('a real provider stream stall still finishes as TIMEOUT rather than caller cancellation', async t => {
  const h = await fixture(t, { streamIdleTimeoutMs: 120 }); if (!h) return
  h.respond((body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders() })
  const chunks = await h.call('high')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TIMEOUT')
  assert.equal(h.requests.length, 1)
})
