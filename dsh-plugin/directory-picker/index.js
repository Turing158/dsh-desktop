import { runtimeImport } from '../runtime-import.mjs'
import { contribution } from './protocol.mjs'
import { listRoots } from './host.mjs'

export const name = 'desktop-directory-picker'
export const inject = ['typert', 'directoryPicker']
export async function apply(ctx) {
  const { TypertRemoteService, RemoteError } = await runtimeImport('@deepseek-ai/dsh-typert-protocol')
  class DesktopDirectoryPicker extends TypertRemoteService {
    constructor(scope) { super(scope, 'desktopDirectoryPicker') }
    async capability() { return ctx.directoryPicker.capability().kind }
    async roots(signal) {
      try { return await listRoots(signal) }
      catch (error) { throw new RemoteError('desktop-directory-picker/roots', error.message, {}) }
    }
  }
  ctx.plugin(DesktopDirectoryPicker)
  ctx.typert.register({ package: contribution.package, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: contribution.descriptors })
}
