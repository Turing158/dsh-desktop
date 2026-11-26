import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// The large language/editor bundle is read and evaluated only when an editor
// is opened. A content revision prevents mixing old clients with rebuilt code.
export function editorAssetHandler({ reject, read = () => readFileSync(new URL('./editor.lazy.mjs', import.meta.url)) }) {
  return (req, res) => {
    const rejection = reject?.(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return }
    try {
      const bytes = read(), revision = createHash('sha256').update(bytes).digest('hex')
      const requested = new URL(req.url, 'http://localhost').searchParams.get('v')
      if (requested !== revision) { res.statusCode = 409; res.end(); return }
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      res.setHeader('Content-Length', bytes.length)
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch { res.statusCode = 503; res.end() }
  }
}
