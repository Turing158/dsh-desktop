/**
 * Host half of the desktop appearance plugin.
 *
 * Registers the settings namespace the browser half persists into. The client
 * cannot create a namespace — the settings document's schema is owned by the host
 * plane — so this half exists for that one registration, and the browser half
 * (`./client.js`) renders the UI.
 *
 * Both halves live in one package because `dsh-client-modules` finds a client
 * bundle by resolving the Loader row to a package root: the row below mounts this
 * file, and that is what makes `<root>/client.js` discoverable at all.
 *
 * ## No imports, on purpose
 *
 * This module is mounted from the desktop app's install directory, where bare
 * specifiers like `@deepseek-ai/schemastery` do **not** resolve — they exist only
 * under `$DSH_HOME/profiles/node_modules`. Importing one fails the whole boot
 * with `ERR_MODULE_NOT_FOUND` (verified), so nothing is imported here.
 *
 * That means the settings schema cannot be built with Schemastery. It does not
 * need to be: `settings.register` validates against whatever the caller's value
 * object provides, and a plain object supplying the same `~standard` schema
 * interface is equivalent for this one field. The shape below is exactly the
 * contract Schemastery itself implements — `validate`, plus `~standard` for
 * Standard Schema consumers. Keeping it hand-written is what allows this file to
 * be dependency-free.
 *
 * @module @dsh-desktop/appearance
 */

/** Stable Cordis plugin name. */
const name = 'desktop-appearance'

/** The settings service is optional; the namespace registers when it exists. */
const inject = ['settings']

/** The namespace and fields the browser half reads and writes. */
const NAMESPACE = 'desktop-appearance'
const ANIMATION_FIELD = 'animation'
const UI_MODE_FIELD = 'ui'
const FONT_SIZE_OVERRIDE_FIELD = 'fontSizeOverride'
const TITLEBAR_MODE_FIELD = 'titlebar'
const TITLEBAR_HOVER_FIELD = 'titlebarHover'
const COMPOSER_MATERIAL_FIELD = 'composerMaterial'
const COMPOSER_MATERIALS = ['glass', 'frosted', 'transparent', 'opaque']
const COMPOSER_TUNING_FIELDS = ['composerTransparency', 'composerFrostedIntensity', 'composerGlassIntensity']
const DIALOG_MATERIAL_FIELD = 'dialogMaterial'
const DIALOG_TUNING_FIELDS = ['dialogTransparency', 'dialogFrostedIntensity', 'dialogGlassIntensity']
const REASONING_CONTROL_FIELD = 'reasoningControl'
const REASONING_CONTROLS = ['select', 'slider']
const COLOR_SCHEME_FIELD = 'colorScheme'
const COLOR_SCHEMES = ['default', 'blue', 'teal', 'moss', 'violet', 'amber', 'rose']

/**
 * Accepted animation preferences.
 *
 * `system` defers to the OS `prefers-reduced-motion` setting, `on` animates
 * regardless, `off` never animates. The browser half applies the value to
 * `document.documentElement`, which the overlay stylesheet keys off.
 */
const ANIMATION_PREFERENCES = ['system', 'on', 'off']

/** The default when the document carries no value. */
const DEFAULT_ANIMATION = 'system'

/**
 * The font sizes the browser half may persist here.
 *
 * These are exactly the 外观 select's choices that fall OUTSIDE the theme
 * runtime's own accepted range: `theme.setFontSize` throws outside 12..17 (its
 * guard and the `ui-theme` schema's `min(12).max(17)` agree), so 10, 11, and 18
 * are applied by the browser half directly to `--dsh-content-font-size` and
 * stored in THIS namespace — the desktop app serves the page on a fresh port
 * each launch, so no per-origin storage survives a restart. The in-range
 * choices 12..17 never appear in this document; they belong to `ui-theme`, and
 * the browser half routes them there.
 *
 * An absent field (the common case) means "no override": the runtime's size
 * governs and the browser half writes nothing of its own.
 */
const FONT_SIZE_OVERRIDES = [10, 11, 18]

/**
 * Accepted UI modes.
 *
 * `desktop` applies this app's overlay — the default, and what every user who
 * has never opened the menu gets. `vanilla` shows the frontend exactly as DSH
 * ships it: the stylesheet's rules stop matching and the DOM tier withdraws its
 * tags.
 *
 * The value is read by the host half of the overlay plugin (`desktop-ui.mjs`)
 * to publish `data-dsh-ui` before first paint, and written live by the browser
 * half when the title bar's 更多 menu is used. Both halves must agree on the
 * spelling, so it is named here once.
 */
const UI_MODES = ['desktop', 'vanilla']

/** The default mode. */
const DEFAULT_UI_MODE = 'desktop'

/**
 * Accepted title-bar modes.
 *
 * `full` renders the bar every user who never opened the menu gets — the mark,
 * 编辑 / 会话 / 项目 / 更多, and the window buttons. `simple` renders the shape
 * the injected boot bar (`title-bar/boot.js`) draws before DSH mounts — the
 * mark, 更多, and the window buttons — as a persistent choice, which is what
 * makes the boot bar and the real bar two renderings of one bar.
 *
 * The value is read by the host half of the overlay plugin (`desktop-ui.mjs`)
 * to publish `data-dsh-titlebar-mode` before first paint, applied live by the
 * browser half, and gated into the bar's own render by
 * `title-bar/client.js`. Both halves must agree on the spelling, so it is named
 * here once.
 */
const TITLEBAR_MODES = ['full', 'simple']

/** The default title-bar mode. */
const DEFAULT_TITLEBAR_MODE = 'full'

/**
 * Accepted icon-hover preferences.
 *
 * `on` keeps the hover feedback on the bar's own icons — trigger highlight,
 * window-control highlight, the mark's glyph swap. `off` stops those reactions
 * while leaving every control clickable; it exists for a pointer-driven
 * environment where the user would rather the strip never light up under the
 * cursor. Absent and `on` are the same value to every reader.
 */
const TITLEBAR_HOVER_PREFERENCES = ['on', 'off']

/** The default icon-hover preference. */
const DEFAULT_TITLEBAR_HOVER = 'on'

/**
 * Validate and normalize one section value.
 *
 * Shared by the `validate` method and the `~standard` interface so both answer
 * identically.
 *
 * @param value - raw section value from the settings document.
 * @returns the value with known preferences, or undefined to reject.
 */
const BACKGROUND_FIELDS = {
  backgroundImage: 'string', backgroundTransparency: 'number', backgroundBlur: 'number',
  backgroundNavigation: 'boolean',
  backgroundNavigationSurfaceTransparency: 'number',
  // Retain separate switches and transparency fields for existing settings.
  backgroundTitlebarSurfaceTransparency: 'number', backgroundLeftSurfaceTransparency: 'number',
  backgroundRightSurfaceTransparency: 'number', backgroundChatSurfaceTransparency: 'number',
  backgroundTitlebar: 'boolean', backgroundTitlebarTransparency: 'number',
  backgroundLeft: 'boolean', backgroundLeftTransparency: 'number',
  backgroundRight: 'boolean', backgroundRightTransparency: 'number',
  backgroundChat: 'boolean', backgroundChatTransparency: 'number',
}

function normalize(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rawAnimation = value[ANIMATION_FIELD]
  // An absent field is the documented default, not a failure.
  const animation = rawAnimation === undefined ? DEFAULT_ANIMATION : rawAnimation
  if (typeof animation !== 'string') return undefined
  if (!ANIMATION_PREFERENCES.includes(animation)) return undefined

  const rawUi = value[UI_MODE_FIELD]
  const ui = rawUi === undefined ? DEFAULT_UI_MODE : rawUi
  if (typeof ui !== 'string') return undefined
  if (!UI_MODES.includes(ui)) return undefined

  const rawTitlebar = value[TITLEBAR_MODE_FIELD]
  const titlebar = rawTitlebar === undefined ? DEFAULT_TITLEBAR_MODE : rawTitlebar
  if (typeof titlebar !== 'string') return undefined
  if (!TITLEBAR_MODES.includes(titlebar)) return undefined

  const rawTitlebarHover = value[TITLEBAR_HOVER_FIELD]
  const titlebarHover = rawTitlebarHover === undefined ? DEFAULT_TITLEBAR_HOVER : rawTitlebarHover
  if (typeof titlebarHover !== 'string') return undefined
  if (!TITLEBAR_HOVER_PREFERENCES.includes(titlebarHover)) return undefined

  // The override is optional in both directions: an absent (or null) field is
  // omitted from the resolved section (the runtime's size governs), and a
  // present one must be one of the accepted sizes. An invalid present value
  // rejects the section, same verdict the other two fields give an invalid
  // value — a write of one is refused, and a hand-edited document carrying one
  // resolves to the defaults rather than to a size the runtime cannot reach.
  // `null` is legal rather than rejected because the rehydrated envelope passes
  // it through, and the two implementations must agree on which values are
  // legal; both read it as "no override".
  const rawFontSize = value[FONT_SIZE_OVERRIDE_FIELD]
  let fontSizeOverride
  if (rawFontSize !== undefined && rawFontSize !== null) {
    if (!FONT_SIZE_OVERRIDES.includes(rawFontSize)) return undefined
    fontSizeOverride = rawFontSize
  }

  const section = { [ANIMATION_FIELD]: animation, [UI_MODE_FIELD]: ui, [TITLEBAR_MODE_FIELD]: titlebar, [TITLEBAR_HOVER_FIELD]: titlebarHover }
  // Omitted in old documents: keep their original palette and settings shape.
  if (value[COLOR_SCHEME_FIELD] !== undefined) {
    if (!COLOR_SCHEMES.includes(value[COLOR_SCHEME_FIELD])) return undefined
    section[COLOR_SCHEME_FIELD] = value[COLOR_SCHEME_FIELD]
  }
  // Optional for older documents; the client defaults to the selector.
  if (value[REASONING_CONTROL_FIELD] !== undefined) {
    if (!REASONING_CONTROLS.includes(value[REASONING_CONTROL_FIELD])) return undefined
    section[REASONING_CONTROL_FIELD] = value[REASONING_CONTROL_FIELD]
  }
  // Spread order is irrelevant — the field names are distinct — but the
  // override is added conditionally so a resolved section never carries the
  // key with `undefined`, which `deepEqual` and JSON round-trips both treat
  // differently from an absent key.
  if (fontSizeOverride !== undefined) section[FONT_SIZE_OVERRIDE_FIELD] = fontSizeOverride
  // Optional so existing documents keep their shape; the client defaults to opaque.
  for (const field of [COMPOSER_MATERIAL_FIELD, DIALOG_MATERIAL_FIELD]) {
    const material = value[field]
    if (material === undefined || material === null) continue
    if (!COMPOSER_MATERIALS.includes(material)) return undefined
    section[field] = material
  }
  for (const field of [...COMPOSER_TUNING_FIELDS, ...DIALOG_TUNING_FIELDS]) {
    const raw = value[field]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) return undefined
    section[field] = raw
  }
  for (const [field, type] of Object.entries(BACKGROUND_FIELDS)) {
    const raw = value[field]
    if (raw === undefined) continue
    if (typeof raw !== type) return undefined
    if (type === 'number' && (!Number.isFinite(raw) || raw < 0 || raw > 100)) return undefined
    if (field === 'backgroundImage' && (raw.length > 8 * 1024 * 1024 || (raw !== '' && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)))) return undefined
    section[field] = raw
  }
  return section
}

/**
 * The serialized schema envelope for this namespace.
 *
 * WHY A HAND-WRITTEN ENVELOPE. This module cannot import `@deepseek-ai/schemastery`
 * (mounted from the app directory, where that bare specifier does not resolve),
 * but the settings service requires a *real* Schemastery schema: `describe()`
 * calls `registration.schema.toJSON()` for EVERY registered namespace, and the
 * client rehydrates the result with `new Schema(envelope)`.
 *
 * A schema object lacking `toJSON` therefore does far more damage than breaking
 * one field — it makes the whole settings describe throw, which is why the
 * permission row, the model provider list, and the plugin configuration tab all
 * failed at once with `registration.schema.toJSON is not a function`.
 *
 * So this is the exact envelope `z.object({ animation: z.union([...]).default(
 * 'system'), ui: z.union([...]).default('desktop') }).toJSON()` produces,
 * transcribed. The `uid`/`refs` graph is Schemastery's wire format: `refs` is
 * keyed by uid, and nodes reference their children by those keys. Verified by
 * rehydrating it through the real constructor: defaults apply, valid values
 * pass, and invalid values are rejected with the same message a compiled schema
 * gives (`$.ui expected "desktop" | "vanilla" but got "bogus"`).
 *
 * ADDING A FIELD means adding BOTH a const/union pair here and a `dict` entry on
 * the root, and the uids must stay internally consistent — every `list`/`dict`
 * entry is a key into `refs`. `uid: 14` is this graph's root. The numbering is
 * arbitrary; it is kept distinct per node rather than renumbered densely so a
 * diff shows exactly which node was added.
 */
const SCHEMA_ENVELOPE = {
  uid: 14,
  refs: {
    // The three accepted animation values, as required consts.
    2: { type: 'const', meta: { required: true }, value: 'system' },
    4: { type: 'const', meta: { required: true }, value: 'on' },
    6: { type: 'const', meta: { required: true }, value: 'off' },
    // The union over them, defaulting to `system`.
    7: { type: 'union', meta: { default: 'system' }, list: [2, 4, 6] },
    // The two accepted UI modes, as required consts.
    10: { type: 'const', meta: { required: true }, value: 'desktop' },
    12: { type: 'const', meta: { required: true }, value: 'vanilla' },
    // The union over them, defaulting to `desktop`.
    13: { type: 'union', meta: { default: 'desktop' }, list: [10, 12] },
    // The three accepted font-size overrides, as required consts (10, 11, 18 —
    // the sizes outside the theme runtime's own 12..17).
    16: { type: 'const', meta: { required: true }, value: 10 },
    18: { type: 'const', meta: { required: true }, value: 11 },
    20: { type: 'const', meta: { required: true }, value: 18 },
    // The union over them, with NO default: an absent field means "no
    // override", and the rehydrated schema drops an absent union key instead of
    // filling one, which is exactly the shape `normalize` produces.
    22: { type: 'union', list: [16, 18, 20] },
    // The two accepted title-bar modes, as required consts.
    24: { type: 'const', meta: { required: true }, value: 'full' },
    26: { type: 'const', meta: { required: true }, value: 'simple' },
    // The union over them, defaulting to `full`.
    28: { type: 'union', meta: { default: 'full' }, list: [24, 26] },
    // The two accepted icon-hover preferences, as required consts. Distinct
    // uids from the animation union's `on`/`off` (2, 6): the two fields happen
    // to share spellings but are separate nodes, and Schemastery's refs graph
    // has no dedup.
    30: { type: 'const', meta: { required: true }, value: 'on' },
    32: { type: 'const', meta: { required: true }, value: 'off' },
    // The union over them, defaulting to `on`.
    34: { type: 'union', meta: { default: 'on' }, list: [30, 32] },
    60: { type: 'const', meta: { required: true }, value: 'glass' },
    61: { type: 'const', meta: { required: true }, value: 'frosted' },
    62: { type: 'const', meta: { required: true }, value: 'transparent' },
    63: { type: 'const', meta: { required: true }, value: 'opaque' },
    64: { type: 'union', list: [60, 61, 62, 63] },
    68: { type: 'const', meta: { required: true }, value: 'select' },
    69: { type: 'const', meta: { required: true }, value: 'slider' },
    70: { type: 'union', list: [68, 69] },
    71: { type: 'const', meta: { required: true }, value: 'default' },
    72: { type: 'const', meta: { required: true }, value: 'blue' },
    73: { type: 'const', meta: { required: true }, value: 'moss' },
    74: { type: 'const', meta: { required: true }, value: 'violet' },
    75: { type: 'const', meta: { required: true }, value: 'amber' },
    76: { type: 'const', meta: { required: true }, value: 'rose' },
    77: { type: 'union', list: [71, 72, 78, 73, 74, 75, 76] },
    78: { type: 'const', meta: { required: true }, value: 'teal' },
    // The object schema itself, including optional appearance preferences.
    14: {
      type: 'object',
      meta: { default: {} },
      dict: { animation: 7, ui: 13, fontSizeOverride: 22, titlebar: 28, titlebarHover: 34, composerMaterial: 64, dialogMaterial: 64, reasoningControl: 70, colorScheme: 77 },
    },
  },
}

// Optional fields preserve the shape of existing settings documents.
Object.entries(BACKGROUND_FIELDS).forEach(([field, type], index) => {
  const uid = 40 + index
  SCHEMA_ENVELOPE.refs[uid] = { type, ...(type === 'number' ? { meta: { min: 0, max: 100 } } : {}) }
  SCHEMA_ENVELOPE.refs[14].dict[field] = uid
})
COMPOSER_TUNING_FIELDS.forEach((field, index) => {
  const uid = 65 + index
  SCHEMA_ENVELOPE.refs[uid] = { type: 'number', meta: { min: 0, max: 100 } }
  SCHEMA_ENVELOPE.refs[14].dict[field] = uid
})
DIALOG_TUNING_FIELDS.forEach((field, index) => {
  const uid = 79 + index
  SCHEMA_ENVELOPE.refs[uid] = { type: 'number', meta: { min: 0, max: 100 } }
  SCHEMA_ENVELOPE.refs[14].dict[field] = uid
})

/**
 * Schema for this namespace, without a validator dependency.
 *
 * CALLABLE, because that is how the settings service uses a schema: its
 * `resolve()` does `schema(mergeLayers(base, section))` — it invokes the schema
 * as a function to turn a raw section into the resolved value. A plain object
 * carrying only `validate` therefore throws `schema is not a function` inside
 * registration, which is invisible from the browser: the namespace never
 * appears and a client write is silently dropped.
 *
 * FORGIVING HERE, STRICT IN `validate`, and the split is deliberate. This
 * function is the *resolve* path: it is called both at registration, over
 * whatever is already in the settings document, and on every commit. Throwing
 * there would fail `settings.register` — and a namespace that fails to register
 * takes the whole settings describe down with it, the same blast radius the
 * `toJSON` note above describes. So an unrecognized value degrades to the
 * documented default instead.
 *
 * The strict verdict lives in {@link SettingsSchema.validate} and
 * `~standard`, which are what a *write* is checked against: a client asking to
 * store `ui: 'bogus'` is rejected, and the form shows the issue. A hand-edited
 * document containing one is tolerated and read as the default.
 *
 * @param value - raw section value (possibly undefined when the document has none).
 * @returns the resolved section, with the documented defaults applied.
 */
function SettingsSchema(value) {
  return (
    normalize(value) ?? {
      [ANIMATION_FIELD]: DEFAULT_ANIMATION,
      [UI_MODE_FIELD]: DEFAULT_UI_MODE,
      [TITLEBAR_MODE_FIELD]: DEFAULT_TITLEBAR_MODE,
      [TITLEBAR_HOVER_FIELD]: DEFAULT_TITLEBAR_HOVER,
    }
  )
}

/**
 * Return the serialized schema for configuration surfaces.
 *
 * Required by the settings service, and depended on by every other namespace's
 * rendering — see {@link SCHEMA_ENVELOPE}.
 *
 * @returns a fresh copy, so a consumer mutating the result cannot corrupt this
 *   module's envelope for later reads.
 */
SettingsSchema.toJSON = function toJSON() {
  return JSON.parse(JSON.stringify(SCHEMA_ENVELOPE))
}

/**
 * Validate one section without applying a default.
 *
 * @param value - raw section value.
 * @returns the normalized value, or undefined when invalid.
 */
SettingsSchema.validate = normalize

/**
 * Standard Schema interface, implemented the same way Schemastery does, so a
 * consumer reading `~standard` gets the same answer as a caller invoking the
 * schema directly.
 */
SettingsSchema['~standard'] = {
  version: 1,
  vendor: 'dsh-desktop',
  /**
   * Validate one value.
   *
   * @param input - raw section value.
   * @returns success with the normalized value, or the issues that rejected it.
   */
  validate(input) {
    const result = normalize(input)
    if (result === undefined) {
      // Name the field that actually failed rather than listing all five, so
      // the message stays as specific as a compiled schema's.
      const raw = input !== null && typeof input === 'object' ? input : {}
      const badComposer = [...COMPOSER_TUNING_FIELDS, ...DIALOG_TUNING_FIELDS].find(field => raw[field] !== undefined && normalize({ [field]: raw[field] }) === undefined)
      if (badComposer) return { issues: [{ message: badComposer + ' must be a number between 0 and 100', path: [badComposer] }] }
      const badBackground = Object.keys(BACKGROUND_FIELDS).find(field => raw[field] !== undefined && normalize({ [field]: raw[field] }) === undefined)
      if (badBackground) return { issues: [{ message: badBackground + ' contains an invalid background setting', path: [badBackground] }] }
      const fieldValues = [
        [COLOR_SCHEME_FIELD, COLOR_SCHEMES],
        [UI_MODE_FIELD, UI_MODES],
        [FONT_SIZE_OVERRIDE_FIELD, FONT_SIZE_OVERRIDES],
        [TITLEBAR_MODE_FIELD, TITLEBAR_MODES],
        [TITLEBAR_HOVER_FIELD, TITLEBAR_HOVER_PREFERENCES],
        [COMPOSER_MATERIAL_FIELD, COMPOSER_MATERIALS],
        [DIALOG_MATERIAL_FIELD, COMPOSER_MATERIALS],
        [REASONING_CONTROL_FIELD, REASONING_CONTROLS],
        [ANIMATION_FIELD, ANIMATION_PREFERENCES],
      ]
      const failed = fieldValues.find(
        ([field, accepted]) => raw[field] !== undefined && !accepted.includes(raw[field]),
      )
      const [field, accepted] = failed ?? [ANIMATION_FIELD, ANIMATION_PREFERENCES]
      return {
        issues: [
          {
            message: field + ' must be one of: ' + accepted.join(', '),
            path: [field],
          },
        ],
      }
    }
    return { value: result }
  },
}

/**
 * Register the namespace.
 *
 * The settings service may mount after this row, so it is acquired with
 * `ctx.inject` rather than required — a composition without settings (the
 * headless surfaces) then simply does not register it.
 *
 * @param ctx - host context.
 */
function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SettingsSchema)
  })
}

export {
  COLOR_SCHEME_FIELD,
  COLOR_SCHEMES,
  ANIMATION_FIELD,
  ANIMATION_PREFERENCES,
  DEFAULT_ANIMATION,
  DEFAULT_TITLEBAR_HOVER,
  DEFAULT_TITLEBAR_MODE,
  DEFAULT_UI_MODE,
  FONT_SIZE_OVERRIDES,
  FONT_SIZE_OVERRIDE_FIELD,
  NAMESPACE,
  SCHEMA_ENVELOPE,
  SettingsSchema,
  TITLEBAR_HOVER_FIELD,
  TITLEBAR_HOVER_PREFERENCES,
  TITLEBAR_MODE_FIELD,
  TITLEBAR_MODES,
  UI_MODES,
  UI_MODE_FIELD,
  apply,
  inject,
  name,
  normalize,
}
