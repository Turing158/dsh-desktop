/** Native installation checks this independent feed immediately before stopping DSH. */
export function observeUpdateActivity(ctx, report = running => console.log('__DSH_UPDATE_ACTIVITY__ ' + JSON.stringify({ running }))) {
  let previous
  function publish() {
    let running = null
    try {
      const agents = ctx.agents.list()
      if (Array.isArray(agents) && agents.every(agent => ['idle', 'running'].includes(agent.status))) {
        // Include every agent: account providers, other windows and detached children.
        running = agents.some(agent => agent.status === 'running')
      }
    } catch { /* Unknown activity prevents installation. */ }
    if (running !== previous) { previous = running; report(running) }
  }
  const disposers = ['agent/status', 'agent/created', 'agent/disposed'].map(event => ctx.on(event, publish))
  publish()
  return () => { disposers.forEach(off => off()); report(null) }
}
