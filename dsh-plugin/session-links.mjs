import { runtimeImport } from './runtime-import.mjs'
import { sessionLinksInText } from './session-links/links.mjs'
export { parseSessionLink, sessionLinksInText } from './session-links/links.mjs'

export const name = 'desktop-session-link-reader'
export const inject = ['sessionReferenceResolver']

export async function apply(ctx) {
  const { freezeMessage } = await runtimeImport('@deepseek-ai/dsh-llm')
  const { parseSessionReferenceText } = await runtimeImport('@deepseek-ai/dsh-session-reference')

  // The upstream resolver prepends its listener. This ordinary listener runs
  // inside it, after admission gates accept the message. For messages containing
  // desktop links, prepare all references together so native mentions share the
  // same deduplication, limit, cancellation and snapshot budget.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages = []
    for (const message of decision.messages) {
      if (message.source.kind !== 'user'
        || !message.content.some(block => block.type === 'text' && sessionLinksInText(block.text).length)) {
        messages.push(message)
        continue
      }
      const references = []
      const content = message.content.map(block => {
        if (block.type !== 'text') return block
        const parsed = parseSessionReferenceText(block.text)
        references.push(...parsed.references, ...sessionLinksInText(parsed.text))
        // Keep the desktop URL in the admitted message so it can still be
        // copied or opened. Native mention normalization remains upstream's.
        return { ...block, text: parsed.text }
      })
      const prepared = await ctx.sessionReferenceResolver.prepare(agent, content, references, signal)
      messages.push(freezeMessage({ ...message, content: prepared.content }))
      if (prepared.additionalContext) messages.push(prepared.additionalContext)
    }
    return { ...decision, messages }
  })
}
