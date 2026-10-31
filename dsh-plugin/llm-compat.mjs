/** Offer the existing effort picker for custom pi-ai routes, without probing
 * their capabilities. Keep model selection, persistence and errors upstream.
 */
import { runtimeImport } from './runtime-import.mjs'
import { CONTROLLED_HTTP_APIS, MAX_TIMER_MS, LlmIdleWatchdog, desktopRequestGate,
  streamWithDesktopControls } from './llm-request-control.mjs'

const { LlmRuntime, LlmError } = await runtimeImport('@deepseek-ai/dsh-llm')
const { PiAiAdapter } = await runtimeImport('@deepseek-ai/dsh-llm-pi-ai')

export const CUSTOM_REASONING_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'xhigh', 'max'])

function customModel(model) {
  const thinkingLevelMap = Object.fromEntries(CUSTOM_REASONING_LEVELS.map(level => [
    level, model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level),
  ]))
  // pi-ai offers omitted base levels implicitly; keep Minimal excluded while
  // exposing all six supported desktop choices to the menu and call validation.
  thinkingLevelMap.minimal = null
  const compat = { ...model.compat }
  if (model.api === 'openai-completions') {
    compat.supportsReasoningEffort = true
    // Recognize gateways by model id, but preserve an explicit opt-out.
    // The wire hook below also restores raw text from reasoning_details.
    const base = model.baseUrl ?? model.baseURL ?? ''
    if (/deepseek/i.test(`${model.id} ${base}`)) compat.requiresReasoningContentOnAssistantMessages ??= true
  }
  if (model.api === 'anthropic-messages') {
    // Custom model aliases cannot identify Claude's adaptive-thinking family.
    // Send the chosen effort directly; let the endpoint accept or reject it.
    compat.forceAdaptiveThinking ??= true
  }
  if (!model.reasoning && (model.api === 'openai-completions' || model.api === 'openai-responses')) {
    // Advertising reasoning must not also change an existing system role.
    compat.supportsDeveloperRole ??= false
  }
  return { ...model, reasoning: true, thinkingLevelMap, compat }
}

export class DesktopPiAiAdapter extends PiAiAdapter {
  constructor(config, catalogProviders, requestGate = desktopRequestGate()) {
    let lastProfiles, enhanced
    super({ ...config, profiles: () => {
      const profiles = config.profiles()
      if (profiles === lastProfiles) return enhanced
      enhanced = new Map([...profiles].map(([id, profile]) => {
        if (catalogProviders.has(id) || !profile.piProvider) return [id, profile]
        const offered = profile.piProvider.getModels().map(customModel)
        return [id, { ...profile,
          // A concrete default keeps the picker from adding a separate
          // "Default" menu item; preserve any of the six configured levels.
          reasoning: CUSTOM_REASONING_LEVELS.includes(profile.reasoning) ? profile.reasoning : 'high',
          piProvider: { ...profile.piProvider, getModels: () => offered },
        }]
      }))
      lastProfiles = profiles
      return enhanced
    } })
    this.requestGate = requestGate
  }

  async *streamWithSnapshot(options, snapshot) {
    const model = this.modelOf(snapshot, options.provider, options.model)
    if (!CONTROLLED_HTTP_APIS.has(model.api)) {
      yield* super.streamWithSnapshot(options, snapshot)
      return
    }
    const profile = this.profileOf(snapshot, options.provider)
    const idle = new LlmIdleWatchdog(options.signal, profile.streamIdleTimeoutMs)
    const original = snapshot.models.streamSimple.bind(snapshot.models)
    // Per-request views keep concurrent/prepared snapshots untouched. The
    // outer watchdog preserves stream timeouts while allowing queue waits.
    const models = new Proxy(snapshot.models, { get: (target, key) => {
      if (key === 'streamSimple') return (model, context, options) =>
        streamWithDesktopControls(original, model, context, options, this.requestGate, idle)
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const profiles = new Map(snapshot.profiles)
    profiles.set(options.provider, { ...profile, streamIdleTimeoutMs: MAX_TIMER_MS })
    const stream = super.streamWithSnapshot({ ...options, signal: idle.signal }, { ...snapshot, models, profiles })
    const iterator = stream[Symbol.asyncIterator]()
    try {
      while (true) {
        const result = await idle.next(iterator)
        if (idle.timedOut) throw new LlmError(`pi-ai stream idle timeout after ${profile.streamIdleTimeoutMs}ms`, 'TIMEOUT')
        if (result.done) return
        yield result.value
      }
    } catch (error) {
      if (idle.timedOut) throw new LlmError(`pi-ai stream idle timeout after ${profile.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      throw error
    } finally {
      idle.dispose()
      // An unresponsive next() may also keep return() pending. Release the
      // caller now; the aborted provider iterator drains when it can settle.
      iterator.return().catch(() => {})
    }
  }
}

/** Adapt at registration, before the catalog and call validation see a model.
 * Keep the original pi-ai plugin and its config namespace/settings lifecycle.
 */
export default class DesktopLlmRuntime extends LlmRuntime {
  constructor(ctx, { requestGate = desktopRequestGate() } = {}) {
    super(ctx)
    this.requestGate = requestGate
  }

  registerAdapter(providers, adapter) {
    // The upstream pi-ai plugin publishes its complete provider directory
    // before registering routes, including dormant built-in providers.
    const catalogProviders = new Set(this.listConfigurableProviders()
      .filter(provider => !provider.declared).map(provider => provider.provider))
    const effective = adapter instanceof PiAiAdapter && !(adapter instanceof DesktopPiAiAdapter)
      ? new DesktopPiAiAdapter(adapter.config, catalogProviders, this.requestGate)
      : adapter
    return super.registerAdapter(providers, effective)
  }
}
