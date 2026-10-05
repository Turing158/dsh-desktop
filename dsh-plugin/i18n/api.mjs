/** Translate only explicitly authored UI copy, never file contents or user text. */
export function t(source, values) {
  const runtime = globalThis.window?.__DSH_I18N__
  if (runtime) return runtime.t(source, values)
  return typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source
}

/** Subscribe without remounting the component or discarding its local state. */
export function useLocale(React) {
  globalThis.window?.__DSH_I18N__?.use(React)
}
