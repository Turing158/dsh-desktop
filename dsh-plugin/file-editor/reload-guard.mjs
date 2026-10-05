/** Guard the native refresh command and toolbar buttons before they remount the
 * renderer. Keep command registration/disposal owned by the upstream tab body. */
export function bindReloadGuard(occurrence, actions, preview, reload) {
  const original = actions.bindCommands
  const descriptor = Object.getOwnPropertyDescriptor(actions, 'bindCommands')
  const bindings = new Set()
  const wrap = commands => typeof commands.refresh === 'function'
    ? { ...commands, refresh: () => reload(commands.refresh) } : commands
  const initial = occurrence.commands, initialWrapped = wrap(initial)
  occurrence.commands = initialWrapped
  function bind(commands) {
    const wrapped = wrap(commands)
    const binding = { commands, wrapped, off: original.call(actions, wrapped) }
    bindings.add(binding)
    return () => { binding.off(); bindings.delete(binding) }
  }
  actions.bindCommands = bind
  let replaying = false
  const click = event => {
    const button = event.target.closest?.('[data-textpreview-tool="reload"], [data-textpreview-reload-now]')
    if (replaying || !button || !preview.contains(button)) return
    event.preventDefault(); event.stopImmediatePropagation()
    reload(() => {
      if (!button.isConnected) return
      replaying = true
      try { button.click() } finally { replaying = false }
    })
  }
  preview.addEventListener('click', click, true)
  return () => {
    preview.removeEventListener('click', click, true)
    if (actions.bindCommands === bind) {
      if (descriptor) Object.defineProperty(actions, 'bindCommands', descriptor)
      else delete actions.bindCommands
    }
    if (occurrence.commands === initialWrapped) occurrence.commands = initial
    for (const binding of bindings) {
      if (occurrence.commands !== binding.wrapped) continue
      binding.off()
      // The upstream effect retains our disposer; make it release the restored
      // registration when that effect later unmounts or binds a newer command.
      binding.off = original.call(actions, binding.commands)
    }
  }
}
