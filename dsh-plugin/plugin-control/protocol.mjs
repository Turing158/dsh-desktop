const codec = name => ({ mode: 'strict', typeSymbol: '@dsh-desktop/plugin-control#' + name,
  create: () => ({ parse(value) {
    if (name === 'enabled' ? typeof value !== 'boolean' : typeof value !== 'string' || !value || value.length > (name === 'entryId' ? 1024 : 80)) throw Error('Invalid plugin switch')
    return value
  } }) })
export const contribution = { package: '@dsh-desktop/plugin-control', descriptors: [
  ['status', []], ['setEnabled', ['id', 'enabled']], ['setPluginEnabled', ['entryId', 'enabled']],
  ['installMarketplace', []],
].map(([method, args]) => ({ id: 'desktopPlugins/' + method, service: 'desktopPlugins', namespace: 'desktopPlugins', method,
  invocation: { kind: 'direct' }, parameters: args.map(name => ({ name, wire: name, source: 'json', codec: codec(name) })),
  result: { mode: 'src-json' },
})) }
