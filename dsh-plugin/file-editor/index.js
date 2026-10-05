import { runtimeImport } from '../runtime-import.mjs'
import { FileEditorApi, errorMessage } from './host.mjs'
import { contribution } from './protocol.mjs'

export const name = 'desktop-file-editor'
export const inject = ['fs', 'sessions', 'typert']
export async function apply(ctx) {
  const { TypertRemoteService, RemoteError } = await runtimeImport('@deepseek-ai/dsh-typert-protocol')
  const api = new FileEditorApi(ctx.fs)
  class DesktopFileEditor extends TypertRemoteService {
    constructor(scope) { super(scope, 'desktopFileEditor') }
  }
  for (const { method } of contribution.descriptors) DesktopFileEditor.prototype[method] = async function (...args) {
    try { return await api[method](...args) }
    catch (error) { throw new RemoteError('desktop-file-editor/' + (error.code || 'io'), errorMessage(error), {}) }
  }
  ctx.plugin(DesktopFileEditor)
  ctx.typert.lookups.register('desktopFileEditorScope', {
    parameter: 'scope', wire: 'sessionId', hostTypeSymbol: '@dsh-desktop/file-editor#Scope', wireTypeSymbol: '@dsh-desktop/file-editor#sessionId',
    async resolve(sessionId) {
      const header = ctx.sessions.get(sessionId)?.header ?? (await ctx.get('sessionPersistence')?.stat(sessionId))?.header
      return header?.cwd ? { sessionId, root: header.cwd } : undefined
    },
  })
  ctx.typert.register({ package: contribution.package, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: contribution.descriptors })
}
