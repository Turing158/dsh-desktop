import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['dsh-plugin/account-popover/client-entry.mjs'], outfile: 'dsh-plugin/account-popover/client.js',
  bundle: true, format: 'iife', target: 'es2022', loader: { '.css': 'text' }, legalComments: 'inline' })
console.log('Built account popover client.')
