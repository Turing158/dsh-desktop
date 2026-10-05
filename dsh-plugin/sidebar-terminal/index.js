/** The host registers preferences shared by the DSH and native terminal adapters.
 * Import-free because this plugin is installed outside DSH's node_modules. */
const name = 'desktop-sidebar-terminal'
const inject = ['settings']
// Keep the old layout schema readable. The client restores height only and
// starts every launch with the bottom panel closed, even if collapsed was false.
const defaults = () => ({ layout: { height: 240, collapsed: true }, profileId: 'auto', position: 'bottom' })
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { layout = defaults().layout, profileId = 'auto', position = 'bottom' } = value
  if (!layout || typeof layout !== 'object' || !Number.isFinite(layout.height) || layout.height < 120 || layout.height > 10000 || typeof layout.collapsed !== 'boolean') return undefined
  if (!['auto', 'pwsh', 'powershell', 'cmd'].includes(profileId) || !['bottom', 'right'].includes(position)) return undefined
  if (value.shellPath !== undefined && (typeof value.shellPath !== 'string' || value.shellPath.length > 32768 || value.shellPath.includes('\0'))) return undefined
  return { layout: { height: layout.height, collapsed: layout.collapsed }, profileId, position, ...(value.shellPath === undefined ? {} : { shellPath: value.shellPath }) }
}
function SettingsSchema(value) { return normalize(value) || defaults() }
SettingsSchema.validate = normalize
// This is the real Schemastery wire shape; describe() needs it even though this
// plugin contributes its own rows. A plain JSON schema would break every settings UI.
SettingsSchema.toJSON = () => ({ uid: 8, refs: {
  3: { type: 'number', meta: { min: 120, max: 10000, required: true } },
  5: { type: 'boolean', meta: { required: true } },
  6: { type: 'object', meta: { default: { height: 240, collapsed: true } }, dict: { height: 3, collapsed: 5 } },
  9: { type: 'const', meta: { required: true }, value: 'auto' },
  10: { type: 'const', meta: { required: true }, value: 'pwsh' },
  11: { type: 'const', meta: { required: true }, value: 'powershell' },
  12: { type: 'const', meta: { required: true }, value: 'cmd' },
  13: { type: 'union', meta: { default: 'auto' }, list: [9, 10, 11, 12] },
  14: { type: 'const', meta: { required: true }, value: 'bottom' },
  15: { type: 'const', meta: { required: true }, value: 'right' },
  16: { type: 'union', meta: { default: 'bottom' }, list: [14, 15] },
  17: { type: 'string' },
  8: { type: 'object', meta: { default: {} }, dict: { layout: 6, profileId: 13, position: 16, shellPath: 17 } },
} })
SettingsSchema['~standard'] = { version: 1, vendor: 'dsh-desktop', validate(value) {
  const resolved = normalize(value)
  const field = value?.profileId !== undefined && !['auto', 'pwsh', 'powershell', 'cmd'].includes(value.profileId) ? 'profileId'
    : value?.position !== undefined && !['bottom', 'right'].includes(value.position) ? 'position'
    : value?.shellPath !== undefined && normalize({ shellPath: value.shellPath }) === undefined ? 'shellPath' : 'layout'
  return resolved ? { value: resolved } : { issues: [{ message: 'Invalid terminal preference: ' + field, path: [field] }] }
} }
function apply(ctx) {
  ctx.settings.register('desktop-terminal-dock', SettingsSchema)
}
export { apply, inject, name, SettingsSchema }
