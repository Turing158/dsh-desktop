import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freezeRuntimeClosure } from './snapshot.mjs'

export async function prepareRuntime(source, destination) {
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(pkg.version)) throw Error('runtime-package-invalid')
  const inventory = await freezeRuntimeClosure(source, destination)
  const entry = inventory.packagePath + '/lib/bin.js'
  if (!inventory.files.some(file => file.path === entry)) throw Error('runtime-entry-missing')
  // Written beside the tree, never included in its own content fingerprint.
  await writeFile(join(destination, '..', 'inventory.json'), JSON.stringify(inventory), { flag: 'wx' })
  return { version: pkg.version, entry, fingerprint: inventory.fingerprint, fileCount: inventory.files.length, totalBytes: inventory.totalBytes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const request = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const result = await prepareRuntime(request.source, request.destination)
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    process.stderr.write(String(error.message).split(':')[0])
    process.exitCode = 1
  }
}
