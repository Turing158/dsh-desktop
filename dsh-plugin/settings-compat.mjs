/** DSH 0.2 settings compatibility for the two desktop-owned namespaces.
 * CLI overlays are applied after profile patches, so Config forms for entries
 * inserted only by --patch cannot persist through the native config editor.
 * Keep their values in one desktop-settings.json, using the upstream describe,
 * mutation and invalidation transport. Every other namespace stays upstream.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeImport } from './runtime-import.mjs'
import { SettingsSchema as appearanceSchema } from './ui-client/index.js'
import { SettingsSchema as terminalSchema } from './sidebar-terminal/index.js'

const upstream = await runtimeImport('@deepseek-ai/dsh-settings')
const Base = upstream.default
const legacy = typeof Base.prototype.register === 'function'
const atomic = legacy ? null : await runtimeImport('@deepseek-ai/dsh-atomic-write')
const yaml = legacy ? null : await runtimeImport('js-yaml')
const schemas = new Map([
  ['desktop-appearance', appearanceSchema],
  ['desktop-terminal-dock', terminalSchema],
])

function readOptional(file, parse) {
  try { return parse(readFileSync(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Restore only our namespaces, including a migration refused before this fix. */
function readValues(home, file) {
  const saved = readOptional(file, JSON.parse)
  if (saved !== undefined) {
    if (saved?.version !== 1 || !saved.namespaces || typeof saved.namespaces !== 'object' || Array.isArray(saved.namespaces)) {
      throw new Error('Invalid desktop settings document: ' + file)
    }
    return Object.fromEntries([...schemas.keys()].filter(ns => Object.hasOwn(saved.namespaces, ns)).map(ns => [ns, saved.namespaces[ns]]))
  }
  const parse = text => yaml.load(text, { schema: yaml.JSON_SCHEMA })
  const previous = readOptional(join(home, 'settings.yaml'), parse)
    ?? readOptional(join(home, 'settings.yaml.imported'), parse)
  return Object.fromEntries([...schemas.keys()].filter(ns => previous && Object.hasOwn(previous, ns)).map(ns => [ns, previous[ns]]))
}

class DesktopSettings extends Base {
  constructor(ctx) {
    super(ctx)
    const file = join(ctx.profileContext.home, 'desktop-settings.json')
    this.desktop = { ctx, file, values: {}, registrations: new Map(), revisions: new Map(), tail: Promise.resolve(), loadError: null }
    try { this.desktop.values = readValues(ctx.profileContext.home, file) }
    catch (error) {
      this.desktop.loadError = error
      ctx.logger.warn('desktop settings could not be read: %s', error.message)
    }
  }

  register(ns, schema) {
    if (!schemas.has(ns)) throw new Error('Unsupported legacy settings namespace: ' + ns)
    const state = this.desktop
    if (state.registrations.has(ns)) throw new Error('Desktop settings namespace already registered: ' + ns)
    return this.ctx.effect(() => {
      state.registrations.set(ns, schema)
      state.ctx.emit('settings/document-updated', ns, state.revisions.get(ns) ?? 0)
      return () => {
        state.registrations.delete(ns)
        state.ctx.emit('settings/document-updated', ns, state.revisions.get(ns) ?? 0)
      }
    })
  }

  get(ns) {
    const schema = this.desktop.registrations.get(ns)
    return schema ? schema(structuredClone(this.desktop.values[ns])) : super.describe().find(row => row.ns === ns)?.value
  }

  describe(options) {
    return [...super.describe(options), ...[...this.desktop.registrations].map(([ns, schema]) => ({
      ns, autoGenerate: false, schema: schema.toJSON(), value: this.get(ns),
      revision: this.desktop.revisions.get(ns) ?? 0, base: schema({}),
      user: structuredClone(this.desktop.values[ns] ?? {}), applies: 'live',
    }))]
  }

  update(ns, patch, expectedRevision) {
    if (!this.desktop.registrations.has(ns)) return super.update(ns, patch, expectedRevision)
    return this.writeDesktop(ns, current => ({ ...current, ...patch }), expectedRevision)
  }

  replace(ns, section, expectedRevision) {
    if (!this.desktop.registrations.has(ns)) return super.replace(ns, section, expectedRevision)
    return this.writeDesktop(ns, () => structuredClone(section), expectedRevision)
  }

  mutate(ns, ops, expectedRevision) {
    if (!this.desktop.registrations.has(ns)) return super.mutate(ns, ops, expectedRevision)
    return this.writeDesktop(ns, current => {
      const schema = this.desktop.registrations.get(ns).toJSON()
      const fields = schema.refs[schema.uid].dict
      for (const op of ops) {
        if (op.path.length !== 1 || !Object.hasOwn(fields, op.path[0])) throw new Error('Unknown desktop settings field')
        if (op.op === 'set') current[op.path[0]] = structuredClone(op.value)
        else if (op.op === 'unset') delete current[op.path[0]]
        else throw new Error('Unknown desktop settings operation')
      }
      return current
    }, expectedRevision)
  }

  writeDesktop(ns, change, expectedRevision) {
    const state = this.desktop
    const pending = state.tail.then(async () => {
      if (state.loadError) throw state.loadError
      const schema = state.registrations.get(ns)
      if (!schema) throw new Error('Desktop settings namespace is no longer available: ' + ns)
      const revision = state.revisions.get(ns) ?? 0
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new upstream.SettingsConflictError(ns, expectedRevision, revision)
      }
      const section = change(structuredClone(state.values[ns] ?? {}))
      if (schema.validate(section) === undefined) throw new Error('Invalid desktop settings: ' + ns)
      const envelope = schema.toJSON()
      if (Object.keys(section).some(field => !Object.hasOwn(envelope.refs[envelope.uid].dict, field))) {
        throw new Error('Unknown desktop settings field')
      }
      const values = { ...state.values, [ns]: section }
      // Serialize namespaces together; a simultaneous appearance and terminal
      // write must not drop either section. Publish only after the atomic write.
      await atomic.writeFileAtomic(state.file, JSON.stringify({ version: 1, namespaces: values }, null, 2) + '\n', { mode: 0o600 })
      const previous = this.get(ns)
      state.values = values
      state.revisions.set(ns, revision + 1)
      state.ctx.emit('settings/document-updated', ns, revision + 1)
      state.ctx.emit('settings/updated', ns, this.get(ns), previous)
    })
    state.tail = pending.catch(() => {})
    return pending
  }
}

// The original provider already implements the namespace API on DSH 0.1.x.
export default legacy ? Base : DesktopSettings
