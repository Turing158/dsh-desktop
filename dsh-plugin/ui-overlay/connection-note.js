/* On-page diagnosis for the LAN page's failed session list.
 *
 * A phone opens the same served page as the desktop, and its sidebar session
 * list loads over same-origin /api RPCs. Four different failures look
 * identical there — the upstream connection pill only reports "disconnected":
 *
 *   403   the Host this page was opened under is not trusted by the /api
 *         fence: a typed hostname instead of the QR's IP, or a name that
 *         stopped being whitelisted. Only the desktop can fix it.
 *   401   the login is spent: every DSH process start mints a fresh launch
 *         token, so a saved link stops authorizing after any restart.
 *   error the computer is unreachable — sleep, firewall, client isolation,
 *         or the restart that applying a remote-control change performs.
 *   stall THE QUIET ONE: every HTTP request answers, the shell paints, and the
 *         lists still never arrive. The Workspaces and Sessions are carried by
 *         Remote streams on one multiplexed WebSocket, opened by
 *         `@deepseek-ai/dsh-api-gateway/client` through `AbortSignal` and
 *         `Promise.withResolvers` calls it never feature-tests — so a phone
 *         browser whose engine lacks one of them gets a page that looks healthy
 *         while its data never comes. Nothing on screen says so, and the HTTP
 *         probe above says `ok`, which is why this note must be able to tell
 *         "reachable" from "reachable AND delivering".
 *
 * This note walks the exact ladder the session RPCs walk — trust fence, then
 * browser auth, then the route dispatcher, which 404s an unknown path — by
 * POSTing to a reserved unknown /api path, and states the fix that applies. The
 * channel half watches the page's own WebSockets for a frame: no frame within
 * {@link STALL_MS} of a page that is up is the stall, and the diagnosis names
 * the engine APIs the page had to shim (`window.__DSH_ENGINE__`, published by
 * `browser-compat.js`) so the same report never has to be guessed again. Both
 * halves are also written to `~/.dsh/desktop-diag.log`: a phone has no console
 * anybody reads.
 *
 * It removes itself when the probe recovers, so a restart (during which every
 * request rejects) explains itself and clears without a reload.
 *
 * The probe is a plain same-origin fetch: cookies ride along by default and
 * `no-store` keeps any cache from answering for the server. It creates no
 * form controls, so the desktop's snapshot form-coverage audit never sees it.
 */
;(function () {
  'use strict'

  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
  if (window.top !== window) return
  if (typeof fetch !== 'function') return

  /** Under /api so the request meets the same fence and auth as the session list. */
  const PROBE_PATH = '/api/__dsh-desktop/connection-note'
  /** Slow heartbeat: catches mid-session failures (network switch, whitelist edit). */
  const POLL_MS = 15000
  /* How long a page that is up may go without ONE frame on its own realtime
   * channel before that silence is the diagnosis. The app mounts, fetches its
   * bundle and opens the multiplexed socket well inside this window; measured on
   * a real LAN page, the first frames arrive in about a second
   * (tools/phone-workspace-list-probe.mjs). */
  const STALL_MS = 12000
  /** The build marker on every diagnostics line, as the overlay rows carry. */
  const DIAG_VERSION = 'connection-note-diag1'
  const NOTE_ID = 'dsh-connection-note'
  const STYLE_ID = 'dsh-connection-note-style'
  /* Self-contained styling: functional, so it must render in 原版 mode and in
   * a plain browser where the overlay's theme.css never applies. */
  const STYLE_TEXT = '#' + NOTE_ID + '{position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;gap:10px;align-items:baseline;padding:8px 12px;background:#7c2d24;color:#fff;font-size:12px;line-height:19px;box-shadow:0 1px 6px rgba(0,0,0,.28)}#' + NOTE_ID + ' .dshConn__text{flex:1;min-width:0}#' + NOTE_ID + ' .dshConn__close{flex:none;border:0;border-radius:6px;background:rgba(255,255,255,.16);color:#fff;font:inherit;font-size:12px;line-height:19px;padding:0 8px;cursor:pointer}#' + NOTE_ID + ' .dshConn__close:hover{background:rgba(255,255,255,.28)}'

  /**
   * Map one probe response status to a diagnosis. Any status the route
   * dispatcher can produce (2xx–499 except 401/403) means fence and login
   * both passed — the unknown path merely 404s, which is the healthy answer.
   * @param status - HTTP status of the probe response.
   * @returns `ok`, `untrusted`, `unauthenticated`, or `unreachable`.
   */
  function classify(status) {
    if (status === 403) return 'untrusted'
    if (status === 401) return 'unauthenticated'
    if (status >= 200 && status < 500) return 'ok'
    return 'unreachable'
  }

  /**
   * The actionable text for one diagnosis. The host is named so the user can
   * paste it into the desktop whitelist without reading the address bar.
   * @param kind - one of {@link classify}'s non-ok values, or `stalled`.
   * @param host - the page's host authority, from `location.host`.
   * @param facts - `{ missing, absent }` from {@link engineFacts}, optionally.
   */
  function message(kind, host, facts) {
    if (kind === 'untrusted') return t('当前访问地址 ') + host + t(' 不在电脑 设置 → 远程控制 的 Host 白名单中，会话列表无法加载。请在电脑上把 ') + host + t(' 加入白名单并重新应用；或改用设置中二维码里的 IP 地址访问。手机端无法自行解除。')
    if (kind === 'unauthenticated') return t('登录已失效：每次重启 DSH 都会更换访问链接。请在电脑 设置 → 远程控制 重新复制完整链接或扫码打开。')
    if (kind === 'stalled') {
      // The API names are diagnostic, not actionable — what a user can do is
      // reload, or open another browser — so the note counts the gaps it closed,
      // says whether anything is left that it CANNOT close, and points at the log,
      // while `/__dsh-desktop/diag` carries both lists in full.
      const closed = facts?.missing?.length ? t('这台手机的浏览器引擎缺少 ') + facts.missing.length + t(' 个较新的 API（') + facts.missing.slice(0, 3).join('、') + (facts.missing.length > 3 ? t(' 等') : '') + t('），页面已自行补齐。') : ''
      const open = facts?.absent?.length ? t('另有 ') + facts.absent.length + t(' 个较新的 API 本页无法补齐。') : ''
      return t('已连上电脑，但实时通道没有收到任何数据，所以工作区与会话列表一直是空的。') + closed + open + t('请下拉刷新页面；若仍然为空，请升级手机系统或改用其它浏览器打开。诊断详情已写入电脑的 ~/.dsh/desktop-diag.log。')
    }
    return t('暂时连不上电脑，会话列表无法加载。请确认手机与电脑在同一网络、电脑已开机且未休眠；反复失败时检查防火墙与路由器设备隔离。')
  }

  /**
   * The engine facts this page can offer, from `window.__DSH_ENGINE__`.
   *
   * `missing` is what `browser-compat.js` shimmed (so the page may claim to have
   * closed it), `absent` is what is STILL unavailable — an API nobody shimmed,
   * which is how the two reports before this one looked from the inside. Both are
   * sent to the log, because a phone has no console anybody reads.
   * @returns `{ missing, absent }`, each an array of names.
   */
  function engineFacts() {
    const names = (value) => (Array.isArray(value) ? value.map(String) : [])
    try {
      const report = window.__DSH_ENGINE__
      return { missing: names(report?.missing), absent: names(report?.absent) }
    } catch {
      return { missing: [], absent: [] }
    }
  }

  /**
   * Watch the page's own realtime channel for a frame.
   *
   * WHY THE SOCKET AND NOT THE UI. Every list on this page arrives on ONE
   * multiplexed WebSocket; whether its frames ever arrive is the difference
   * between "this phone cannot load lists" and "this page is fine". Reading the
   * sidebar DOM instead would depend on the frontend's markup and on the user
   * having opened the drawer.
   *
   * No path is matched: any same-origin socket that delivers a frame proves the
   * channel works, so an upstream rename cannot turn this into a false alarm.
   * `WebSocket` is wrapped defensively — the wrapper returns the NATIVE instance
   * and keeps the native prototype, so `instanceof`, `.send` and the readyState
   * constants behave exactly as before, and a page whose WebSocket cannot be
   * wrapped simply reports "nothing observed" rather than breaking.
   */
  const channel = { sockets: 0, opened: 0, frames: 0 }

  function watchChannel() {
    const Native = window.WebSocket
    if (typeof Native !== 'function' || Native.prototype === undefined) return
    function Observed(url, protocols) {
      const socket = protocols === undefined ? new Native(url) : new Native(url, protocols)
      channel.sockets++
      try {
        socket.addEventListener('open', () => { channel.opened++ })
        socket.addEventListener('message', () => { channel.frames++ })
      } catch {
        /* A socket that cannot be observed is still the socket the page gets. */
      }
      return socket
    }
    try {
      Observed.prototype = Native.prototype
      for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        if (Native[name] !== undefined) Observed[name] = Native[name]
      }
      window.WebSocket = Observed
    } catch {
      /* Frozen or non-configurable WebSocket: leave the page's own alone. */
    }
  }

  watchChannel()

  /** The clock, indirected so the tests can move it; the page reads the real one. */
  let now = () => Date.now()

  /** When this page's channel observation started; the stall clock runs from it. */
  const startedAt = now()

  /** Whether ANY socket observed on this page has received a frame. */
  function delivering() { return channel.frames > 0 }

  /**
   * Turn one probe outcome plus the channel's state into a diagnosis.
   *
   * The HTTP ladder decides everything it can; only when it says `ok` does the
   * channel get a vote, and only after {@link STALL_MS}. `observation` exists for
   * the tests — the page reads the real clock and the real counters.
   *
   * @param kind - one of {@link classify}'s values.
   * @param observation - optional `{ delivered, elapsedMs }` override.
   * @returns `ok`, or the diagnosis to show.
   */
  function diagnose(kind, observation) {
    if (kind !== 'ok') return kind
    const facts = observation ?? { delivered: delivering(), elapsedMs: now() - startedAt }
    if (facts.delivered) return 'ok'
    return facts.elapsedMs >= STALL_MS ? 'stalled' : 'ok'
  }

  /**
   * Append one diagnostics line to the host's log, via `/__dsh-desktop/diag`.
   *
   * Same fire-and-forget contract as the overlay's own reporter: a missing route,
   * a refused request or a failing body is swallowed, because diagnostics must
   * never become the failure they exist to record.
   *
   * @param payload - the facts about one observation.
   */
  function reportDiag(payload) {
    try {
      const body = JSON.stringify(Object.assign({ v: DIAG_VERSION, at: new Date().toISOString(), source: 'phone' }, payload))
      fetch('/__dsh-desktop/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }).catch(() => {})
    } catch {
      /* Nothing to log with, nothing to log. */
    }
  }

  async function probe() {
    try {
      const response = await fetch(PROBE_PATH, { method: 'POST', cache: 'no-store' })
      return classify(response.status)
    } catch {
      return 'unreachable'
    }
  }

  /** The rendered note, or null when absent — removed elements stay removed. */
  function note() { return document.getElementById(NOTE_ID) }

  /** The diagnosis the user closed; only the same one stays closed. */
  let dismissed = null

  /** Remove the note and re-arm dismissal: a recovered page is a clean slate. */
  function hide() {
    dismissed = null
    const el = note()
    if (el) el.remove()
  }

  let textEl = null, closeEl = null

  /**
   * Render one diagnosis. The element is created once and re-labelled in
   * place, so a diagnosis that changes (whitelist applied, then the desktop
   * restarts) rewrites the same banner instead of stacking them.
   * @param kind - one of {@link classify}'s non-ok values.
   */
  function render(kind) {
    let el = note()
    if (!el) {
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE_TEXT
        ;(document.head || document.documentElement).appendChild(style)
      }
      el = document.createElement('div')
      el.id = NOTE_ID
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      textEl = document.createElement('span')
      textEl.className = 'dshConn__text'
      const close = closeEl = document.createElement('button')
      close.type = 'button'
      close.className = 'dshConn__close'
      close.textContent = t('知道了')
      close.setAttribute('aria-label', t('关闭连接提示'))
      close.addEventListener('click', () => {
        dismissed = el.getAttribute('data-dsh-connection-note')
        el.remove()
      })
      el.appendChild(textEl)
      el.appendChild(close)
      document.body.appendChild(el)
    }
    const close = closeEl
    close.textContent = t('知道了')
    close.setAttribute('aria-label', t('关闭连接提示'))
    el.setAttribute('data-dsh-connection-note', kind)
    textEl.textContent = message(kind, window.location.host, engineFacts())
  }

  /**
   * Apply one diagnosis: clear on recovery, keep a dismissed diagnosis
   * dismissed, and surface any other diagnosis — a change of failure is new
   * information the user has not seen.
   * @param outcome - a diagnosis from {@link diagnose}.
   */
  document.addEventListener('dsh-desktop:locale', () => {
    const current = note()?.getAttribute('data-dsh-connection-note')
    if (current) render(current)
  })

  function evaluate(outcome) {
    if (outcome === 'ok') { hide(); return }
    if (outcome === dismissed) return
    dismissed = null
    render(outcome)
  }

  /** A stall is reported at most once per page load: it cannot change by polling. */
  let stallReported = false

  function reportStall(elapsedMs) {
    if (stallReported) return
    stallReported = true
    const facts = engineFacts()
    reportDiag({
      kind: 'stall',
      host: window.location.host,
      href: window.location.pathname,
      elapsedMs: elapsedMs,
      sockets: channel.sockets,
      opened: channel.opened,
      frames: channel.frames,
      missing: facts.missing,
      absent: facts.absent,
      userAgent: (() => {
        try {
          return String(window.navigator?.userAgent ?? '')
        } catch {
          return ''
        }
      })(),
    })
  }

  async function refresh() {
    const kind = await probe()
    const elapsedMs = now() - startedAt
    const outcome = diagnose(kind, { delivered: delivering(), elapsedMs })
    if (outcome === 'stalled') reportStall(elapsedMs)
    evaluate(outcome)
  }

  /**
   * Report the engine facts once per page load, BEFORE the lists have a chance to
   * fail: a phone whose engine needed shims is exactly the phone whose lists used
   * to arrive empty, and the desktop log is the only place that fact can survive
   * (the phone has no console anybody reads). A page whose engine lacked nothing
   * writes nothing — the log stays a record of exceptions.
   */
  function reportEngine() {
    const facts = engineFacts()
    if (!facts.missing.length && !facts.absent.length) return
    reportDiag({ kind: 'engine', host: window.location.host, missing: facts.missing, absent: facts.absent })
  }

  function start() {
    reportEngine()
    refresh()
    setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh() })
  }

  // Head placement: the document is still loading when this runs, so the note
  // waits for the body to exist rather than racing the parser.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  /** Inspection seam for the plugin tests; nothing on the page reads it. */
  window.__DSH_CONNECTION_NOTE__ = {
    classify,
    message,
    probe,
    evaluate,
    diagnose,
    engineFacts,
    reportDiag,
    channel,
    startedAt,
    stallAfterMs: STALL_MS,
    /** Move the page's clock; a test seam, never read by the page. */
    setClock(fn) { now = fn },
  }
})()
