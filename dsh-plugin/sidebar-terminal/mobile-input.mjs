/** Mobile keyboards do not reliably emit keypress or legacy keyCode values.
 * Use native text edits for plain text and keep xterm's composition, paste and
 * hardware control-key handling. Writes use the existing web terminal model,
 * which owns permissions, connection state, input limits and ordering. */
export function installMobileTerminalInput(ctx, document = globalThis.document) {
  if (!document?.documentElement.hasAttribute('data-dsh-browser')) return () => {}
  const states = new WeakMap()
  const timers = new Set()
  const later = callback => {
    const timer = setTimeout(() => { timers.delete(timer); callback() }, 0)
    timers.add(timer)
  }
  function stateFor(element) {
    if (!element?.matches?.('[data-sidebar-terminal] .xterm-helper-textarea')) return
    if (element.closest('[hidden]')) return
    const target = ctx.sidebarRight.commandTarget(element)
    const marker = element.closest('[data-sidebar-right-occurrence]')
    const navigation = target?.occurrence?.navigation.getSnapshot()
    if (!marker || !navigation?.address) return
    const model = ctx.webTerminals.view(target.sessionId, target.tabId, navigation.address,
      navigation.params?.terminalId, navigation.params?.shellPath)
    let state = states.get(element)
    if (!state || state.model !== model) {
      state = { model, composing: false, ending: false }
      states.set(element, state)
      element.setAttribute('inputmode', 'text')
      element.setAttribute('enterkeyhint', 'enter')
      element.setAttribute('autocapitalize', 'off')
      element.setAttribute('autocorrect', 'off')
      element.setAttribute('autocomplete', 'off')
      element.spellcheck = false
    }
    return state
  }
  const writable = state => state.model.state.getSnapshot().writable
  const write = (state, text) => { if (text && writable(state)) state.model.write(text) }
  const clear = element => { element.value = '' }
  function handle(event) {
    const element = event.target
    const state = stateFor(element)
    if (!state) return
    if (event.type === 'compositionstart') {
      state.composing = true
      state.ending = false
      return // xterm renders the preedit and sends the final candidate itself.
    }
    if (event.type === 'compositionend') {
      state.composing = false
      state.ending = true
      // Browsers put the committed input before OR after compositionend. Keep
      // that whole event sequence with xterm to avoid duplicating the candidate.
      later(() => { state.ending = false })
      return
    }
    if (event.type === 'blur') {
      state.composing = false
      state.ending = false
      return
    }
    if (event.type === 'focusin') return
    if (state.composing || event.isComposing) {
      // Enter/Backspace here belong to the IME, not to the running command.
      if (event.type === 'keydown' || event.type === 'keypress' || event.type === 'input') event.stopImmediatePropagation()
      return
    }
    if (state.ending) {
      if (event.type === 'input') event.stopImmediatePropagation()
      return
    }
    if (event.type === 'keydown' || event.type === 'keypress') {
      const altGraph = event.getModifierState?.('AltGraph')
      if ((event.ctrlKey || event.altKey || event.metaKey) && !altGraph) return
      const command = { Enter: '\r', Backspace: '\x7f', Delete: '\x1b[3~' }[event.key]
      if (command) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.type === 'keydown') { write(state, command); clear(element) }
        return
      }
      if (event.keyCode === 229 || [...(event.key || '')].length === 1 || ['Unidentified', 'Process', 'Dead', 'AltGraph'].includes(event.key)) {
        // Leave the native edit enabled. The following beforeinput/input is
        // authoritative; xterm must not also send it from keypress or a timer.
        event.stopImmediatePropagation()
      }
      return
    }
    if (event.type !== 'beforeinput' && event.type !== 'input') return
    const type = event.inputType
    let text
    if (type === 'insertText' || type === 'insertReplacementText') text = event.data
    else if (type === 'insertLineBreak' || type === 'insertParagraph') text = '\r'
    else if (type === 'deleteContentBackward') text = '\x7f'
    else if (type === 'deleteContentForward') text = '\x1b[3~'
    else return // Composition and paste retain xterm's native handling.
    if (event.type === 'beforeinput' && !event.cancelable) return
    if (text == null && event.type === 'input') text = element.value
    if (text == null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    write(state, text)
    clear(element)
  }
  const events = ['focusin', 'blur', 'keydown', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend']
  events.forEach(type => document.addEventListener(type, handle, true))
  return () => {
    events.forEach(type => document.removeEventListener(type, handle, true))
    timers.forEach(clearTimeout)
    timers.clear()
  }
}
