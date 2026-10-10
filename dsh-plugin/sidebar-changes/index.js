import { runtimeImport } from '../runtime-import.mjs'
import { SnapshotStore } from './host/snapshot-store.mjs'
import { installRecorder } from './host/session-recorder.mjs'
import { ChangesApi, resolveScope, explain } from './host/api.mjs'
import { contribution, REASONS } from './shared/change-model.mjs'
import { createCommitMessageGenerator } from './host/commit-message.mjs'

export const name = 'desktop-sidebar-changes'
export const inject = ['tools', 'sessions', 'typert']
export async function apply(ctx, config = {}) {
  const directory = process.env.DSH_DESKTOP_CHANGES_DIR
  if (!directory) { ctx.logger.warn('desktop-sidebar-changes: snapshot directory unavailable'); return }
  const { TypertRemoteService, RemoteError } = await runtimeImport('@deepseek-ai/dsh-typert-protocol')
  const store = new SnapshotStore(directory)
  const excludes = Array.isArray(config.excludes) && config.excludes.every(name => typeof name === 'string' && !/[\\/]/.test(name)) ? config.excludes : undefined
  installRecorder(ctx, store, { excludes })
  const api = new ChangesApi(store, createCommitMessageGenerator(ctx))
  class DesktopChanges extends TypertRemoteService {
    constructor(scope) { super(scope, 'desktopChanges') }
  }
  for (const descriptor of contribution.descriptors) {
    DesktopChanges.prototype[descriptor.method] = descriptor.mode === 'stream'
      ? function (...args) { return api[descriptor.method](...args) }
      : async function (...args) {
        try { return await api[descriptor.method](...args) }
        catch (error) { throw new RemoteError('desktop-changes/query', explain(error), { reason: REASONS[error?.message] ? error.message : 'git-failed', detail: error?.gitMessage?.slice(0, 4000) || '' }) }
      }
  }
  ctx.plugin(DesktopChanges)
  ctx.typert.lookups.register('desktopChangesScope', {
    parameter: 'scope', wire: 'sessionId', hostTypeSymbol: '@dsh-desktop/sidebar-changes#Scope', wireTypeSymbol: '@dsh-desktop/sidebar-changes#sessionId',
    resolve: sessionId => resolveScope(ctx, sessionId),
  })
  ctx.typert.register({ package: contribution.package, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: contribution.descriptors })
}
