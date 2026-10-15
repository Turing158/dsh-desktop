export const ID = '@dsh-desktop/directory-picker'
const pathCodec = { mode: 'strict', typeSymbol: ID + '#path', create: () => ({ parse(value) {
  if (value !== undefined && (typeof value !== 'string' || !value || value.length > 32768 || value.includes('\0'))) throw Error('Invalid file path')
  return value
} }) }
export const contribution = { package: ID, descriptors: ['capability', 'roots', 'files', 'readFile'].map(method => ({
  id: 'desktopDirectoryPicker/' + method, service: 'desktopDirectoryPicker', namespace: 'desktopDirectoryPicker', method,
  invocation: { kind: 'direct' },
  parameters: ['files', 'readFile'].includes(method) ? [{
    name: 'path', wire: 'path', source: 'json', codec: pathCodec,
    // Initial browsing and Home omit the path; reading an attachment requires it.
    ...(method === 'files' ? { acceptsUndefined: true } : {}),
  }] : [],
  cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
})) }
