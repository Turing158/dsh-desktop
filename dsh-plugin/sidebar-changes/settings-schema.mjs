export const SETTINGS_NAMESPACE = 'desktop-changes'

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return undefined
  // Omission follows the installed UI; a boolean is the user's explicit choice.
  return value.enabled === undefined ? {} : { enabled: value.enabled }
}

export function SettingsSchema(value) { return normalize(value) ?? {} }
SettingsSchema.validate = normalize
SettingsSchema.toJSON = () => ({ uid: 1, refs: {
  1: { type: 'object', meta: { default: {} }, dict: { enabled: 2 } },
  2: { type: 'boolean' },
} })
SettingsSchema['~standard'] = { version: 1, vendor: 'dsh-desktop', validate(value) {
  const resolved = normalize(value)
  return resolved ? { value: resolved } : { issues: [{ message: 'Invalid changes preference', path: ['enabled'] }] }
} }
