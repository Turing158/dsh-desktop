// Test helpers for legacy recovery packages and the separate lifecycle store.
import {readdir,access} from 'node:fs/promises'
import {join} from 'node:path'
export async function recoveryFiles(root) {
  const names=async directory=>(await readdir(directory).catch(error=>{if(error.code!=='ENOENT')throw error;return []})).filter(name=>name.endsWith('.json'))
  return [...await names(root),...(await names(join(root,'transitions'))).map(name=>'transitions/'+name)]
}
export async function recoveryFile(root,name) {
  const legacy=join(root,name)
  if(await access(legacy).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false}))return legacy
  return join(root,'transitions',name)
}
