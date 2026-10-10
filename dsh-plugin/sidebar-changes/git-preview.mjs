/** List statistics are a display preview only, never authorization to commit. */
export function gitListStatistics(data, sessionId, capabilities, source) {
  if (!data || !['working', 'staged'].includes(source) || data.source !== source
    || data.sessionId !== sessionId || data.workspaceRoot !== capabilities?.workspaceRoot
    || data.endpointId !== capabilities?.endpointId) return null
  const known = data.entries.filter(entry => entry.stats.added !== null && entry.stats.removed !== null)
  const statisticsComplete = known.length === data.entries.length
  return {
    added: known.length || statisticsComplete ? known.reduce((sum, entry) => sum + entry.stats.added, 0) : null,
    removed: known.length || statisticsComplete ? known.reduce((sum, entry) => sum + entry.stats.removed, 0) : null,
    statisticsComplete, listRevision: data.revision,
  }
}
