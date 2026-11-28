import * as nodeModule from 'node:module'
import { join } from 'node:path'

const providerEntry = /^file:.*\/node_modules\/@deepseek-ai\/dsh-experimental-forge-github\/lib\/index\.js(?:[?#]|$)/
const queryField = 'query='
const missingCli = 'GitHub CLI (gh) was not found.'

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

function windowsEnv(env, name) {
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

export function withGitHubCliCompatibility(execa) {
  const run = withGitHubGraphqlInput(execa)
  const systemRoot = windowsEnv(process.env, 'SYSTEMROOT')
  if (!systemRoot) return run
  const where = join(systemRoot, 'System32', 'where.exe')
  const pendingLookups = new Map()

  return async (file, args, options) => {
    if (!/^gh(?:\.exe)?$/i.test(file) || options?.reject !== false) return run(file, args, options)

    const { cwd, env, extendEnv, cancelSignal } = options
    cancelSignal?.throwIfAborted()
    const searchEnv = extendEnv === false && env ? env : { ...process.env, ...env }
    const key = JSON.stringify([file, cwd ?? process.cwd(), windowsEnv(searchEnv, 'PATH'), windowsEnv(searchEnv, 'PATHEXT')])
    let lookup = pendingLookups.get(key)
    if (!lookup) {
      // Execa can fall back to cmd.exe for an unresolved command. Probe once
      // for concurrent reads so its localized stderr never reaches the UI.
      lookup = Promise.resolve().then(() => execa(where, [file], {
        cwd, env, extendEnv, reject: false, timeout: 3000, windowsHide: true, stdio: 'ignore',
      })).then(result => result.exitCode === 1, () => false).finally(() => pendingLookups.delete(key))
      pendingLookups.set(key, lookup)
    }
    const missing = await lookup
    cancelSignal?.throwIfAborted()
    if (missing) return { code: 'ENOENT', shortMessage: missingCli }

    const result = await run(file, args, options)
    return result?.code === 'ENOENT' ? { ...result, shortMessage: missingCli } : result
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
    const source = `import { withGitHubCliCompatibility } from ${JSON.stringify(import.meta.url)};
import { execa as original } from ${dependency};
export * from ${dependency};
export const execa = withGitHubCliCompatibility(original);`
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, format: 'module', shortCircuit: true }
  } })
}
