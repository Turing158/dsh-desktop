/**
 * DeepseekHarness desktop — appearance overlay (host-side Cordis plugin).
 *
 * Injects the desktop app's UI customisations into the served page, using DSH's
 * own `webserver/index-inject` seam — the same mechanism the shipped theme
 * plugin uses. No DSH file is modified, and a plain `dsh web` in a terminal is
 * unaffected because this plugin only mounts when the overlay asks for it.
 *
 * Two tiers are injected:
 *
 *   theme.css  a `<style>` row in `<head>`  — re-skins via the `--dsw-*` tokens
 *   dom.js     a `<script>` row in `<body>` — DOM-level changes CSS cannot do
 *
 * Both files are re-read on every page render, so editing them needs only a
 * window reload (Ctrl+R). They are looked up beside this module, which the
 * `--patch` overlay resolves to an absolute path.
 *
 * ESM is used here (unlike `desktop-notify.mjs`, which must stay import-free for
 * its own reasons); `node:fs` and `node:path` are always available to a Node
 * host plugin, so this needs no installed dependency.
 *
 * @module desktop-ui
 */

import { appendFileSync, readFileSync, statSync, truncateSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** Stable Cordis plugin name. */
const name = 'desktop-ui'

/** Requires the webserver, since that is the seam being extended. */
const inject = ['webServer']

/** Directory holding the overlay assets, resolved beside this module. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Overlay assets, relative to {@link HERE}. */
const CSS_FILE = join(HERE, 'ui-overlay', 'theme.css')
const JS_FILE = join(HERE, 'ui-overlay', 'dom.js')

/**
 * Stdout marker the Rust host scans for, to learn the appearance setting.
 *
 * The desktop shell needs to color the native title bar to match the app, and
 * only this process can read the user's `ui-theme` setting. Reporting it on
 * stdout reuses the same one-way channel as the notification bridge, so the host
 * needs no settings parser of its own (and no YAML dependency).
 *
 * Keep in sync with `__DSH_THEME__` in `dsh.rs`.
 */
const THEME_MARKER = '__DSH_THEME__'

/** The settings namespace the theme plugin owns. */
const THEME_NAMESPACE = 'ui-theme'

/** Accepted values; `system` means "follow the OS". */
const THEME_PREFERENCES = ['light', 'dark', 'system']

/**
 * The settings namespace this app owns for its own appearance choices.
 *
 * Registered by the host half of the appearance plugin (`ui-client/index.js`),
 * which is a *separate* Loader row from this one — hence the defensive reads in
 * {@link readUiMode}, rather than a hard dependency between the two.
 */
const APPEARANCE_NAMESPACE = 'desktop-appearance'

/** The field naming the UI mode inside {@link APPEARANCE_NAMESPACE}. */
const UI_MODE_FIELD = 'ui'

/** The mode meaning "the unmodified frontend". */
const VANILLA_MODE = 'vanilla'

/** The mode meaning "apply the desktop overlay". */
const DESKTOP_MODE = 'desktop'

/**
 * `<html>` attribute the CSS and DOM tiers key their gate off.
 *
 * Keep in sync with `MODE_ATTRIBUTE` in `ui-overlay/dom.js` and the gate in
 * `ui-overlay/theme.css`.
 */
const MODE_ATTRIBUTE = 'data-dsh-ui'

/** App-owned chrome attributes, shared with title-bar/client.js and boot.js. */
const TITLEBAR_MODE_ATTRIBUTE = 'data-dsh-titlebar-mode'
const TITLEBAR_HOVER_ATTRIBUTE = 'data-dsh-titlebar-hover'
const TITLEBAR_FULL = 'full'

/**
 * Read the persisted UI mode from the settings service.
 *
 * Fails closed to `desktop`: an absent service, an unregistered namespace, or an
 * unexpected value all mean "the app was started normally", and the overlay
 * being on is the state the user last chose in every case except an explicit
 * `vanilla`.
 *
 * @param ctx - the plugin context.
 * @returns `desktop` or `vanilla`.
 */
function readSettingsSection(ctx, namespace) {
  const settings = ctx.get?.('settings')
  if (typeof settings?.get === 'function') return settings.get(namespace)
  // DSH 0.2 projects live Config values instead of keeping a settings registry.
  return settings?.describe?.().find(row => row.ns === namespace)?.value
}

function readUiMode(ctx) {
  try {
    const section = readSettingsSection(ctx, APPEARANCE_NAMESPACE)
    if (section === null || typeof section !== 'object') return DESKTOP_MODE
    return section[UI_MODE_FIELD] === VANILLA_MODE ? VANILLA_MODE : DESKTOP_MODE
  } catch {
    return DESKTOP_MODE
  }
}

/**
 * Seed UI preference and app-owned chrome before first paint.
 * Legacy titlebar/titlebarHover settings deliberately do not enter this path.
 * Values are JSON-encoded and '<' is escaped for safe inline script content.
 */
function chromeAttributesScript(uiMode, titlebarMode, titlebarHover) {
  const pairs = [
    [MODE_ATTRIBUTE, uiMode],
    [TITLEBAR_MODE_ATTRIBUTE, titlebarMode],
    [TITLEBAR_HOVER_ATTRIBUTE, titlebarHover],
  ]
  const statements = pairs
    .map(([name, value]) => {
      const attribute = JSON.stringify(name)
      const encoded = JSON.stringify(value)
      return `document.documentElement.setAttribute(${attribute},${encoded})`
    })
    .join(';')
  return `try{${statements}}catch(e){/* a page without a documentElement is not ours to fix */}`
}

/**
 * Write one theme report. Never throws: a failure here must not affect the app.
 *
 * @param preference - `light`, `dark`, or `system`.
 */
function reportTheme(preference) {
  try {
    console.log(`${THEME_MARKER} ${JSON.stringify({ preference })}`)
  } catch {
    /* A broken stdout is not worth failing the plugin over. */
  }
}

/**
 * Read the current appearance preference from the settings service.
 *
 * Falls back to `system` when the service or the section is absent, which is
 * exactly what the theme plugin's own schema default says, so the host and the
 * page never disagree about the baseline.
 *
 * @param ctx - the plugin context.
 * @returns one of {@link THEME_PREFERENCES}.
 */
function readPreference(ctx) {
  try {
    const section = readSettingsSection(ctx, THEME_NAMESPACE)
    const value = section !== null && typeof section === 'object' ? section.preference : undefined
    return typeof value === 'string' && THEME_PREFERENCES.includes(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

/**
 * Extract a preference from a `settings/updated` payload.
 *
 * The event carries the freshly resolved section, which is authoritative. Reading
 * it from the payload rather than re-reading the service also removes any
 * dependence on event/commit ordering.
 *
 * @param next - the event's resolved value.
 * @returns one of {@link THEME_PREFERENCES}, or `undefined` when absent.
 */
function preferenceFrom(next) {
  if (next === null || typeof next !== 'object') return undefined
  const value = next.preference
  return typeof value === 'string' && THEME_PREFERENCES.includes(value) ? value : undefined
}

/**
 * Report the appearance preference now, and again whenever it changes.
 *
 * WHICH EVENT. `settings/updated(ns, next, prev, source)` is emitted by
 * `commit()` *after* the namespace's resolved value is swapped, and it carries
 * that new value. `settings/document-updated(ns, revision)` is emitted earlier,
 * by `bumpRevision()`, *before* the resolved value is updated — so a listener
 * that re-reads `settings.get(ns)` at that moment always sees the PREVIOUS
 * value. Listening to the wrong one is not a missed update but a one-step lag,
 * which is exactly the reported symptom: choosing dark left the title bar light
 * and choosing light left it dark, with the host logging a change only once
 * because each re-read matched the value it had already cached.
 *
 * The last value is cached so an unrelated settings edit (any namespace, any
 * field) does not spam the host with identical reports.
 *
 * @param ctx - the plugin context.
 */
function trackTheme(ctx) {
  let last
  const publish = (candidate) => {
    const preference = candidate ?? readPreference(ctx)
    if (preference === last) return
    last = preference
    reportTheme(preference)
  }

  // Report immediately so the window is colored correctly on first paint,
  // rather than only after the user opens settings.
  publish()

  // The settings service commits through this event; it fires for every
  // namespace, so the namespace test filters the rest.
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== THEME_NAMESPACE) return
    publish(preferenceFrom(next))
  })
  ctx.on('settings/document-updated', ns => {
    if (ns !== THEME_NAMESPACE) return
    // describe() emits this event itself. Defer the read to avoid re-entering it.
    queueMicrotask(() => publish())
  })
}

/**
 * Guard against a payload that would close its own element early.
 *
 * The webserver renders rows by string concatenation, so a literal `</script`
 * or `</style` inside the payload would terminate the tag and spill the rest of
 * the file into the document as text. Splitting the sequence keeps the value
 * identical to JavaScript and CSS while making it inert to the HTML parser.
 *
 * @param text - the asset contents.
 * @param tag - `script` or `style`, i.e. the element being closed.
 * @returns the text with any closing sequence neutralised.
 */
function neutralise(text, tag) {
  return text.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}

/**
 * Read one overlay asset.
 *
 * A missing file is reported once and skipped: the desktop app must still boot
 * if the user deleted an overlay, and a broken style sheet must never be able to
 * block the UI.
 *
 * @param path - absolute path of the asset.
 * @param context - the plugin context, for logging.
 * @returns the file contents, or `undefined` when unavailable.
 */
function readAsset(path, context) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    context.logger?.warn?.(`desktop-ui: could not read ${path}: ${String(error)}`)
    return undefined
  }
}

/**
 * Mount the overlay injection and the appearance reporter.
 *
 * @param ctx - host context carrying the webserver.
 * @param rawConfig - optional row config.
 */
/**
 * Register the launch-diagnostics route.
 *
 * POST /__dsh-desktop/diag with a small JSON body appends one line to
 * `~/.dsh/desktop-diag.log`. The fence is the composition's own
 * `requestRejection`, the same trust gate the open-in-app routes sit behind, so
 * only the authenticated page can write here. Every step is guarded: a
 * diagnostics channel that throws must never take the overlay (or the server)
 * down with it.
 *
 * @param ctx - plugin context carrying `webServer` and `connection`.
 */
function registerDiagRoute(ctx) {
  const logPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'desktop-diag.log')
  const webServer = Reflect.get(ctx, 'webServer')
  const connection = Reflect.get(ctx, 'connection')
  if (typeof webServer?.register !== 'function') return

  try {
    ctx.effect(
      () =>
        webServer.register(
          {
            kind: 'exact',
            path: '/__dsh-desktop/diag',
            handler: async (req, res) => {
              try {
                const rejection = connection?.requestRejection?.(req)
                if (rejection !== undefined) {
                  res.statusCode = rejection
                  res.end()
                  return
                }
                if (req.method !== 'POST') {
                  res.statusCode = 405
                  res.end()
                  return
                }
                const chunks = []
                let size = 0
                for await (const chunk of req) {
                  size += chunk.byteLength
                  if (size > 8 * 1024) {
                    req.resume()
                    res.statusCode = 413
                    res.end()
                    return
                  }
                  chunks.push(chunk)
                }
                const body = Buffer.concat(chunks, size).toString('utf8')
                // Bounded file: past 256 KiB the log restarts, so a chatty day
                // cannot grow it without limit.
                try {
                  const stat = statSync(logPath)
                  if (stat.size > 256 * 1024) truncateSync(logPath, 0)
                } catch {
                  /* no file yet: appendFileSync creates it */
                }
                const safeBody = body.replace(/https?:\/\/[^\s"'<>]+/g, value => value.replace(/[?#].*/, '?[redacted]'))
                  .replace(/token=[^\s"'&]+/gi, 'token=[redacted]')
                appendFileSync(logPath, safeBody.replace(/\n/g, ' ') + '\n')
                res.statusCode = 204
                res.end()
              } catch {
                res.statusCode = 500
                res.end()
              }
            },
          },
          'desktop-ui: POST /__dsh-desktop/diag',
        ),
      'desktop-ui: launch diagnostics route',
    )
  } catch (error) {
    ctx.logger?.warn?.(`desktop-ui: could not register the diag route: ${String(error)}`)
  }
}

function apply(ctx, rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const enableCss = config.css !== false
  const enableJs = config.dom !== false
  const trackAppearance = config.reportTheme !== false
  const enableDiag = config.diag === true

  // The settings service is optional and may mount after this row, so acquire it
  // lazily rather than injecting it: requiring it would make the whole overlay
  // wait on a service the appearance reporter can do without.
  if (trackAppearance) ctx.inject(['settings'], (settingsCtx) => trackTheme(settingsCtx))

  // Launch diagnostics, behind an explicit config flag. Every directory action in
  // the page (overlay items and title-bar items alike) posts one JSON line here
  // — the attempt, the route's answer, and the overlay version that made it —
  // appended to a bounded file beside the profile. What it buys: a manual click
  // that "does nothing" leaves a record of whether the click reached the
  // handler, whether the launch was asked for, and what came back, so the
  // failure is diagnosable from the file instead of reproducible-by-guessing.
  if (enableDiag) ctx.inject(['webServer', 'connection'], (diagCtx) => registerDiagRoute(diagCtx))

  if (!enableCss && !enableJs) return

  ctx.on('webserver/index-inject', (table) => {
    // Re-read on every render so edits take effect on a reload without a restart.
    // Ordered: the mode script first, so the attribute is set before the
    // stylesheet below is parsed. Rows render into their placement group in
    // table order, so pushing it here is what makes 原版 flash-free. It does not
    // depend on `enableCss`/`enableJs`: the mode is also what the DOM tier reads.
    table.push({
      kind: 'script',
      placement: 'head',
      text: chromeAttributesScript(readUiMode(ctx), TITLEBAR_FULL, 'on'),
    })
    // LAN HTTP lacks secure-context-only helpers required by upstream clients.
    for (const [file, kind] of [['ui-overlay/browser-compat.js', 'script'], ['ui-overlay/mobile.css', 'style'], ['ui-remote/style.css', 'style']]) {
      const asset = readAsset(join(HERE, file), ctx)
      if (asset !== undefined) table.push({ kind, placement: 'head', text: neutralise(asset, kind) })
    }
    // The connection note tells a phone page WHY its session list cannot load
    // (fence 403 / spent login / unreachable host) — failures the upstream
    // connection pill reports as a bare "disconnected". Functional, so it
    // rides in 原版 too, like the terminal assets below.
    const noteAsset = readAsset(join(HERE, 'ui-overlay', 'connection-note.js'), ctx)
    if (noteAsset !== undefined) table.push({ kind: 'script', placement: 'head', text: neutralise(noteAsset, 'script') })
    // Functional assets survive 原版 and load before the client plugin mounts.
    for (const [file, kind, tag] of [['terminal.css', 'style', 'style'], ['terminal.js', 'script', 'script']]) {
      const asset = readAsset(join(HERE, 'sidebar-terminal', 'assets', file), ctx)
      if (asset !== undefined) table.push({ kind, placement: 'head', text: neutralise(asset, tag) })
    }

    if (enableCss) {
      const css = readAsset(CSS_FILE, ctx)
      if (css !== undefined) {
        table.push({ kind: 'style', text: neutralise(css, 'style') })
      }
    }

    if (enableJs) {
      const js = readAsset(JS_FILE, ctx)
      if (js !== undefined) {
        // `body` placement: the overlay polls for the app to mount anyway, and
        // running after the shell's own head scripts avoids ordering concerns.
        table.push({ kind: 'script', placement: 'body', text: neutralise(js, 'script') })
      }
    }
  })
}

export { apply, inject, name }
