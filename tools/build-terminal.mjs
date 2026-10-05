import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const out = root + 'dsh-plugin/sidebar-terminal/assets/'
await mkdir(out, { recursive: true })
await build({ absWorkingDir: root, entryPoints: ['dsh-plugin/sidebar-terminal/runtime.mjs'], outfile: out + 'terminal.js', bundle: true, format: 'iife', globalName: 'DSHTerminal', target: 'es2020', minify: true, legalComments: 'inline' })
await writeFile(out + 'terminal.css', (await readFile(root + 'node_modules/@xterm/xterm/css/xterm.css', 'utf8')) + '\n' + (await readFile(root + 'dsh-plugin/sidebar-terminal/terminal.css', 'utf8')))
let licenses = ''
for (const name of ['@xterm/xterm', '@xterm/addon-fit']) {
  const pkg = JSON.parse(await readFile(root + 'node_modules/' + name + '/package.json', 'utf8'))
  licenses += `${name} ${pkg.version}\n${await readFile(root + 'node_modules/' + name + '/LICENSE', 'utf8')}\n\n`
}
await writeFile(out + 'LICENSES.txt', licenses)
console.log('Built local terminal JS, CSS and licenses.')
await build({ absWorkingDir: root, entryPoints: ['dsh-plugin/sidebar-changes/client-entry.mjs'], outfile: root + 'dsh-plugin/sidebar-changes/client.js', bundle: true, format: 'iife', target: 'es2022', legalComments: 'inline' })
console.log('Built changes sidebar client.')
await build({ absWorkingDir: root, entryPoints: ['dsh-plugin/plugin-control/client-entry.mjs'], outfile: root + 'dsh-plugin/plugin-control/client.js', bundle: true, format: 'iife', target: 'es2022', legalComments: 'inline' })
console.log('Built builtin plugin settings client.')
const editorBuild = await build({ absWorkingDir: root, entryPoints: ['dsh-plugin/file-editor/client-entry.mjs'], outfile: root + 'dsh-plugin/file-editor/client.js', bundle: true, format: 'iife', target: 'es2022', legalComments: 'inline', loader: { '.css': 'text' }, metafile: true })
const editorPackages = [...new Set(Object.keys(editorBuild.metafile.inputs).flatMap(file => file.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1] || []))].sort()
let editorLicenses = ''
for (const name of editorPackages) {
  const pkg = JSON.parse(await readFile(root + 'node_modules/' + name + '/package.json', 'utf8'))
  let license
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { license = await readFile(root + 'node_modules/' + name + '/' + file, 'utf8'); break } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!license) throw Error('Missing editor dependency license: ' + name)
  editorLicenses += `${name} ${pkg.version}\n${license}\n\n`
}
await writeFile(root + 'dsh-plugin/file-editor/LICENSES.txt', editorLicenses)
console.log('Built sidebar file editor client.')
