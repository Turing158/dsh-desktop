import { t } from '../i18n/api.mjs'
import { SOURCES } from './shared/change-model.mjs'

export const FILE_KIND = 'desktop-change'
export const FILE_PREFIX = 'dsh-resource://desktop-change/'
export const changeAddress = (sessionId, source, entry) => FILE_PREFIX
  + [sessionId, source, entry.fileId, entry.path].map(encodeURIComponent).join('/')
export function parseChangeAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return null
  try {
    const parts = address.slice(FILE_PREFIX.length).split('/').map(decodeURIComponent)
    if (parts.length !== 4 || parts.some(part => !part || /[\0\r\n]/.test(part)) || !SOURCES.includes(parts[1])) return null
    const [sessionId, source, fileId, path] = parts
    return { sessionId, source, fileId, path }
  } catch { return null }
}
export const changeTitle = address => {
  const file = parseChangeAddress(address)
  return file ? file.path.split(/[\\/]/).at(-1) + ' · ' + t('更改') : t('查看更改')
}
export function absoluteFilePath(entry, workspaceRoot) {
  return entry.absolutePath || (workspaceRoot ? workspaceRoot.replace(/[\\/]$/, '') + '/' + entry.path : null)
}
export const fileAddress = (sessionId, path) => 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(path)
