/**
 * Pure facts about the interruptible work a conversation can see.
 *
 * The roster arrives from `ctx.jobs` (the upstream job controller): one row per
 * background command — a `run_in_background` shell call, a command promoted to
 * the background on timeout, a terminal job, a subagent or a workflow. This
 * module owns only the reading of those rows, so the control's behaviour is
 * testable without React and without a live registry.
 *
 * @module @dsh-desktop/session-jobs/model
 */

/** Lifecycle states whose work can still be interrupted. */
export const CANCELLABLE_STATUSES = ['running', 'stopping']

/** Whether one roster row still represents work the user can stop. */
export function isCancellable(job) {
  return Boolean(job) && CANCELLABLE_STATUSES.includes(job.status)
}

/**
 * The rows worth listing: live work only. Settled jobs are history, and the
 * point of this control is what is still holding the conversation open.
 * @param rows - one session's roster rows, or a missing roster.
 * @returns the cancellable rows, order preserved.
 */
export function cancellableJobs(rows) {
  return Array.isArray(rows) ? rows.filter(isCancellable) : []
}

/**
 * Running rows first, then rows already stopping; each group oldest first, with
 * the registry id breaking ties so the order never depends on map iteration.
 * @param rows - cancellable rows.
 * @returns a new ordered array.
 */
export function orderCancellable(rows) {
  return [...rows].sort((left, right) => {
    const rank = job => (job.status === 'running' ? 0 : 1)
    return rank(left) - rank(right)
      || (left.startedAt - right.startedAt)
      || String(left.id).localeCompare(String(right.id))
  })
}

/**
 * Counts by state, for the trigger's badge and the panel's summary line.
 * @param rows - cancellable rows.
 * @returns running, stopping, and total counts.
 */
export function liveSummary(rows) {
  let running = 0, stopping = 0
  for (const job of rows) {
    if (job.status === 'running') running += 1
    else if (job.status === 'stopping') stopping += 1
  }
  return { running, stopping, total: running + stopping }
}

/**
 * Elapsed time with zero-valued units omitted, retaining 0 seconds at startup.
 * @param elapsedMs - elapsed milliseconds, negative values clamped to zero.
 * @param t - namespace translator.
 * @returns localized duration text.
 */
export function formatDuration(elapsedMs, t) {
  const total = Math.max(0, Math.floor(elapsedMs / 1e3))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const parts = []
  if (hours > 0) parts.push(t('{hours}小时', { hours }))
  if (minutes > 0) parts.push(t('{minutes}分钟', { minutes }))
  if (seconds > 0 || parts.length === 0) parts.push(t('{seconds}秒', { seconds }))
  return parts.join('')
}

/** Trigger accessible name: the plain title, plus the live count when work is running. */
export function triggerLabel(total, t) {
  return total > 0 ? `${t('后台任务')} · ${t('{n} 个运行中', { n: total })}` : t('后台任务')
}

/** Badge text, capped so a long roster cannot widen the control. */
export function badgeText(total) {
  return total > 9 ? '9+' : String(total)
}

/** Panel summary line for the rows currently listed. */
export function summaryText(counts, t) {
  if (!counts.total) return t('空闲')
  return counts.stopping > 0 && counts.running === 0
    ? t('{n} 个正在停止', { n: counts.stopping })
    : t('{n} 个运行中', { n: counts.running || counts.stopping })
}
