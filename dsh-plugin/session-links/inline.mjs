import { sessionLinkRanges } from './links.mjs'

/** Decorate native transcript text while retaining React's original text nodes.
 * Extra siblings are owned here, restored on updates and removed on disposal.
 */
export function mountInlineSessionLinks(root, links, open) {
  const document = root.ownerDocument
  const allowed = new Set(links.map(link => link.sessionId))
  const decorated = []
  const excluded = 'a,button,input,textarea,select,script,style,pre,[role="button"],[contenteditable="true"],[data-ref-chip]'

  function restore(records) {
    const changed = new Set(records.filter(record => record.type === 'characterData').map(record => record.target))
    for (const { node, text, prefix, siblings } of decorated.splice(0)) {
      for (const sibling of siblings) sibling.remove()
      // A native render may already have supplied new text or removed the row.
      if (root.contains(node) && !changed.has(node) && node.data === prefix) node.data = text
    }
  }

  function refresh(records = []) {
    restore(records)
    const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */)
    const pending = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.parentElement.closest(excluded)) continue
      const ranges = sessionLinkRanges(node.data).filter(link => allowed.has(link.sessionId))
      if (ranges.length) pending.push({ node, ranges })
    }
    for (const { node, ranges } of pending) {
      const text = node.data, prefix = text.slice(0, ranges[0].start), siblings = []
      let cursor = ranges[0].start
      for (const range of ranges) {
        if (range.start > cursor) siblings.push(document.createTextNode(text.slice(cursor, range.start)))
        const anchor = document.createElement('a')
        anchor.href = range.label
        anchor.textContent = range.label
        anchor.dataset.dshSessionLink = range.sessionId
        anchor.style.cssText = 'color:var(--dsw-alias-label-link, #4169c1);text-decoration:underline;cursor:pointer;overflow-wrap:anywhere'
        siblings.push(anchor)
        cursor = range.end
      }
      if (cursor < text.length) siblings.push(document.createTextNode(text.slice(cursor)))
      node.data = prefix
      node.after(...siblings)
      decorated.push({ node, text, prefix, siblings })
    }
    observer.takeRecords()
  }

  function onClick(event) {
    const anchor = event.target.closest?.('a[data-dsh-session-link]')
    if (!anchor || !root.contains(anchor)) return
    event.preventDefault()
    event.stopPropagation()
    open(anchor.getAttribute('href'))
  }

  const observer = new document.defaultView.MutationObserver(refresh)
  refresh()
  observer.observe(root, { childList: true, characterData: true, subtree: true })
  root.addEventListener('click', onClick)
  return () => {
    const records = observer.takeRecords()
    observer.disconnect()
    root.removeEventListener('click', onClick)
    restore(records)
  }
}
