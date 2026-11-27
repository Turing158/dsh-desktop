import * as nodeModule from 'node:module'

const providerEntry = /^file:.*\/node_modules\/@deepseek-ai\/dsh-experimental-forge-github\/lib\/index\.js(?:[?#]|$)/
const queryField = 'query='

export function withGitHubGraphqlInput(execa) {
  return (file, args, options) => {
    if (!Array.isArray(args) || args[0] !== 'api' || args[1] !== 'graphql' || options?.stdin !== 'ignore') {
      return execa(file, args, options)
    }

    const field = args.findIndex((arg, i) => args[i - 1] === '-f' && arg.startsWith(queryField) && /[\r\n]/.test(arg))
    if (field === -1) return execa(file, args, options)

    // A typed gh field with @- reads its value verbatim from stdin. Keep the
    // other fields so gh still encodes their values and types as before.
    const input = args[field].slice(queryField.length)
    const forwarded = [...args.slice(0, field - 1), '-F', 'query=@-', ...args.slice(field + 1)]
    return execa(file, forwarded, { ...options, stdin: 'pipe', input })
  }
}

export function installGitHubCliHook() {
  if (process.platform !== 'win32' || typeof nodeModule.registerHooks !== 'function') return

  nodeModule.registerHooks({ resolve(specifier, context, nextResolve) {
    const original = nextResolve(specifier, context)
    if (specifier !== 'execa' || !providerEntry.test(context.parentURL)) return original

    // Adapt only this provider's import, preserving the runtime's original
    // Execa dependency and the provider's identity in the DSH plugin loader.
    const dependency = JSON.stringify(original.url)
    const source = `import { withGitHubGraphqlInput } from ${JSON.stringify(import.meta.url)};
import { execa as original } from ${dependency};
export * from ${dependency};
export const execa = withGitHubGraphqlInput(original);`
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, format: 'module', shortCircuit: true }
  } })
}
