// Body-level discovery is needed for portals and remounted shell regions. Once
// inside a transcript/preview, text and tool updates cannot change these controls.
const CONTENT = '[data-conversation-region="chat"], [data-chat-flow], [data-code-block-content], [data-textpreview-plain], [data-document-markdown], .xterm-screen'

export function observeChrome(selector, update, options = {}) {
  const known = new WeakSet()
  const remember = node => {
    if (node?.nodeType !== 1) return false
    if (node.matches(selector)) { known.add(node); return true }
    if (node.matches(CONTENT)) return false
    const found = node.querySelector(selector)
    if (found) known.add(found)
    return Boolean(found)
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement
      const region = target?.closest(selector)
      if (region) { known.add(region); return true }
      if (target && known.has(target)) return true
      if (target?.closest(CONTENT)) return false
      if (record.type === 'attributes') return remember(target)
      return [...record.addedNodes, ...record.removedNodes].some(remember)
    })) update(records)
  })
  document.querySelectorAll(selector).forEach(node => known.add(node))
  observer.observe(document.body, { childList: true, subtree: true, ...options })
  return observer
}
