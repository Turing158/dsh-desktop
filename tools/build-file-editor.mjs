import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const engine = await build({ absWorkingDir: root, entryPoints: ['dsh-plugin/file-editor/editor.mjs'],
  outfile: root + 'dsh-plugin/file-editor/editor.lazy.mjs', bundle: true, format: 'esm', target: 'es2022',
  minify: true, legalComments: 'inline', metafile: true })
const revision = createHash('sha256').update(await readFile(root + 'dsh-plugin/file-editor/editor.lazy.mjs')).digest('hex')
const client = await build({ absWorkingDir: root, entryPoints: ['dsh-plugin/file-editor/client-entry.mjs'],
  outfile: root + 'dsh-plugin/file-editor/client.js', bundle: true, format: 'iife', target: 'es2022',
  legalComments: 'inline', loader: { '.css': 'text' }, metafile: true,
  define: { __DSH_EDITOR_REVISION__: JSON.stringify(revision) } })
const packages = [...new Set([...Object.keys(engine.metafile.inputs), ...Object.keys(client.metafile.inputs)]
  .flatMap(file => file.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1] || []))].sort()
let licenses = ''
for (const name of packages) {
  const pkg = JSON.parse(await readFile(root + 'node_modules/' + name + '/package.json', 'utf8'))
  let license
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { license = await readFile(root + 'node_modules/' + name + '/' + file, 'utf8'); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!license) throw Error('Missing editor dependency license: ' + name)
  licenses += `${name} ${pkg.version}\n${license}\n\n`
}
await writeFile(root + 'dsh-plugin/file-editor/LICENSES.txt', licenses)
console.log('Built sidebar file editor client and lazy editor engine.')
