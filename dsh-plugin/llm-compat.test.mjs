/** Exercise the installed DSH adapter and its HTTP serializers, without any
 * real credentials, user settings or external model calls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const bin = process.env.DSH_DESKTOP_DSH_BIN
  || (process.env.APPDATA && join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'))
let runtime
if (bin && existsSync(bin)) {
  process.env.DSH_DESKTOP_DSH_BIN = bin
  const { runtimeImport } = await import('./runtime-import.mjs')
  const { Context } = await runtimeImport('@deepseek-ai/cordis')
  const upstream = await runtimeImport('@deepseek-ai/dsh-llm-pi-ai')
  const desktop = await import('./llm-compat.mjs')
  runtime = { Context, upstream, ...desktop }
}

function assertRefused(chunks) {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /Unsupported reasoning effort/)
}

async function fixture(t, overrides = {}) {
  if (!runtime) { t.skip('Requires an installed DSH runtime'); return }
  const requests = []
  let refuse = false
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    requests.push({ url: req.url, body })
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
  new runtime.default(ctx)
  runtime.upstream.apply(ctx, { providers: { get: () => providers } })
  t.after(() => ctx.fiber.dispose())
  const config = effort => ({ provider: 'private-gateway', model: 'custom-alias',
    ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  const consume = async prepared => {
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })) chunks.push(chunk)
    return chunks
  }
  return { ctx, profile, requests, config, consume,
    refuse: () => { refuse = true },
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
