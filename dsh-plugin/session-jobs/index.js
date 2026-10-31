/**
 * Host half of the session-jobs plugin.
 *
 * The control reads `ctx.jobs` on the client, which the upstream job controller
 * already publishes and the desktop overlay keeps enabled. Nothing here runs on
 * the host: the row exists so the client module is discoverable from this
 * package root, exactly like the sidebar-archive row it mirrors.
 */
export const name = 'desktop-session-jobs'
export function apply() {}
