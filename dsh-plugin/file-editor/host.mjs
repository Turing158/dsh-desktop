import { MAX_BYTES } from './protocol.mjs'

const fail = code => { throw Object.assign(Error(code), { code }) }
const MESSAGES = {
  'editor/outside': '只能编辑当前会话工作目录中的文件。',
  'editor/missing': '文件已不存在，请检查路径。',
  'editor/type': '此文件不是可编辑的普通文件。',
  'editor/encoding': '此文件不是有效的 UTF-8 文本，无法直接编辑。',
  'editor/binary': '二进制文件无法作为文本编辑。',
  'editor/large': '文件超过 2 MiB，无法在侧栏中编辑。',
  'editor/busy': '文件服务繁忙，请稍后重试。',
  FS_TOO_LARGE: '文件超过 2 MiB，无法在侧栏中编辑。',
  FS_STALE_VERSION: '文件已被其他程序修改。你的编辑已保留，请先复制需要保留的内容，再重新读取文件。',
  EACCES: '没有写入此文件的权限。', EPERM: '文件只读或正在被其他程序占用。',
}
export const errorMessage = error => MESSAGES[error?.code] || error?.message || '文件操作失败，请重试。'
export function decodeText(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { fail('editor/encoding') }
  if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) fail('editor/binary')
  const bom = text.startsWith('\uFEFF')
  if (bom) text = text.slice(1)
  const eol = text.match(/\r\n|\r|\n/)?.[0] || '\n'
  return { text: text.replace(/\r\n|\r/g, '\n'), bom, eol }
}

/** Use the host filesystem's guarded atomic writer, including its lock and policy. */
export class FileEditorApi {
  constructor(fs) { this.fs = fs; this.active = 0 }
  async locate(scope, path, signal) {
    if (!scope?.root || typeof path !== 'string' || !path || path.includes('\0')) fail('editor/missing')
    const root = await this.fs.resolve(scope.root, { signal })
    const target = await this.fs.resolve(path, { cwd: scope.root, signal })
    if (!this.fs.contains(root, target)) fail('editor/outside')
    const entry = await this.fs.lstat(path, { cwd: scope.root }, signal)
    if (!entry) fail('editor/missing')
    if (entry.type !== 'file') fail('editor/type')
    const info = await this.fs.stat(target, signal)
    if (!info) fail('editor/missing')
    if (info.type !== 'file') fail('editor/type')
    if (info.size > MAX_BYTES) fail('editor/large')
    return { target, info }
  }
  async snapshot(scope, path, signal) {
    const { target, info } = await this.locate(scope, path, signal)
    const bytes = await this.fs.readBytes(target, signal, MAX_BYTES)
    const after = await this.fs.stat(target, signal)
    if (!after || info.version !== after.version) fail('FS_STALE_VERSION')
    return { target, version: info.version, ...decodeText(bytes) }
  }
  async bounded(run) {
    if (this.active >= 4) fail('editor/busy')
    this.active++
    try { return await run() } finally { this.active-- }
  }
  read(scope, path, signal) {
    return this.bounded(async () => {
      const { target, ...value } = await this.snapshot(scope, path, signal)
      return { ...value, absolutePath: this.fs.processPath(target) }
    })
  }
  save(scope, path, version, text, signal) {
    return this.bounded(async () => {
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('editor/large')
      const current = await this.snapshot(scope, path, signal)
      if (current.version !== version) fail('FS_STALE_VERSION')
      // Never silently transcode the file or remove its BOM/final newline.
      decodeText(Buffer.from(text, 'utf8'))
      const normalized = text.replace(/\r\n|\r/g, '\n')
      const content = (current.bom ? '\uFEFF' : '') + normalized.replace(/\n/g, current.eol)
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) fail('editor/large')
      signal?.throwIfAborted()
      const result = await this.fs.writeText(current.target, content, { kind: 'replaceIfVersion', version }, signal)
      return { version: result.version, text: normalized, bom: current.bom, eol: current.eol }
    })
  }
}
