/** Offer the existing effort picker for custom pi-ai routes, without probing
 * their capabilities. Keep model selection, persistence and errors upstream.
 */
import { runtimeImport } from './runtime-import.mjs'

const { LlmRuntime } = await runtimeImport('@deepseek-ai/dsh-llm')
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
  if (model.api === 'openai-completions') compat.supportsReasoningEffort = true
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
  constructor(config, catalogProviders) {
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
  }
}

/** Adapt at registration, before the catalog and call validation see a model.
 * Keep the original pi-ai plugin and its config namespace/settings lifecycle.
 */
export default class DesktopLlmRuntime extends LlmRuntime {
  registerAdapter(providers, adapter) {
    // The upstream pi-ai plugin publishes its complete provider directory
    // before registering routes, including dormant built-in providers.
    const catalogProviders = new Set(this.listConfigurableProviders()
      .filter(provider => !provider.declared).map(provider => provider.provider))
    const effective = adapter instanceof PiAiAdapter && !(adapter instanceof DesktopPiAiAdapter)
      ? new DesktopPiAiAdapter(adapter.config, catalogProviders)
      : adapter
    return super.registerAdapter(providers, effective)
  }
}
