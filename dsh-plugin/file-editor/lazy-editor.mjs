export function createLazyEditor(importModule) {
  let pending = null, attempt = 0
  return () => pending ??= Promise.resolve().then(() => importModule(attempt++)).catch(error => {
    pending = null
    throw error
  })
}

const revision = typeof __DSH_EDITOR_REVISION__ === 'string' ? __DSH_EDITOR_REVISION__ : 'development'
export const loadEditor = createLazyEditor(attempt => import(
  '/__dsh-desktop/file-editor/editor.mjs?v=' + revision + (attempt ? '&attempt=' + attempt : '')
))
