import { createHash } from 'node:crypto'

const WINDOW_MS = 60_000
export const MAX_TIMER_MS = 2_147_483_647
export const CONTROLLED_HTTP_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

/** Only raw reasoning text can satisfy DeepSeek's replay requirement. Keep
 * structured/encrypted metadata intact for gateways that also consume it.
 */
export function repairDeepSeekPayload(payload, model, context) {
  if (model.api !== 'openai-completions' || !Array.isArray(payload?.messages)) return payload
  const declared = model.compat?.requiresReasoningContentOnAssistantMessages
  if (declared === false) return payload
  const detected = /deepseek/i.test(`${model.id} ${model.baseUrl ?? ''}`)
    || context.messages.some(message => message.role === 'assistant'
      && message.api === model.api && message.provider === model.provider && message.model === model.id
      && /deepseek/i.test(message.responseModel ?? ''))
  if (declared !== true && !detected) return payload
  return { ...payload, messages: payload.messages.map(message => {
    if (message.role !== 'assistant' || (typeof message.reasoning_content === 'string' && message.reasoning_content.length)) return message
    const raw = Array.isArray(message.reasoning_details)
      ? message.reasoning_details.filter(detail => detail?.type === 'reasoning.text' && typeof detail.text === 'string')
        .map(detail => detail.text).join('') : ''
    const text = raw || (typeof message.reasoning === 'string' ? message.reasoning : '')
      || (typeof message.reasoning_text === 'string' ? message.reasoning_text : '')
    return { ...message, reasoning_content: text }
  }) }
}

/** Scope aliases and model choices by the actual HTTP origin and credential.
 * Never retain or log the credential itself in the scheduler.
 */
export function requestScope(input, init, apiKey) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (['localhost', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1'
  const headers = new Headers(init?.headers ?? input?.headers)
  const authorization = headers.get('authorization')
  const credential = authorization !== null ? authorization.replace(/^Bearer\s+/i, '')
    : headers.get('x-api-key') ?? headers.get('api-key') ?? apiKey ?? ''
  return createHash('sha256').update(url.origin).update('\0').update(credential).digest('hex')
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const delay = Number(value) * 1000
    return Number.isFinite(delay) && delay >= 0 ? delay : 0
  }
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

/** The upstream watchdog cannot pause its timer. This request-local timer
 * measures iterator waits, excluding our HTTP queue and consumer processing.
 */
export class LlmIdleWatchdog {
  constructor(signal, timeoutMs) {
    this.controller = new AbortController()
    this.signal = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])])
    this.timeoutMs = timeoutMs
    this.paused = 0
    this.waiting = false
    this.timedOut = false
  }
  clear() { clearTimeout(this.timer); this.timer = undefined }
  arm() {
    this.clear()
    if (!this.waiting || this.paused || this.signal.aborted) return
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error('LLM_STREAM_IDLE_TIMEOUT'))
    }, this.timeoutMs)
  }
  pause() { this.paused++; this.clear() }
  resume() { this.paused--; this.arm() }
  async next(iterator) {
    this.signal.throwIfAborted()
    let onAbort
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(this.signal.reason)
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
    this.waiting = true
    this.arm()
    try { return await Promise.race([iterator.next(), aborted]) }
    finally {
      this.waiting = false
      this.clear()
      this.signal.removeEventListener('abort', onAbort)
    }
  }
  dispose() { this.clear(); this.controller.abort(new Error('LLM stream consumer stopped')) }
}

export function streamWithDesktopControls(stream, model, context, options, gate, idle) {
  // Google/Vertex (and other native SDK routes) reject a custom fetch. Keep
  // those API contracts intact; this guard covers the supported HTTP routes.
  if (!CONTROLLED_HTTP_APIS.has(model.api)) return stream(model, context, options)
  return stream(model, context, {
    ...options,
    fetch: gate.wrapFetch(options.fetch ?? globalThis.fetch, options.apiKey, idle),
    onPayload: async (payload, target) => {
      const revised = await options.onPayload?.(payload, target)
      return repairDeepSeekPayload(revised === undefined ? payload : revised, target, context)
    },
  })
}

/** FIFO admission at the HTTP boundary: failed requests consume a slot,
 * cancelled waiters do not. Spacing avoids a burst at each minute boundary.
 */
export class LlmRequestGate {
  constructor({ maxRequests = 15, windowMs = WINDOW_MS, marginMs = 1000,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || !Number.isFinite(windowMs) || windowMs <= 0
      || !Number.isFinite(marginMs) || marginMs < 0) throw new Error('Invalid LLM request limit')
    this.maxRequests = maxRequests
    this.windowMs = windowMs
    this.marginMs = marginMs
    this.spacingMs = maxRequests ? Math.ceil((windowMs + marginMs) / maxRequests) : 0
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.scopes = new Map()
  }

  state(key) {
    let state = this.scopes.get(key)
    if (!state) {
      state = { starts: [], nextAt: 0, blockedUntil: 0, queue: [], timer: undefined }
      this.scopes.set(key, state)
    }
    return state
  }

  acquire(key, signal) {
    signal?.throwIfAborted()
    const state = this.state(key)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal }
      waiter.abort = () => {
        const index = state.queue.indexOf(waiter)
        if (index < 0) return
        state.queue.splice(index, 1)
        signal.removeEventListener('abort', waiter.abort)
        reject(signal.reason)
        this.pump(key, state)
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      state.queue.push(waiter)
      this.pump(key, state)
    })
  }

  pump(key, state) {
    if (state.timer !== undefined) this.clearTimer(state.timer)
    state.timer = undefined
    const now = this.now()
    state.starts = state.starts.filter(time => time > now - this.windowMs)
    if (!state.queue.length) {
      const until = Math.max(state.nextAt, state.blockedUntil, (state.starts.at(-1) ?? 0) + this.windowMs)
      if (until <= now) this.scopes.delete(key)
      else {
        state.timer = this.setTimer(() => this.pump(key, state), Math.min(until - now, MAX_TIMER_MS))
        state.timer?.unref?.()
      }
      return
    }
    const windowAt = this.maxRequests && state.starts.length >= this.maxRequests
      ? state.starts[0] + this.windowMs + this.marginMs : 0
    const due = Math.max(state.nextAt, state.blockedUntil, windowAt)
    if (due > now) {
      state.timer = this.setTimer(() => this.pump(key, state), Math.min(due - now, MAX_TIMER_MS))
      return
    }
    const waiter = state.queue.shift()
    waiter.signal?.removeEventListener('abort', waiter.abort)
    if (this.maxRequests) state.starts.push(now)
    state.nextAt = now + this.spacingMs
    waiter.resolve()
    this.pump(key, state)
  }

  cooldown(key, retryAfter) {
    const state = this.state(key)
    const delay = Math.max(this.windowMs + this.marginMs, retryAfterMs(retryAfter, this.now()))
    state.blockedUntil = Math.max(state.blockedUntil, this.now() + delay)
    this.pump(key, state)
    return delay
  }

  wrapFetch(fetch, apiKey, idle) {
    return async (input, init) => {
      const key = requestScope(input, init, apiKey)
      const signal = init?.signal ?? input?.signal
      idle?.pause()
      try { await this.acquire(key, signal) }
      finally { idle?.resume() }
      signal?.throwIfAborted()
      const response = await fetch(input, init)
      if (response.status === 429) this.cooldown(key, response.headers.get('retry-after'))
      return response
    }
  }
}

// The same process may replace an adapter when settings change. Its minute
// budget and a gateway cooldown must survive that replacement.
const gateSymbol = Symbol.for('dsh.desktop.llm.requestGate')
export function desktopRequestGate() {
  if (!globalThis[gateSymbol]) {
    const configured = process.env.DSH_DESKTOP_LLM_RPM
    const parsed = configured === undefined || configured.trim() === '' ? 15 : Number(configured)
    const maxRequests = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 15
    globalThis[gateSymbol] = new LlmRequestGate({ maxRequests })
  }
  return globalThis[gateSymbol]
}
