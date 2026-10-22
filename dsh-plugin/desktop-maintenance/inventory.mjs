// Read paths from the selected runtime's resolver. This helper never mounts a
// profile or reads business/credential files, and is also usable before boot.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

export async function resolveInventory(entry) {
  const require = createRequire(entry)
  const module = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href)
  if (typeof module.resolveDshHome !== 'function') throw Error('inventory-resolver-unavailable')
  const dataRoot = module.resolveDshHome()
  const packagePath = join(dirname(entry), '..', 'package.json')
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh') throw Error('inventory-entry-unrecognized')
  let profileDirectory = null
  try {
    const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
    if (typeof boot.resolveProfileDir === 'function') profileDirectory = boot.resolveProfileDir('web')
  } catch { /* Historical versions without this resolver remain limited. */ }
  return { schema: 1, dataRoot, profile: 'web', profileHome: dataRoot,
    profileDirectory,
    resolver: '@deepseek-ai/dsh-home-paths', runtimeVersion: pkg.version,
    // Paths derived by the upstream helper remain candidates until a running
    // provider confirms its config. They are never restoration destinations.
    consistency: 'unverified', migrationScope: 'unverified' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await resolveInventory(process.argv[2]))) }
  catch { process.stderr.write('inventory-resolver-unavailable'); process.exitCode = 1 }
}
