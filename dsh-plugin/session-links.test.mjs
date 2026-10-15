import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { linksForNode, openSessionLink } from './session-links/links.mjs'

const bin = process.env.DSH_DESKTOP_DSH_BIN || join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
if (existsSync(bin)) process.env.DSH_DESKTOP_DSH_BIN = bin
const plugin = await import('./session-links.mjs')
const entry = await import('./session-links/index.js')
const { parseSessionLink, sessionLinksInText } = plugin
const url = 'deepseekharness://session/source'

test('desktop short, legacy, encoded and host-less URLs identify the same session', () => {
  for (const input of [url, url + '/', '  ' + url + '  ', 'deepseekharness://session/session-source',
    'DEEPSEEKHARNESS://SESSION/source', 'deepseekharness:session/source', 'deepseekharness://session/%73ource']) {
    assert.equal(parseSessionLink(input), 'session-source', input)
  }
  assert.equal(parseSessionLink('deepseekharness://session/user-session-123'), 'session-user-session-123')
  assert.equal(parseSessionLink('deepseekharness://session/' + 'a'.repeat(120)), 'session-' + 'a'.repeat(120))
})

test('invalid URLs cannot partially resolve a different session', () => {
  for (const input of [null, '', 'https://session/source', 'deepseekharness://project/source',
    'deepseekharness://user@session/source', 'deepseekharness://session:80/source', url + '?x=1',
    url + '#fragment', url + '/extra', url + '//', 'deepseekharness://session/',
    'deepseekharness://session/session-', 'deepseekharness://session/../source',
    'deepseekharness://session/%2e%2e', 'deepseekharness://session/%2fsource',
    'deepseekharness://session/%5csource', 'deepseekharness://session/%252fsource',
    'deepseekharness://session/%GG', 'deepseekharness://session/%FF',
    'deepseekharness://session/' + 'a'.repeat(121)]) {
    assert.equal(parseSessionLink(input), null, String(input))
    if (typeof input === 'string') assert.deepEqual(sessionLinksInText(input), [], input)
  }
})

test('find links in Chinese prose, Markdown and code without altering the input', () => {
  for (const text of [`读取“${url}”，然后总结。`, `[对应会话](${url})`, `<${url}>`, '`' + url + '`', url + ', thanks']) {
    assert.deepEqual(sessionLinksInText(text), [{ sessionId: 'session-source', label: url }])
  }
  assert.deepEqual(sessionLinksInText('deepseekharness://session/***'), [])
})

test('navigation controls use visible message text and deduplicate the short and legacy links', async () => {
  const content = [{ type: 'text', text: url + ' deepseekharness://session/session-source' },
    { type: 'reasoning', text: 'deepseekharness://session/hidden' },
    { type: 'tool-call', text: 'deepseekharness://session/tool' }]
  const expected = [{ sessionId: 'session-source', label: url }]
  assert.deepEqual(linksForNode({ kind: 'user', data: { content } }), expected)
  assert.deepEqual(linksForNode({ kind: 'assistant-step', data: { blocks: content } }), expected)
  assert.deepEqual(linksForNode(null), [])
  const opened = []
  const ctx = { sessions: { list: { getSnapshot: () => ({ byId: { 'session-source': {} } }) } },
    uiWorkspace: { openSession: async id => opened.push(id) } }
  await openSessionLink(ctx, url)
  await assert.rejects(openSessionLink(ctx, url + '?invalid'), /invalid-session-link/)
  await assert.rejects(openSessionLink(ctx, 'deepseekharness://session/missing'), /deep-link-session-missing/)
  assert.deepEqual(opened, ['session-source'])
})

test('message wrappers settle on the real keyed slot registry and follow renderer replacement/disposal', async t => {
  if (!existsSync(bin)) return t.skip('DSH runtime unavailable')
  const require = createRequire(bin)
  const { SlotCore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-ui-slots')).href)
  const core = new SlotCore(), slot = 'conversation.chat.node'
  const removeRoot = core.register({ name: 'root', children: { [slot]: { kind: 'keyed', scope: 'session' } } }, () => null)
  const original = () => null, replacement = () => null
  const removeOriginal = core.register({ name: slot, key: 'user', locale: 'chat' }, original)
  let client, dispose, notifications = 0
  vm.runInNewContext(readFileSync(new URL('./session-links/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { client = module.factory(() => ({ createElement() {} })) } } },
  })
  client.apply({ slots: {
    entries: key => core.entries(key), entriesOfSlot: key => core.entriesOfSlot(key),
    register: (options, component) => core.register(options, component),
    inject: (_slot, setup) => { dispose = setup() },
    subscribe: (key, listener) => core.subscribe(key, () => { if (++notifications < 20) listener() }),
  } })
  t.after(() => { dispose(); removeOriginal(); removeRoot() })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  await tick()
  assert.ok(notifications < 20, 'wrapping must not churn indefinitely when it shadows the original')
  assert.equal(core.entries(slot).length, 2)
  const first = core.entriesOfSlot(slot)[0]
  assert.notEqual(first.component, original)
  assert.equal(first.locale, 'chat')
  await tick()
  assert.equal(core.entriesOfSlot(slot)[0], first, 'an idle registry keeps the same wrapper')
  const removeReplacement = core.register({ name: slot, key: 'user', priority: -5 }, replacement)
  await tick()
  assert.equal(core.entries(slot).length, 3)
  assert.equal(core.entriesOfSlot(slot)[0].options.priority, -6)
  removeReplacement()
  await tick()
  assert.equal(core.entries(slot).length, 2)
  removeOriginal()
  await tick()
  assert.equal(core.entries(slot).length, 0, 'disposing the renderer also removes its wrapper')
})

async function fixture(t, config = {}) {
  if (!existsSync(bin)) { t.skip('DSH runtime unavailable'); return }
  const require = createRequire(bin)
  const imp = name => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await imp('@deepseek-ai/cordis')
  const { default: Resolver, formatSessionReferenceMention } = await imp('@deepseek-ai/dsh-session-reference')
  const { createUserMessage } = await imp('@deepseek-ai/dsh-llm')
  const { agentEvents } = await imp('@deepseek-ai/dsh-agent')
  const ctx = new Context(), reads = []
  const surfaces = new Map()
  for (const id of ['source', 'two', 'three', 'four']) surfaces.set('session-' + id, {
    session: { id: 'session-' + id, version: 4, cwd: process.cwd() }, capturedThroughSeq: 3,
    events: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '问题 ' + id }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden reasoning' }, { type: 'text', text: '答案 ' + id }] } } },
      { type: 'user/message', data: { source: { kind: 'session-reference' }, content: [{ type: 'text', text: 'nested reference' }] } },
      { type: 'system/message', data: { content: [{ type: 'text', text: 'system secret' }] } },
    ],
  })
  ctx.provide('sessionQuery', { async readSurface(id) {
    reads.push(id)
    if (!surfaces.has(id)) throw Error('Session not found: ' + id)
    return structuredClone(surfaces.get(id))
  } })
  const resolver = ctx.plugin(Resolver, config)
  await resolver.await()
  const fork = ctx.plugin(entry)
  await fork.await()
  // The real entry mounts the reader lazily. Await its activation too so a
  // startup error cannot silently remove the hook before agents dispatch.
  await Promise.all([...ctx.registry.get(plugin).fibers].map(fiber => fiber.await()))
  t.after(async () => { await fork.dispose(); await resolver.dispose() })
  const agent = { id: 'session-target', session: { id: 'session-target' }, options: {} }
  const message = (text, source = { kind: 'user' }) => createUserMessage({ source, content: [{ type: 'text', text }] })
  const run = (messages, signal = new AbortController().signal) => agentEvents(ctx, agent).waterfall('agent/pre-step',
    { messages, signal, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages, startsRequestSeries: true }))
  return { ctx, fork, reads, surfaces, message, run, formatSessionReferenceMention }
}

test('real resolver admits readable context and preserves the clickable desktop URL and attachments', async t => {
  const f = await fixture(t); if (!f) return
  const original = f.message(`总结 [原会话](${url})`)
  const result = await f.run([original])
  assert.equal(result.startsRequestSeries, true)
  assert.deepEqual(result.messages[0], original)
  assert.equal(result.messages[1].source.kind, 'session-reference')
  assert.deepEqual(f.reads, ['session-source'])
  const context = result.messages[1].content[0].text
  assert.match(context, /问题 source/)
  assert.match(context, /答案 source/)
  assert.match(context, /untrusted, read-only/)
  assert.doesNotMatch(context, /hidden reasoning|nested reference|system secret/)
  const attachment = { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }
  const withImage = { ...original, content: [...original.content, attachment] }
  assert.deepEqual((await f.run([withImage])).messages[0].content[1], attachment)
  f.surfaces.get('session-source').events[0].data.content[0].text = 'later edit'
  assert.match(context, /问题 source/)
})

test('native mentions and desktop URLs share deduplication and the three-session limit', async t => {
  const f = await fixture(t); if (!f) return
  const native = f.formatSessionReferenceMention({ sessionId: 'session-source', label: '原生引用' })
  const result = await f.run([f.message(`${native} ${url} deepseekharness://session/session-source` )])
  assert.deepEqual(f.reads, ['session-source'])
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[1].source.references.length, 1)
  assert.match(result.messages[0].content[0].text, /@原生引用/)
  await assert.rejects(f.run([f.message(`${native} ${url} deepseekharness://session/two deepseekharness://session/three deepseekharness://session/four`)]),
    error => error.code === 'SESSION_REFERENCE_TOO_MANY')
})

test('missing/self references and cancellation fail instead of inventing context', async t => {
  const f = await fixture(t); if (!f) return
  await assert.rejects(f.run([f.message('deepseekharness://session/missing')]), error => error.code === 'SESSION_REFERENCE_READ_FAILED')
  await assert.rejects(f.run([f.message('deepseekharness://session/target')]), error => /self/i.test(error.message))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.run([f.message(url)], controller.signal))
  assert.deepEqual(f.reads, ['session-missing'])
})

test('ordinary text, invalid links, injected context and rejected admission never trigger reads', async t => {
  const f = await fixture(t); if (!f) return
  for (const original of [f.message('ordinary text'), f.message(url + '?invalid'), f.message(url, { kind: 'session-reference' })]) {
    assert.deepEqual((await f.run([original])).messages, [original])
  }
  const off = f.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
  assert.deepEqual(await f.run([f.message(url)]), { kind: 'reject' })
  off()
  assert.deepEqual(f.reads, [])
  await f.fork.dispose()
  const original = f.message(url)
  assert.deepEqual((await f.run([original])).messages, [original])
})

test('long references retain the upstream omission notice and full snapshot locator', async t => {
  const f = await fixture(t, { maxReferenceBytes: 512 }); if (!f) return
  const saved = []
  f.ctx.provide('spillStore', { async saveText(request) {
    saved.push(request)
    return { path: '/test/reference.txt', retrievalHint: 'Read /test/reference.txt' }
  } })
  f.surfaces.get('session-source').events[0].data.content[0].text = '很长的原会话。'.repeat(2000)
  const result = await f.run([f.message(url)])
  assert.equal(result.messages[1].source.references[0].truncated, true)
  assert.match(result.messages[1].content[0].text, /\/test\/reference.txt/)
  assert.equal(saved[0].owner.sessionId, 'session-target')
  assert.match(saved[0].content, /full projected snapshot/)
})

test('desktop overlay and every distribution include the reader', () => {
  const patch = readFileSync(new URL('./desktop-notify.patch.yml', import.meta.url), 'utf8')
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)))
  assert.match(patch, /id: desktop-session-links\s+name: \.\/session-links\/index.js/)
  assert.equal(config.bundle.resources['../dsh-plugin/session-links.mjs'], 'dsh-plugin/session-links.mjs')
})
