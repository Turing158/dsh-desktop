import { createRequire } from 'node:module'

/** node-pty's bundled DLL loader uses MAX_PATH. Managed runtime paths can
 * exceed it even when the DLL exists. This particular error is thrown before
 * any PTY or shell is allocated, so retrying with Windows' ConPTY is safe. */
export function installConptyFallback(pty, platform = process.platform) {
  if (platform !== 'win32' || typeof pty?.spawn !== 'function') return () => {}
  const original = pty.spawn
  function spawn(file, args, options) {
    try { return original.call(this, file, args, options) }
    catch (error) {
      if (options?.useConptyDll !== true || !/^Cannot find conpty\.dll at\b[^\r\n]*error code: (?:2|3)\b/i.test(error?.message ?? '')) throw error
      return original.call(this, file, args, { ...options, useConptyDll: false })
    }
  }
  pty.spawn = spawn
  return () => { if (pty.spawn === spawn) pty.spawn = original }
}

export function installRuntimeConptyFallback() {
  if (process.platform !== 'win32') return () => {}
  const runtime = createRequire(process.env.DSH_DESKTOP_DSH_BIN || process.argv[1])
  let provider
  try { provider = runtime.resolve('@deepseek-ai/dsh-subprocess-local') }
  catch (error) {
    // Older DSH releases may not expose this provider.
    if (error.code === 'MODULE_NOT_FOUND') return () => {}
    throw error
  }
  // Resolve the provider's exact node-pty instance, including nested installs.
  return installConptyFallback(createRequire(provider)('node-pty'))
}
