import * as reader from '../session-links.mjs'

export const name = 'desktop-session-links'
export function apply(ctx) {
  // Client discovery remains available on runtimes without native references.
  ctx.inject(['sessionReferenceResolver'], reader.apply)
}
