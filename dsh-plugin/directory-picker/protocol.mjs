export const ID = '@dsh-desktop/directory-picker'
export const contribution = { package: ID, descriptors: ['capability', 'roots'].map(method => ({
  id: 'desktopDirectoryPicker/' + method, service: 'desktopDirectoryPicker', namespace: 'desktopDirectoryPicker', method,
  invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
})) }
