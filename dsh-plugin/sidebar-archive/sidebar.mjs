import { t } from '../i18n/api.mjs'
import { observeChrome } from '../observe-chrome.mjs'

const REGION = '[data-slot="sidebar.workspaces"]'
const ROW = '[role="treeitem"]:is([data-row-key^="session:"], [class*="_searchResultRow"])'
const ARCHIVE_FILTER_ITEMS = new Set(['archived-filter-separator', 'filter-by', 'hide-archived', 'show-archived', 'only-archived'])

// Ordinary rows publish their identity. Search rows currently expose it only in
// the owning component's props; validate that identity against the archive set.
export function rowSessionId(row) {
  const key = row.getAttribute('data-row-key')
  if (key?.startsWith('session:')) return key.slice(8)
  const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber$'))
  for (let fiber = fiberKey && row[fiberKey], depth = 0; fiber && depth < 16; fiber = fiber.return, depth++) {
    const id = fiber.memoizedProps?.result?.id
    if (typeof id === 'string') return id
  }
  return null
}

/** Keep the native fork action for active sessions, using the menu's own row id. */
export function mountArchiveSessionMenu(React, slots, workspaces) {
  const slot = 'sidebar.workspaces.session.menu.item'
  return slots.inject(slot, () => {
    let remove, registering = false
    const subscribe = listener => workspaces.subscribe(listener)
    const attach = () => {
      if (remove || registering) return
      const native = slots.entriesOfSlot(slot).find(entry => entry.options.id === 'fork')
      if (!native) return
      function ForkSessionItem(props) {
        const getArchived = React.useCallback(() => workspaces.getSnapshot().archivedSessionIds.includes(props.sessionId), [props.sessionId])
        const archived = React.useSyncExternalStore(subscribe, getArchived, getArchived)
        return archived ? null : React.createElement(native.component, props)
      }
      registering = true
      try {
        remove = slots.register({ name: slot, ...native.options, priority: -10,
          inject: native.inject, locale: native.locale, store: native.store,
        }, ForkSessionItem)
      } finally { registering = false }
    }
    const unsubscribe = slots.subscribe(slot, attach)
    attach()
    return () => { unsubscribe(); remove?.() }
  })
}

/** The native browser exposes no header-action slot. Keep its rows and store. */
export function mountArchiveSidebar(React, createRoot, Toggle, navigation, onOpen = () => {}) {
  let mount = null, root = null, actions = null, dead = false, queued = false
  const labels = new Map(), rows = new Map(), filterRows = new Map()
  const clearButton = () => { root?.unmount(); mount?.remove(); root = mount = actions = null }
  const update = () => {
    queued = false
    if (dead) return
    // The native view-options menu has no item slot. Its keyed rows let us
    // remove only archive filters, independently of locale or menu ordering.
    for (const element of filterRows.keys()) if (!element.isConnected) filterRows.delete(element)
    for (const element of document.querySelectorAll('[role="menu"][class*="_viewOptionsMenu"] [class*="_viewport"] > *')) {
      const fiberKey = Object.keys(element).find(key => key.startsWith('__reactFiber$'))
      if (!ARCHIVE_FILTER_ITEMS.has(element[fiberKey]?.key)) continue
      const button = element.querySelector('button')
      if (!filterRows.has(element)) filterRows.set(element, { button, disabled: button?.disabled })
      element.setAttribute('data-dsh-archive-filter-hidden', '')
      // Native arrow/Tab navigation selects enabled buttons, including hidden ones.
      if (button) button.disabled = true
    }
    const region = document.querySelector(REGION)
    const next = region?.querySelector('[class*="_sectionHeader"] [class*="_headerActions"]')
    if (!mount?.isConnected || actions !== next) {
      clearButton()
      if (next) {
        actions = next
        mount = document.createElement('span'); mount.className = 'dshArchive__toggleMount'; actions.append(mount)
        root = createRoot(mount); root.render(React.createElement(Toggle))
      }
    }
    const state = navigation.getSnapshot()
    const label = region?.querySelector('[class*="_sectionLabel"]')
    for (const element of labels.keys()) if (!element.isConnected) labels.delete(element)
    if (label) {
      if (label.textContent !== t('归档区')) labels.set(label, label.textContent)
      const text = state.only ? t('归档区') : labels.get(label)
      if (text && label.textContent !== text) label.textContent = text
    }
    for (const row of rows.keys()) if (!row.isConnected) rows.delete(row)
    for (const row of region?.querySelectorAll(ROW) || []) {
      const id = rowSessionId(row)
      if (!navigation.isArchived(id)) continue
      if (!rows.has(row)) rows.set(row, { description: row.getAttribute('aria-description'), tabIndex: row.getAttribute('tabindex') })
      row.setAttribute('aria-description', t('已归档，仅可查看历史内容'))
      row.tabIndex = 0
      row.toggleAttribute('data-dsh-archive-selected', state.active && state.sessionId === id)
      row.setAttribute('aria-selected', String(state.active && state.sessionId === id))
    }
  }
  const schedule = () => { if (!queued && !dead) { queued = true; queueMicrotask(update) } }
  const activate = event => {
    if (event.type === 'keydown' && (event.key !== 'Enter' && event.key !== ' ' || event.isComposing)) return
    const row = event.target.closest?.(ROW)
    if (!row?.closest(REGION) || event.target.closest('button, input, [role="menuitem"], [contenteditable="true"]')) return
    const id = rowSessionId(row)
    if (!navigation.isArchived(id)) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (event.type !== 'dblclick' && navigation.open(id)) onOpen()
  }
  const observer = observeChrome(REGION + ', [role="menu"][class*="_viewOptionsMenu"]', schedule,
    { characterData: true, attributes: true, attributeFilter: ['class', 'data-row-key'] })
  for (const type of ['click', 'keydown', 'dblclick']) document.addEventListener(type, activate, true)
  const off = navigation.subscribe(schedule)
  update()
  return () => {
    dead = true; observer.disconnect(); off(); clearButton()
    for (const [element, previous] of filterRows) {
      element.removeAttribute('data-dsh-archive-filter-hidden')
      if (previous.button) previous.button.disabled = previous.disabled
    }
    for (const type of ['click', 'keydown', 'dblclick']) document.removeEventListener(type, activate, true)
    for (const [label, text] of labels) if (label.isConnected && label.textContent === t('归档区')) label.textContent = text
    for (const [row, previous] of rows) {
      row.removeAttribute('data-dsh-archive-selected')
      for (const [name, value] of [['aria-description', previous.description], ['tabindex', previous.tabIndex]]) {
        if (value === null) row.removeAttribute(name); else row.setAttribute(name, value)
      }
    }
  }
}
