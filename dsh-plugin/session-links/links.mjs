/** The same local session identity used by src-tauri/src/deep_link.rs. */
export function parseSessionLink(input) {
  if (typeof input !== 'string') return null
  const match = /^deepseekharness:(?:\/\/)?session\/([^/?#]+?)\/?$/i.exec(input.trim())
  if (!match) return null
  let id
  try { id = decodeURIComponent(match[1]) } catch { return null }
  const suffix = id.replace(/^session-/, '')
  if (!suffix || suffix.length > 120 || !/^[A-Za-z0-9._~-]+$/.test(suffix) || /^\.{1,2}$/.test(suffix)) return null
  return 'session-' + suffix
}

/** Recognize complete links in plain text, Markdown links and quoted prose. */
export function sessionLinksInText(text) {
  return sessionLinkRanges(text).map(({ sessionId, label }) => ({ sessionId, label }))
}

export function sessionLinkRanges(text) {
  const references = []
  for (const match of text.matchAll(/\bdeepseekharness:[^\s<>"'`()\[\]{}，。！？；：、“”‘’（）【】,;!]+/gi)) {
    const link = match[0]
    const sessionId = parseSessionLink(link)
    if (sessionId) references.push({ sessionId, label: link, start: match.index, end: match.index + link.length })
  }
  return references
}

/** Only visible text gets navigation controls; tool arguments and reasoning do not. */
export function linksForNode(node) {
  const blocks = node?.kind === 'assistant-step' ? node.data?.blocks : node?.data?.content
  const found = new Map()
  for (const block of blocks || []) {
    if (block.type !== 'text' && block.kind !== 'text') continue
    for (const link of sessionLinksInText(block.text || '')) if (!found.has(link.sessionId)) found.set(link.sessionId, link)
  }
  return [...found.values()]
}

export async function openSessionLink(ctx, link) {
  const id = parseSessionLink(link)
  if (!id) throw Error('invalid-session-link')
  if (!ctx.sessions.list.getSnapshot().byId[id]) throw Error('deep-link-session-missing')
  await ctx.uiWorkspace.openSession(id)
}
