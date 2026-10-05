/**
 * DeepseekHarness desktop notification bridge (host-side Cordis plugin).
 *
 * This plugin is injected into a `dsh web` process through a `--patch` overlay.
 * It is deliberately **import-free**: the overlay mounts it from the desktop
 * app's install directory, where bare specifiers such as `@deepseek-ai/cordis`
 * do not resolve. Everything it needs is available on the Cordis context handed
 * to `apply()`.
 *
 * Two events are reported, one line of JSON each on stdout, which the Rust host
 * parses and turns into a Windows toast:
 *
 *   `__DSH_NOTIFY__ {"kind":"question","title":…,"body":…,"sessionId":…}`
 *   `__DSH_NOTIFY__ {"kind":"task-end",…}`
 *
 * Reporting over stdout is deliberate: it is the only channel that observes
 * these events without touching the shipped web frontend.
 *
 * @module desktop-notify
 */

/** Stable Cordis plugin name. */
const name = 'desktop-notify'

/** No injected services: every event this plugin reads is dispatched on the root context. */
const inject = []

/** Stdout marker the Rust host scans for. Keep in sync with `dsh.rs`. */
const MARKER = '__DSH_NOTIFY__'

/** Defaults for optional config; taken by hand because this plugin stays dependency-free. */
const DEFAULTS = Object.freeze({
  notifyOnQuestion: true,
  notifyOnCompleted: true,
  notifyOnError: true,
  notifyOnAborted: false,
  maxBodyChars: 200,
})

const TITLE_QUESTION = 'DSH 需要你的选择'
const TITLE_PLAN_REVIEW = 'DSH 计划待确认'
const TITLE_COMPLETED = 'DSH 任务完成'
const TITLE_ERROR = 'DSH 任务出错'
const TITLE_QUOTA = 'DSH 额度不足，任务已中断'
const TITLE_ABORTED = 'DSH 任务已中止'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collapse whitespace and truncate, so a toast body stays one tidy paragraph. */
function condense(text, maxChars) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

/** Take the plugin's config by hand, so a malformed value degrades instead of throwing. */
function resolveConfig(raw) {
  const source = isRecord(raw) ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const maxBodyChars = Number(source.maxBodyChars)
  return {
    notifyOnQuestion: bool(source.notifyOnQuestion, DEFAULTS.notifyOnQuestion),
    notifyOnCompleted: bool(source.notifyOnCompleted, DEFAULTS.notifyOnCompleted),
    notifyOnError: bool(source.notifyOnError, DEFAULTS.notifyOnError),
    notifyOnAborted: bool(source.notifyOnAborted, DEFAULTS.notifyOnAborted),
    maxBodyChars:
      Number.isFinite(maxBodyChars) && maxBodyChars > 0 ? Math.floor(maxBodyChars) : DEFAULTS.maxBodyChars,
  }
}

/**
 * Write one notification line. Never throws: a notification must not be able to
 * disturb the agent run that produced it.
 */
function report(payload) {
  try {
    console.log(`${MARKER} ${JSON.stringify(payload)}`)
  } catch {
    /* A non-serializable payload is not worth failing the run over. */
  }
}

/**
 * Whether this agent is a top-level conversation the human is actually looking
 * at. Delegated subagents run unattended and share their parent's turn, so
 * notifying for them would double up and arrive after the real completion.
 */
function isRootAgent(ctx, agent) {
  if (agent === undefined || agent === null) return true
  try {
    const agents = ctx.get?.('agents')
    if (agents === undefined || agents === null || typeof agents.roots !== 'function') return true
    return agents.roots().includes(agent)
  } catch {
    return true
  }
}

/**
 * The newest assistant text, for the notification body.
 *
 * Scans backwards from the durable tail and returns the last non-empty
 * `assistant/message`. Only `text` blocks are read — `reasoning` blocks carry
 * the model's private thinking and must never reach a desktop notification.
 *
 * @returns the condensed text, or `''` when the session has none yet.
 */
function latestAssistantText(session, maxChars) {
  try {
    const seq = session?.seq
    if (typeof seq !== 'number') return ''
    for (let at = seq - 1; at >= 0; at -= 1) {
      const event = session.eventAt?.(at)
      if (event === undefined || event === null) continue
      if (event.type !== 'assistant/message') continue
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      let joined = ''
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') joined += block.text
      }
      if (joined.trim() !== '') return condense(joined, maxChars)
    }
  } catch {
    /* A malformed log is not a reason to skip the notification. */
  }
  return ''
}

/** Last path segment of the workspace, used as a short context suffix. */
function workspaceLabel(session) {
  try {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return ''
    const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
    return parts.length === 0 ? '' : parts[parts.length - 1]
  } catch {
    return ''
  }
}

/** The question's own short label, preferring the heading the caller supplied. */
function questionLabel(request) {
  try {
    const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
    if (first === undefined || first === null) return ''
    if (typeof first.header === 'string' && first.header.trim() !== '') return condense(first.header, 120)
    if (typeof first.question === 'string') return condense(first.question, 120)
  } catch {
    /* fall through to the generic body */
  }
  return ''
}

/** Whether a question request is a plan submitted for review rather than a plain question. */
function isPlanReview(request) {
  try {
    const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
    return first?.intent?.kind === 'plan-review'
  } catch {
    return false
  }
}

/** Read only public failure facts, never stringify a live Error or session content. */
function describeError(error, maxBodyChars) {
  let title = TITLE_ERROR
  let body = '任务因错误中断，请打开会话查看详情并重试。'
  try {
    // Current DSH exposes LlmError.failure; durable turn/end holds those facts
    // directly. Older versions may record a plain error string.
    const failure = isRecord(error?.failure) ? error.failure : error
    if (failure?.code === 'QUOTA' || failure?.code === 'ACCOUNT_QUOTA') {
      title = TITLE_QUOTA
      body = '额度或余额已耗尽，任务已中断。请补充额度或切换可用模型后重试。'
    } else {
      const message = typeof failure === 'string' ? failure : failure?.message
      if (typeof message === 'string' && message.trim() !== '') body = message
    }
  } catch {
    /* Malformed failure objects still deserve a generic notification. */
  }
  return { enabled: 'notifyOnError', title, body: condense(body, maxBodyChars) }
}

/** Title and body for a turn-end reason. */
function describeTurnEnd(reason, session, maxBodyChars) {
  const kind = isRecord(reason) ? reason.kind : undefined
  const sessionId = session?.id
  switch (kind) {
    case 'completed':
      return { enabled: 'notifyOnCompleted', title: TITLE_COMPLETED, body: latestAssistantText(session, maxBodyChars) }
    case 'error':
      return describeError(reason.error, maxBodyChars)
    case 'aborted':
      return { enabled: 'notifyOnAborted', title: TITLE_ABORTED, body: '' }
    default:
      // `blocked`, `max-tokens`, and `interrupted` are not finished work: stay quiet.
      return { enabled: undefined, title: '', body: '', sessionId }
  }
}

/**
 * Mount the notification bridge.
 *
 * @param ctx - the booted root context. It is unscoped, which is what admits
 *   this plugin to the agent-scoped events below.
 * @param rawConfig - optional row config from the patch overlay.
 */
function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // Per-agent bookkeeping: an `idle` transition only means "task finished" when
  // the agent actually ran and closed a turn. `idle` also follows cancellation
  // and `runMaintenance`, and neither of those should raise a toast.
  const running = new WeakSet()
  const pendingTurnEnd = new WeakMap()
  const reportedError = new WeakSet()

  function reportTurnEnd(agent, reason, session) {
    if (!isRootAgent(ctx, agent)) return
    const described = describeTurnEnd(reason, session, config.maxBodyChars)
    if (described.enabled === undefined || config[described.enabled] !== true) return
    const workspace = workspaceLabel(session)
    report({
      kind: 'task-end',
      reason: reason.kind,
      title: described.title,
      body: [described.body, workspace === '' ? '' : `· ${workspace}`].filter(Boolean).join(' '),
      sessionId: session?.id ?? '',
    })
  }

  function reportError(agent, reason, session) {
    if (reportedError.has(agent)) return
    reportedError.add(agent)
    // An earlier turn may have completed before the next one failed to open.
    pendingTurnEnd.delete(agent)
    reportTurnEnd(agent, reason, session)
  }

  /**
   * Observe the question waterfall without claiming it.
   *
   * `prepend: true` is load-bearing, not cosmetic. Cordis runs a waterfall
   * outermost-first (`cbs.shift()`), and the browser answerer registered by
   * `@deepseek-ai/dsh-api-remotes` forwards to the UI and resolves without
   * calling `next()`. A listener registered after it is therefore never
   * reached. Prepending puts this observer in front, and delegating with
   * `next()` hands the request straight back to the UI.
   */
  ctx.on(
    'user-questions/request',
    (request, next) => {
      try {
        if (config.notifyOnQuestion && isRootAgent(ctx, request?.agent)) {
          const label = questionLabel(request)
          report({
            kind: 'question',
            title: isPlanReview(request) ? TITLE_PLAN_REVIEW : TITLE_QUESTION,
            body: label,
            sessionId: request?.agent?.session?.id ?? '',
          })
        }
      } catch {
        /* Never let an observer failure break the question. */
      }
      // Delegation must be immediate and its result returned unchanged: the
      // human's answer travels back through this promise.
      return next()
    },
    { prepend: true },
  )

  // This is the terminal failure boundary, AFTER model-request retry/recovery.
  // It also covers errors that cannot append a durable turn/end. Report now:
  // cleanup may fail or stall before the driver's eventual idle transition.
  ctx.on('agent/error', ({ agent, error }) => {
    try {
      if (!isRecord(agent)) return
      reportError(agent, { kind: 'error', error }, agent.session)
    } catch {
      /* Observation only. */
    }
  })

  // Keep successful turn endings until the driver drains. A durable error is
  // also a fallback for runtimes that do not publish the live error event.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return
      const agent = ctx.get?.('agents')?.get?.(session?.id)
      if (agent === undefined || agent === null) return
      if (!running.has(agent) || reportedError.has(agent)) return
      if (event.data?.reason?.kind === 'error') {
        reportError(agent, event.data.reason, session)
        return
      }
      pendingTurnEnd.set(agent, { reason: event.data?.reason, session })
    } catch {
      /* Observation only. */
    }
  })

  // The whole-task boundary: the driver has fully drained.
  ctx.on('agent/status', ({ agent, status }) => {
    try {
      if (agent === undefined || agent === null) return
      if (status === 'running') {
        if (!running.has(agent)) {
          pendingTurnEnd.delete(agent)
          reportedError.delete(agent)
        }
        running.add(agent)
        return
      }
      if (status !== 'idle') return
      // A maintenance task or a cancelled agent can reach `idle` without ever
      // having run a turn; those are not completions.
      if (!running.delete(agent)) return
      const pending = pendingTurnEnd.get(agent)
      pendingTurnEnd.delete(agent)
      if (pending === undefined || reportedError.has(agent)) return
      reportTurnEnd(agent, pending.reason, pending.session)
    } catch {
      /* Observation only. */
    }
  })
}

export { apply, inject, name }
