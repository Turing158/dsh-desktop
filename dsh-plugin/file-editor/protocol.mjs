export const MAX_BYTES = 2 * 1024 * 1024
export const ID = '@dsh-desktop/file-editor'
export const PLAIN_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/text'
export const CODE_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code'
export const HTML_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/html'
export function parseFile(address) {
  const prefix = 'dsh-resource://file/session/'
  if (typeof address !== 'string' || !address.startsWith(prefix)) return null
  try {
    const [sessionId, ...parts] = address.slice(prefix.length).split(/[?#]/, 1)[0].split('/')
    if (!sessionId || !parts.length) return null
    return { sessionId: decodeURIComponent(sessionId), path: parts.map(decodeURIComponent).join('/') }
  } catch { return null }
}
const codec = name => ({ mode: 'strict', typeSymbol: ID + '#' + name, create: () => ({ parse(value) {
  const limit = name === 'text' ? MAX_BYTES : name === 'path' ? 32768 : 1024
  if (typeof value !== 'string' || value.length > limit || (name !== 'text' && (!value || value.includes('\0')))) throw Error('无效的文件编辑参数')
  return value
} }) })
export const contribution = { package: ID, descriptors: [
  ['read', ['path']], ['save', ['path', 'version', 'text']],
].map(([method, args]) => ({
  id: 'desktopFileEditor/' + method, service: 'desktopFileEditor', namespace: 'desktopFileEditor', method,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'scope', wire: 'sessionId', source: 'lookup', lookup: 'desktopFileEditorScope', codec: codec('sessionId') },
    ...args.map(name => ({ name, wire: name, source: 'json', codec: codec(name) }))],
  cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
})) }
