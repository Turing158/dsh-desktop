import { t } from '../i18n/api.mjs'
import { selectionText } from './selection.mjs'

/** Ask xterm's own copy handler for its buffer selection, not DOM text or the
 * helper textarea (which is populated only after xterm handles a right-click).
 * This non-bubbling event writes into memory, never the system clipboard. */
export function readTerminalSelection(terminal) {
  let selected = false, text = ''
  const event = new terminal.ownerDocument.defaultView.Event('copy', { cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: {
    setData(type, value) { if (type === 'text/plain') { selected = true; text = value } },
  } })
  terminal.dispatchEvent(event)
  return { selected, text: selectionText(text) }
}

/** Bridge the built-in terminal's DOM events without depending on React refs,
 * private xterm fields, or a particular sidebar occurrence. Both seats render
 * the same data-sidebar-terminal root. Window capture runs before the document
 * text menu and before xterm moves its helper textarea underneath the pointer. */
export function installUpstreamTerminalInteractions(document = globalThis.document, onError = console.error) {
  const window = document.defaultView
  let context = null, edit = null
  const terminalFor = target => {
    const terminal = target?.closest?.('[data-sidebar-terminal] .xterm')
    return terminal && !terminal.closest('[hidden]') ? terminal : null
  }
  const alive = terminal => terminal.isConnected && !terminal.closest('[hidden]') && terminal.getClientRects().length > 0
  const focus = terminal => { if (alive(terminal)) terminal.querySelector('.xterm-helper-textarea')?.focus({ preventScroll: true }) }
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
  const copy = async (terminal, selection = readTerminalSelection(terminal)) => {
    if (selection.selected) await invoke('clipboard_write_text', { text: selection.text })
  }
  const paste = async terminal => {
    const text = await invoke('clipboard_read_text')
    if (typeof text !== 'string' || !text) return
    // The shell/tab may have closed while the asynchronous clipboard read ran.
    if (!alive(terminal)) return
    const textarea = terminal.querySelector('.xterm-helper-textarea')
    if (!textarea) return
    focus(terminal)
    const event = new window.Event('paste', { cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: type => type === 'text/plain' ? text : '' } })
    // xterm retains bracketed paste, newline conversion and disableStdin checks.
    textarea.dispatchEvent(event)
  }
  const remember = terminal => {
    edit = { element: terminal, copy: () => copy(terminal), paste: () => paste(terminal), hasSelection: () => readTerminalSelection(terminal).selected }
    window.__DSH_TERMINAL_EDIT__ = edit
  }
  const forget = () => {
    if (window.__DSH_TERMINAL_EDIT__ === edit) delete window.__DSH_TERMINAL_EDIT__
    edit = null
  }
  const dismiss = (refocus = false) => {
    if (!context) return
    const previous = context
    context = null
    if (previous.shared) { previous.dismiss(refocus); return }
    previous.observer.disconnect()
    previous.menu.remove()
    if (refocus) focus(previous.terminal)
  }
  function open(terminal, point, keyboard = false) {
    dismiss()
    remember(terminal)
    const selection = readTerminalSelection(terminal)
    const shared = window.__DSH_TEXT_MENU__?.({ clientX: point.x, clientY: point.y }, [
      { label: t('复制'), key: 'C', enabled: selection.selected, run: () => copy(terminal, selection) },
      { label: t('粘贴'), key: 'V', enabled: true, run: () => paste(terminal) },
    ], {
      scope: terminal, keyboard, restore: () => focus(terminal), onError,
      onDismiss: () => { context = null },
    })
    if (shared) {
      context = { ...shared, terminal, shared: true }
      remember(terminal)
      return
    }
    const menu = document.createElement('div')
    menu.className = 'dshTerminal__context'
    menu.setAttribute('data-dsh-upstream-terminal-menu', '')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', t('终端操作'))
    for (const item of [
      { label: t('复制'), enabled: selection.selected, run: () => copy(terminal, selection) },
      { label: t('粘贴'), enabled: true, run: () => paste(terminal) },
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.disabled = !item.enabled
      button.addEventListener('click', () => {
        dismiss(true)
        Promise.resolve().then(() => { if (alive(terminal)) return item.run() }).catch(onError)
      })
      menu.append(button)
    }
    // Upstream keeps its input control when focus leaves, so a body portal is
    // safe and escapes both the dock and the right pane's clipping boundaries.
    document.body.append(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = Math.max(4, Math.min(point.x, window.innerWidth - rect.width - 4)) + 'px'
    menu.style.top = Math.max(4, Math.min(point.y, window.innerHeight - rect.height - 4)) + 'px'
    const observer = new window.MutationObserver(() => { if (!alive(terminal)) dismiss() })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    context = { menu, terminal, observer }
    if (keyboard) menu.querySelector('button:not(:disabled)')?.focus()
  }
  function contextmenu(event) {
    const terminal = terminalFor(event.target)
    if (!terminal) return
    event.preventDefault()
    event.stopImmediatePropagation()
    open(terminal, { x: event.clientX, y: event.clientY })
  }
  function keydown(event) {
    // The shared menu owns dismissal and keyboard navigation, including the
    // first arrow press when mouse opening left every command unfocused.
    if (context?.shared) return
    if (context && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); dismiss(true); return
    }
    if (context?.menu.contains(event.target)) {
      if (event.key === 'Tab') { dismiss(true); return }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = [...context.menu.querySelectorAll('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        event.preventDefault(); event.stopImmediatePropagation(); buttons[next]?.focus()
      }
      return
    }
    const terminal = terminalFor(event.target)
    if (!terminal || event.isComposing || event.altKey || event.metaKey) return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); event.stopImmediatePropagation()
      const rect = terminal.getBoundingClientRect()
      open(terminal, { x: rect.left + 8, y: rect.top + 8 }, true)
      return
    }
    if (!event.ctrlKey) return
    if (event.code === 'KeyC') {
      const selection = readTerminalSelection(terminal)
      if (!selection.selected && !event.shiftKey) return // Plain Ctrl+C still interrupts.
      event.preventDefault(); event.stopImmediatePropagation()
      copy(terminal, selection).catch(onError)
    } else if (event.code === 'KeyV') {
      event.preventDefault(); event.stopImmediatePropagation()
      paste(terminal).catch(onError)
    }
  }
  function pointerdown(event) {
    if (context?.menu.contains(event.target)) return
    dismiss()
    const terminal = terminalFor(event.target)
    if (terminal) remember(terminal)
    else if (!event.target.closest?.('.dshTb')) forget()
  }
  function focusin(event) {
    const terminal = terminalFor(event.target)
    if (terminal) remember(terminal)
    else if (!context?.menu.contains(event.target) && !event.target.closest?.('.dshTb')) forget()
  }
  const close = () => dismiss()
  const listeners = { contextmenu, keydown, pointerdown, focusin, resize: close }
  for (const [type, handler] of Object.entries(listeners)) window.addEventListener(type, handler, true)
  document.addEventListener('dsh-desktop:ui-mode', close)
  return () => {
    dismiss(); forget()
    for (const [type, handler] of Object.entries(listeners)) window.removeEventListener(type, handler, true)
    document.removeEventListener('dsh-desktop:ui-mode', close)
  }
}
