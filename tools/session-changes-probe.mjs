/** Loaded only by session-changes-smoke into an isolated DSH_HOME. No network model. */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runtimeImport } from '../dsh-plugin/runtime-import.mjs'
export const inject = ['agents', 'tools', 'llm', 'sessionPersistence', 'sessions', 'jobs']
export async function apply(ctx) {
  const root = process.env.DSH_SESSION_SMOKE_ROOT
  if (!root) throw Error('This probe requires an isolated smoke directory')
  const { LlmAdapter, createUserMessage } = await runtimeImport('@deepseek-ai/dsh-llm')
  const { setSandboxMode } = await runtimeImport('@deepseek-ai/dsh-sandbox-policy')
  const fsTools = await runtimeImport('@deepseek-ai/dsh-tool-fs'), jobTools = await runtimeImport('@deepseek-ai/dsh-tool-jobs')
  const pwshTools = await runtimeImport('@deepseek-ai/dsh-tool-pwsh')
  const setup = async (agentCtx, agent) => {
    await agentCtx.plugin(fsTools, {}).await()
    await agentCtx.plugin(jobTools, { completionDelivery: 'quiet' }).await()
    await agentCtx.plugin(pwshTools, {}).await()
  }
  let pending, busy = false
  const handles = new Map()
  class ScriptedAdapter extends LlmAdapter {
    async *stream() {
      const tool = pending?.shift()
      const block = tool ? { type: 'tool-call', id: randomUUID(), name: tool.name, arguments: JSON.stringify(tool.arguments) } : { type: 'text', text: 'Recorded.' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      if (tool) yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      else yield { type: 'text-delta', index: 0, text: block.text }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['changes-smoke'], new ScriptedAdapter())
  // This synthetic third-party tool launches a real local child process through
  // the real job registry; its write occurs after the tool has returned.
  ctx.tools.register({ name: 'changes_smoke_background', description: 'Isolated smoke fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { spawn } = await import('node:child_process')
      return ctx.jobs.start({ kind: 'bash', label: 'delayed smoke write', owner: exec.agent.id, run() {
        const child = spawn(process.execPath, ['-e', "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'background\\n'),350)", join(exec.agent.session.header.cwd, 'background.txt')], { windowsHide: true, stdio: 'ignore' })
        return { cancel: () => child.kill(), done: new Promise(resolve => child.on('exit', code => resolve({ status: code === 0 ? 'completed' : 'failed' }))) }
      } })
    } })
  const timer = setInterval(async () => {
    if (busy) return
    let request
    try { request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8')) }
    catch { return }
    busy = true; await unlink(join(root, 'request.json'))
    let response
    try {
      if (request.action === 'create') {
        if (request.cwd !== join(root, 'workspace')) throw Error('Smoke workspace mismatch')
        const handle = await ctx.agents.create({ sessionId: 'session-' + randomUUID(), meta: { cwd: request.cwd },
          ...(request.parentSessionId ? { parentAgent: handles.get(request.parentSessionId).agent } : {}),
          agentOptions: { provider: 'changes-smoke', model: 'scripted' }, setup })
        // Test only collection, using the public policy switch on this synthetic
        // session. Windows restricted-token ACL setup is a separate integration.
        setSandboxMode(handle.agent.session, 'danger-full-access')
        handles.set(handle.agent.id, handle); response = { sessionId: handle.agent.id }
      } else if (request.action === 'resume') {
        const handle = await ctx.agents.resume({ resumeSessionId: request.sessionId, agentOptions: { provider: 'changes-smoke', model: 'scripted' }, setup })
        handles.set(handle.agent.id, handle); response = { sessionId: handle.agent.id }
      } else if (request.action === 'close') {
        await handles.get(request.sessionId).dispose(); handles.delete(request.sessionId); response = { closed: true }
      } else {
        const agent = handles.get(request.sessionId).agent
        pending = Array.isArray(request.tool) ? request.tool : [request.tool]
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic round ' + request.round }] }))
        await agent.whenIdle()
        await ctx.sessions.flush(agent.session)
        const reader = await ctx.sessionPersistence.open(agent.id, 'read')
        let events
        try { events = (await reader.read()).events } finally { await reader.close() }
        response = { agentId: agent.id, sessionId: agent.session.id, headerId: agent.session.header.id,
          turns: events.filter(event => event.type === 'turn/start').length,
          tools: events.filter(event => event.type === 'tool/result').map(event => event.data),
          errors: events.filter(event => /error/.test(event.type)).map(event => ({ type: event.type, data: event.data })) }
      }
    } catch (error) { response = { error: error.stack } }
    await writeFile(join(root, 'response.tmp'), JSON.stringify(response)); await rename(join(root, 'response.tmp'), join(root, 'response.json'))
    busy = false
  }, 30)
  ctx.effect(() => () => clearInterval(timer))
}
