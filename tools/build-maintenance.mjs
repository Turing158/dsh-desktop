import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),
  entryPoints:['dsh-plugin/desktop-maintenance/client-entry.mjs'],outfile:'dsh-plugin/desktop-maintenance/client.js',
  bundle:true,format:'iife',target:'es2022',loader:{'.css':'text'},legalComments:'inline'})
console.log('Built maintenance client.')
await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),
  entryPoints:['dsh-plugin/desktop-maintenance/local-entry.mjs'],outfile:'src-tauri/ui/diagnostics.js',
  bundle:true,format:'esm',target:'es2022',legalComments:'inline'})
console.log('Built local diagnostics client.')
