// Freeze the actual dependency closure without re-resolving or downloading it.
// Selection and update/data transactions are owned by the native host.
import { createRequire } from 'node:module'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir, readFile, mkdir, realpath, access } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'

const inside = (root,path) => { const rel = relative(root,path); return rel === '' || (!rel.startsWith('..'+sep) && rel !== '..' && !isAbsolute(rel)) }
export async function inspectRuntimeTree(root, limits = {}) {
  root = await realpath(root)
  const files = [], packages = [], edges = [], missingOptional = [], externalDependencies = []
  const maxFiles = limits.maxFiles ?? 200_000, maxBytes = limits.maxBytes ?? 2 * 1024 ** 3
  let totalBytes = 0
  async function walk(dir,depth) {
    if(depth > 80)throw Error('runtime-depth-budget')
    const entries = await readdir(dir,{withFileTypes:true})
    for(let offset=0;offset<entries.length;offset+=24) {
      const batch=await Promise.all(entries.slice(offset,offset+24).map(async item=>{
        const path=join(dir,item.name),info=await lstat(path)
        if(info.isSymbolicLink() || !inside(root,await realpath(path)))throw Error('runtime-linked-path')
        return {item,path,info}
      }))
      for(const {item,path,info} of batch) {
      if(info.isDirectory())await walk(path,depth+1)
      else if(info.isFile()) {
        totalBytes += info.size
        if(files.length >= maxFiles || totalBytes > maxBytes)throw Error('runtime-size-budget')
        files.push({path:relative(root,path).split(sep).join('/'),size:info.size})
        if(item.name === 'package.json' && (dir === root || /(?:^|[\\/])node_modules(?:[\\/]@[^\\/]+)?[\\/][^\\/]+$/.test(dir))) {
          const manifest = JSON.parse(await readFile(path,'utf8'))
          packages.push({path,manifest})
        }
      } else throw Error('runtime-special-file')
      }
    }
  }
  await walk(root,0)
  for(const {path,manifest} of packages) {
    const required = manifest.dependencies ?? {}, optional = manifest.optionalDependencies ?? {}, peers = manifest.peerDependencies ?? {}
    const names = new Set([...Object.keys(required),...Object.keys(optional),...Object.keys(peers)])
    const require = createRequire(path)
    for(const name of names) {
      if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))throw Error('runtime-dependency-name')
      // An optional dependency may be absent, and the Node resolver can still
      // reach a copy installed above this tree. Both mean "not part of this
      // installation", so they are omitted instead of failing the freeze.
      const omittable = name in optional || Boolean(manifest.peerDependenciesMeta?.[name]?.optional)
      let target
      for(const search of require.resolve.paths(name) ?? []) {
        const candidate = join(search,name,'package.json')
        if(await access(candidate).then(()=>true,()=>false)) {target = await realpath(candidate);break}
      }
      if(!target) {
        if(omittable) {missingOptional.push({from:relative(root,path),name});continue}
        throw Error('runtime-dependency-missing: '+manifest.name+' -> '+name)
      }
      if(!inside(root,target)) {
        if(omittable) {missingOptional.push({from:relative(root,path),name});continue}
        if(!limits.collectExternal)throw Error('runtime-dependency-external: '+manifest.name+' -> '+name)
        externalDependencies.push({from:path,name,target:dirname(target)})
      }
      edges.push({from:relative(root,path).split(sep).join('/'),name,to:relative(root,target).split(sep).join('/')})
    }
  }
  return {schema:1,root,files:files.sort((a,b)=>a.path.localeCompare(b.path)),packages:packages.length,edges,missingOptional,externalDependencies,totalBytes}
}
async function hash(path) {
  const digest = createHash('sha256')
  for await(const chunk of createReadStream(path))digest.update(chunk)
  return digest.digest('hex')
}
async function stableHash(path, size) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(size)) throw Error('runtime-source-changed')
  const sha256 = await hash(path), after = await lstat(path, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('runtime-source-changed')
  return sha256
}
async function copyHashed(from, to, size) {
  const digest = createHash('sha256')
  let copied = 0
  const tee = new Transform({transform(chunk, encoding, callback) {
    copied += chunk.length
    if (copied > size) { callback(Error('runtime-source-changed')); return }
    digest.update(chunk)
    callback(null, chunk)
  }})
  await pipeline(createReadStream(from), tee, createWriteStream(to,{flags:'wx'}))
  if (copied !== size) throw Error('runtime-source-changed')
  const sourceDigest = digest.digest('hex')
  if (await hash(to) !== sourceDigest) throw Error('runtime-source-changed')
  return sourceDigest
}
function directoryMaker() {
  const pending = new Map()
  return dir => {
    if (!pending.has(dir)) pending.set(dir,mkdir(dir,{recursive:true}))
    return pending.get(dir)
  }
}
export async function freezeRuntimeTree(source,destination,limits) {
  source = await realpath(source); destination = resolve(destination)
  if(inside(source,destination) || inside(destination,source))throw Error('runtime-overlapping-roots')
  if(await access(destination).then(()=>true,()=>false))throw Error('runtime-destination-exists')
  const inventory = await inspectRuntimeTree(source,limits)
  await mkdir(destination,{recursive:true})
  const ensureDirectory=directoryMaker()
  const files = []
  // Limited concurrency keeps the file descriptor count bounded on Windows.
  for(let offset=0;offset<inventory.files.length;offset+=24) {
    files.push(...await Promise.all(inventory.files.slice(offset,offset+24).map(async file=>{
      const from = join(source,file.path), to = join(destination,file.path)
      await ensureDirectory(dirname(to))
      const before = await lstat(from,{bigint:true})
      if(!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(file.size))throw Error('runtime-source-changed')
      const digest = await copyHashed(from,to,file.size), after = await lstat(from,{bigint:true})
      if(!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)throw Error('runtime-source-changed')
      return {...file,sha256:digest}
    })))
  }
  const frozen = await inspectRuntimeTree(destination,limits)
  if(JSON.stringify(frozen.edges) !== JSON.stringify(inventory.edges) || frozen.totalBytes !== inventory.totalBytes || frozen.files.length !== files.length)throw Error('runtime-resolution-changed')
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return {schema:1,fingerprint,files,packages:inventory.packages,edges:inventory.edges,missingOptional:inventory.missingOptional,totalBytes:inventory.totalBytes}
}

// Preserve the common npm installation layout instead of flattening peers into
// the dsh package. Flattening can change a nested package's resolved version.
export async function freezeRuntimeClosure(source,destination,limits = {}) {
  source = await realpath(source); destination = resolve(destination)
  let boundary = dirname(source)
  while(dirname(boundary) !== boundary && !boundary.endsWith(sep+'node_modules'))boundary=dirname(boundary)
  if(!boundary.endsWith(sep+'node_modules'))throw Error('runtime-install-layout-unsupported')
  boundary = await realpath(boundary)
  if(inside(boundary,destination) || inside(destination,boundary))throw Error('runtime-overlapping-roots')
  if(await access(destination).then(()=>true,()=>false))throw Error('runtime-destination-exists')
  const roots = [], queue = [source], visited = new Set(), sourceEdges = [], files = [], missingOptional=[]
  let totalBytes=0, packages=0
  while(queue.length) {
    const current=queue.shift()
    if(visited.has(current))continue
    if(!inside(boundary,current))throw Error('runtime-dependency-outside-installation')
    visited.add(current)
    const inventory=await inspectRuntimeTree(current,{...limits,collectExternal:true})
    totalBytes+=inventory.totalBytes; packages+=inventory.packages
    if(totalBytes>(limits.maxBytes??2*1024**3))throw Error('runtime-size-budget')
    roots.push(inventory)
    const base=relative(boundary,current)
    files.push(...inventory.files.map(file=>({...file,path:join('node_modules',base,file.path).split(sep).join('/'),source:join(current,file.path)})))
    if(files.length>(limits.maxFiles??200_000))throw Error('runtime-size-budget')
    sourceEdges.push(...inventory.edges.map(edge=>({...edge,from:join('node_modules',base,edge.from).split(sep).join('/'),to:join('node_modules',base,edge.to).split(sep).join('/')})))
    missingOptional.push(...inventory.missingOptional.map(edge=>({...edge,from:join('node_modules',base,edge.from).split(sep).join('/')})))
    queue.push(...inventory.externalDependencies.map(edge=>edge.target))
  }
  files.sort((a,b)=>a.path.localeCompare(b.path))
  const packagePath=join('node_modules',relative(boundary,source)).split(sep).join('/')
  if (limits.reuseCandidates?.length) {
    const hashed=[]
    for(let offset=0;offset<files.length;offset+=24) {
      hashed.push(...await Promise.all(files.slice(offset,offset+24).map(async file=>({
        path:file.path,size:file.size,sha256:await stableHash(file.source,file.size),
      }))))
    }
    const fingerprint=createHash('sha256').update(JSON.stringify(hashed)).digest('hex')
    const existing=limits.reuseCandidates.find(candidate=>candidate.fingerprint===fingerprint
      && candidate.entry===packagePath+'/lib/bin.js' && candidate.fileCount===hashed.length && candidate.totalBytes===totalBytes)
    if(existing) return {schema:1,fingerprint,files:hashed,packages,edges:sourceEdges,missingOptional,totalBytes,
      packagePath,externalPackages:roots.length-1,reusedId:existing.id}
  }
  await mkdir(destination,{recursive:true})
  const ensureDirectory=directoryMaker()
  const copied=[]
  for(let offset=0;offset<files.length;offset+=24) {
    copied.push(...await Promise.all(files.slice(offset,offset+24).map(async file=>{
      const to=join(destination,file.path),from=file.source,before=await lstat(from,{bigint:true})
      if(!before.isFile()||before.isSymbolicLink()||before.size!==BigInt(file.size))throw Error('runtime-source-changed')
      await ensureDirectory(dirname(to))
      const sha256=await copyHashed(from,to,file.size),after=await lstat(from,{bigint:true})
      if(!after.isFile()||after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino
        ||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('runtime-source-changed')
      return {path:file.path,size:file.size,sha256}
    })))
  }
  const frozen=await inspectRuntimeTree(destination,limits)
  const sortEdges=edges=>edges.sort((a,b)=>(a.from+'|'+a.name).localeCompare(b.from+'|'+b.name))
  if(JSON.stringify(sortEdges(sourceEdges))!==JSON.stringify(sortEdges(frozen.edges))||frozen.totalBytes!==totalBytes||frozen.files.length!==files.length)throw Error('runtime-resolution-changed')
  const fingerprint=createHash('sha256').update(JSON.stringify(copied)).digest('hex')
  return {schema:1,fingerprint,files:copied,packages,edges:sourceEdges,missingOptional,totalBytes,
    packagePath,externalPackages:roots.length-1}
}
