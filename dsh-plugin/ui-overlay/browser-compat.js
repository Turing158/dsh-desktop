/* DSH uses getRandomValues on HTTP; changes and terminal tabs also need UUIDs.
 * This injected script is shared by desktop and ordinary browsers.
 *
 * It carries four things, in this order:
 *
 *   1. engine shims — the newest standards APIs the served client bundles call
 *      without feature-detecting them (see the section below);
 *   2. the LAN-HTTP UUID repair for desktop and remote pages;
 *   3. `window.__DSH_ENGINE__`, the list of APIs this engine was missing, for the
 *      phone-side diagnostics;
 *   4. the mobile viewport metric a phone needs while its keyboard is open. */
;(function () {
  'use strict'
  if (window.top !== window) return

  // ── Engine shims ───────────────────────────────────────────────────────────
  // The served client bundles are built against engines of the day and call the
  // newest standards APIs directly. This page is served to phones as well as to
  // this window, and an engine that has not shipped one of them does not
  // degrade — the plugin never loads, and the loader prints
  //
  //   Failed to load plugins
  //   failed to import loader entry … Can't find variable: Iterator
  //
  // and no plugin mounts at all. That report came from a phone.
  //
  // THERE IS NO BOOT FLOOR, ONLY THE BUNDLES' OWN CALLS. An earlier version of
  // this block read upstream's trailing
  // `(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()` as
  // proof that an engine without `Promise.withResolvers` cannot render the page,
  // and left everything "below" it unshimmed. That is false, and measurement is
  // what says so (tools/phone-workspace-list-probe.mjs): with
  // `Promise.withResolvers` deleted from an otherwise capable engine the shell
  // still paints — the throw stays inside that one inline script, and nothing the
  // app renders awaits it. What DOES break is the first unshimmed API on a real
  // path, and on such an engine the page then looks healthy while its data never
  // arrives.
  //
  // So the rule is the calls themselves: everything the served bundles reference
  // without a feature test above the oldest engine that can render this document
  // (ES2020 syntax, `WeakRef`, `??=` — i.e. any engine of the last few years) is
  // shimmed here. Scanning every served `dsh-client-*` bundle's real code (not
  // its embedded type text) yields exactly this set: pdf.js 6.3.289 in
  // `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`, plus — and this is the
  // part the earlier version missed — the client-side API gateway that carries
  // EVERY list on the page, `@deepseek-ai/dsh-api-gateway/client`.

  /**
   * Install the standards APIs this engine may not have. Returns whether anything
   * was installed, which is what gates the worker half below.
   *
   * SELF-CONTAINED BY CONTRACT: its source text is shipped into worker realms by
   * `installBlobScriptShim`, so it must not reference anything outside itself —
   * an outer helper or constant would reach the worker as a ReferenceError and
   * leave the shim half-installed there. The optional `installedNames` array is a
   * parameter rather than a captured value for that reason, and the worker seam
   * simply calls the function without one.
   *
   * @param scope - the realm to shim (`globalThis` of the page or a worker).
   * @param installedNames - optional collector; receives one name per API this
   *   engine was actually missing. The page publishes it as
   *   `window.__DSH_ENGINE__` so the phone-side diagnostics can name the gap in
   *   `desktop-diag.log` instead of leaving a page that merely shows nothing.
   * @returns whether anything was installed.
   */
  function installEngineShims(scope, installedNames) {
    let installed = false
    const record = (name) => {
      if (installedNames !== undefined) installedNames.push(name)
    }

    // Iterator (the iterator-helpers API). pdf.js 6.3.289 opens a module of its
    // display layer with an UNGUARDED read:
    //
    //   if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join = …
    //
    // On an engine with no `Iterator` global that is not a failed feature test,
    // it is a ReferenceError at import time — and WebKit spells exactly that
    // "Can't find variable: Iterator", which is the phone's error. The same
    // statement appears again in the worker the document-preview plugin builds
    // from a string, which is why the worker realm needs it too
    // (see `installBlobScriptShim`).
    //
    // `prototype` is the realm's REAL %IteratorPrototype% — the object every
    // built-in iterator already inherits from — because pdf.js's own `join`
    // polyfill has to land on THAT object to reach the iterators it is used on.
    // A fresh object here would turn the assignment into a silent no-op and
    // pdf.js would fail later, somewhere else. Only the constructor is installed:
    // `join` is the one helper pdf.js wants and it installs that itself, and no
    // served bundle uses any other.
    if (typeof scope.Iterator === 'undefined') {
      let prototype = null
      try {
        prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
      } catch {
        // No derivable iterator prototype: the fallback below still gives pdf.js
        // something to assign onto, and nothing here may throw out of the row.
      }
      if (prototype === null || typeof prototype !== 'object') prototype = {}
      const Iterator = function Iterator() {
        throw new TypeError('Iterator is not directly constructable')
      }
      Object.defineProperty(Iterator, 'prototype', {
        value: prototype,
        writable: false,
        enumerable: false,
        configurable: false,
      })
      scope.Iterator = Iterator
      record('Iterator')
      installed = true
    }

    // Promise.try. pdf.js runs every worker callback through it, so it is on the
    // PDF path, not a corner. The callback is invoked synchronously inside the
    // executor, which is what makes a throw reject rather than escape.
    if (typeof scope.Promise.try !== 'function') {
      Object.defineProperty(scope.Promise, 'try', {
        configurable: true,
        writable: true,
        value: function try_(callback, ...args) {
          return new scope.Promise((resolve) => {
            resolve(callback(...args))
          })
        },
      })
      record('Promise.try')
      installed = true
    }

    // Math.sumPrecise. pdf.js sums glyph sizes and stream lengths with it, and it
    // shipped later than everything else here. Neumaier compensated summation
    // answers every case in the corpus `tools/engine-shim-probe.mjs` compares
    // against Chromium's native implementation — including the two that defeat a
    // naive running total: a cancellation across magnitudes (`[1e100, 1, -1e100]`
    // is 1, not 0) and an intermediate overflow (`[1e308, 1e308, -1e308]` is NaN
    // there as well, because neither engine can recover a finite total from an
    // infinite intermediate — the mathematically exact total, 1e308, is not what
    // either of them answers).
    //
    // NOT CLAIMED: exactness for arbitrary inputs. Compensated summation is not
    // provably the exactly-rounded sum in general; pdf.js never asks it to be,
    // because what it sums are lengths.
    //
    // A non-finite input switches to plain addition: once the running total is
    // ±Infinity, or has absorbed a NaN, compensation itself produces NaN
    // (Infinity - Infinity), while IEEE addition already answers what the
    // specification asks for — NaN for a NaN, ±Infinity for a single infinity.
    if (typeof scope.Math.sumPrecise !== 'function') {
      Object.defineProperty(scope.Math, 'sumPrecise', {
        configurable: true,
        writable: true,
        value: function sumPrecise(numbers) {
          // -0, and `seen` only so an empty list can return it: Chromium answers
          // `Math.sumPrecise([])` with -0, and normalises to +0 the moment any
          // value is added (`[-0]` and `[0]` are both +0). Measured, not guessed —
          // `tools/engine-shim-probe.mjs` compares this case with the native one.
          let sum = -0
          let compensation = 0
          let precise = true
          let seen = false
          for (const number of numbers) {
            if (typeof number !== 'number') {
              throw new TypeError('Math.sumPrecise: the argument must be an iterable of numbers')
            }
            seen = true
            if (!Number.isFinite(number)) {
              precise = false
              compensation = 0
            }
            if (!precise) {
              sum += number
              continue
            }
            const next = sum + number
            compensation += Math.abs(sum) >= Math.abs(number) ? sum - next + number : number - next + sum
            sum = next
          }
          if (!precise) return sum
          return seen ? sum + compensation : sum
        },
      })
      record('Math.sumPrecise')
      installed = true
    }

    // Promise.withResolvers. NOT a boot requirement — see the block comment on
    // this section — but a real one on three paths: the client's own
    // `ctx.timeout()`/`ctx.interval()` (`@deepseek-ai/dsh-cordis-client-runner`),
    // the approval and user-question prompts that park a promise until the user
    // answers, and pdf.js's worker plumbing.
    //
    // `this` rather than `scope.Promise` because the method is inherited by
    // subclasses, exactly as the standard's is; the executor runs synchronously,
    // so resolve/reject are always assigned before the capability is returned.
    if (typeof scope.Promise.withResolvers !== 'function') {
      Object.defineProperty(scope.Promise, 'withResolvers', {
        configurable: true,
        writable: true,
        value: function withResolvers() {
          const capability = {}
          capability.promise = new this((resolve, reject) => {
            capability.resolve = resolve
            capability.reject = reject
          })
          return capability
        },
      })
      record('Promise.withResolvers')
      installed = true
    }

    // AbortSignal.prototype.throwIfAborted. THE transport API on this list: the
    // client-side API gateway walks every Remote stream with
    //
    //   signal.throwIfAborted()
    //   for await (const value of this.options.open(signal)) { … }
    //
    // (10 unguarded calls in `@deepseek-ai/dsh-api-gateway/client`, 5 more in
    // `dsh-client-connection`). On an engine without it the stream rejects, the
    // multiplexed socket never delivers a baseline, and every list the gateway
    // feeds — the sidebar's Workspaces and Sessions, the Session Intent picker,
    // the archive set — stays on its loading state for the life of the page. No
    // error surface: `signal.throwIfAborted is not a function` reaches the
    // console and nothing else. Measured: deleting it reproduces exactly that,
    // and re-installing it is what makes the list arrive
    // (tools/phone-workspace-list-probe.mjs).
    //
    // The default reason is the spec's AbortError, spelled out for engines that
    // predate `signal.reason`: throwing `undefined` there would turn an ordinary
    // navigation abort into a bogus stream failure.
    if (typeof scope.AbortSignal === 'function' && typeof scope.AbortSignal.prototype.throwIfAborted !== 'function') {
      Object.defineProperty(scope.AbortSignal.prototype, 'throwIfAborted', {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function throwIfAborted() {
          if (!this.aborted) return
          const reason = this.reason
          if (reason !== undefined) throw reason
          const abortError = typeof scope.DOMException === 'function'
            ? new scope.DOMException('This operation was aborted', 'AbortError')
            : new Error('This operation was aborted')
          abortError.name = 'AbortError'
          throw abortError
        },
      })
      record('AbortSignal.prototype.throwIfAborted')
      installed = true
    }

    // AbortSignal.any. The gateway fuses caller cancellation with a lifetime
    // signal on every stream it opens, and the workspace UI fuses its navigation
    // token the same way, so this is the same failure as above on an engine that
    // has `throwIfAborted` but not this one.
    //
    // Faithful to the standard where the parts exist: an already-aborted input
    // aborts the result immediately with THAT signal's reason, otherwise the
    // returned signal aborts with the first input that does. Inputs are admitted
    // as a whole before any listener is attached, so a bad element throws without
    // leaving half a fuse behind.
    //
    // KNOWN DIVERGENCE, and the reason it is acceptable: the standard lets a
    // source signal drop a composite nobody references any more (its abort
    // algorithm holds the composite weakly), which needs internal slots no script
    // can reach. This shim therefore leaves one `{ once: true }` listener per input
    // until that input aborts. The gateway fuses ONCE per stream it opens, not per
    // frame, so the cost is one listener per stream — and the alternative to the
    // leak is no fused signal at all, which is the stall this shim exists to end.
    if (
      typeof scope.AbortSignal === 'function' &&
      typeof scope.AbortSignal.any !== 'function' &&
      typeof scope.AbortController === 'function'
    ) {
      Object.defineProperty(scope.AbortSignal, 'any', {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function any(signals) {
          if (signals === null || signals === undefined || typeof signals[Symbol.iterator] !== 'function') {
            throw new TypeError('AbortSignal.any: the argument must be an iterable of AbortSignal')
          }
          const controller = new scope.AbortController()
          const list = []
          for (const signal of signals) {
            if (!(signal instanceof scope.AbortSignal)) {
              throw new TypeError('AbortSignal.any: every element must be an AbortSignal')
            }
            list.push(signal)
          }
          for (const signal of list) {
            if (signal.aborted) {
              controller.abort(signal.reason)
              return controller.signal
            }
          }
          for (const signal of list) {
            signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
          }
          return controller.signal
        },
      })
      record('AbortSignal.any')
      installed = true
    }

    // Uint8Array base64 and hex codecs. pdf.js decodes font signatures with
    // fromBase64, writes a font back out with toBase64, and fingerprints a
    // document with toHex — all three called natively, none feature-detected.
    // fromHex is installed with them so the family is whole rather than three
    // quarters of one; nothing served calls it today.
    //
    // ONLY THE DEFAULT PATH IS IMPLEMENTED, and a caller that asks for another
    // (`alphabet`, `lastChunkHandling`, `omitPadding`) gets a TypeError instead of
    // an answer computed for different options. No served bundle passes one, so a
    // loud refusal cannot be hit from the page — while silently ignoring the
    // option would be a wrong answer waiting to be trusted.
    if (
      typeof scope.Uint8Array.fromBase64 !== 'function' ||
      typeof scope.Uint8Array.fromHex !== 'function' ||
      typeof scope.Uint8Array.prototype.toBase64 !== 'function' ||
      typeof scope.Uint8Array.prototype.toHex !== 'function'
    ) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      const hexadecimal = '0123456789abcdef'
      const values = (() => {
        const table = new Int8Array(128).fill(-1)
        for (let index = 0; index < alphabet.length; index++) table[alphabet.charCodeAt(index)] = index
        return table
      })()
      const whitespace = (code) => code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20
      const receiverOf = (receiver) => {
        if (!(receiver instanceof scope.Uint8Array)) {
          throw new TypeError('Uint8Array.prototype.toBase64/toHex: the receiver must be a Uint8Array')
        }
        return receiver
      }

      if (typeof scope.Uint8Array.fromBase64 !== 'function') {
        Object.defineProperty(scope.Uint8Array, 'fromBase64', {
          configurable: true,
          writable: true,
          value: function fromBase64(string, options) {
            const settings = options === undefined || options === null ? {} : Object(options)
            if (settings.alphabet !== undefined && settings.alphabet !== 'base64') {
              throw new TypeError('Uint8Array.fromBase64: only the base64 alphabet is implemented')
            }
            if (settings.lastChunkHandling !== undefined && settings.lastChunkHandling !== 'loose') {
              throw new TypeError('Uint8Array.fromBase64: only the loose last-chunk handling is implemented')
            }
            if (typeof string !== 'string') throw new TypeError('Uint8Array.fromBase64: the argument must be a string')
            const digits = []
            let padding = 0
            for (const character of string) {
              const code = character.charCodeAt(0)
              if (whitespace(code)) continue
              if (code === 0x3d) {
                padding++
                continue
              }
              if (padding !== 0) throw new SyntaxError('Uint8Array.fromBase64: padding must be at the end')
              const value = code < 128 ? values[code] : -1
              if (value < 0) throw new SyntaxError('Uint8Array.fromBase64: invalid base64 character')
              digits.push(value)
            }
            if (padding > 2) throw new SyntaxError('Uint8Array.fromBase64: too much padding')
            const remainder = digits.length % 4
            // A lone digit cannot start a byte, and padding may only complete the
            // final chunk — 2 digits take 2 '=', 3 digits take 1. Missing padding
            // is allowed (that is what "loose" means); extra bits are ignored.
            if (remainder === 1) throw new SyntaxError('Uint8Array.fromBase64: incomplete final chunk')
            if (padding !== 0 && remainder !== 4 - padding) {
              throw new SyntaxError('Uint8Array.fromBase64: unexpected padding')
            }
            const full = digits.length - remainder
            const bytes = new scope.Uint8Array((full / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0))
            let at = 0
            for (let index = 0; index < full; index += 4) {
              const chunk =
                (digits[index] << 18) | (digits[index + 1] << 12) | (digits[index + 2] << 6) | digits[index + 3]
              bytes[at++] = chunk >> 16
              bytes[at++] = (chunk >> 8) & 0xff
              bytes[at++] = chunk & 0xff
            }
            if (remainder === 2) {
              bytes[at] = (digits[full] << 2) | (digits[full + 1] >> 4)
            } else if (remainder === 3) {
              const chunk = (digits[full] << 10) | (digits[full + 1] << 4) | (digits[full + 2] >> 2)
              bytes[at] = chunk >> 8
              bytes[at + 1] = chunk & 0xff
            }
            return bytes
          },
        })
        record('Uint8Array.fromBase64')
        installed = true
      }

      if (typeof scope.Uint8Array.fromHex !== 'function') {
        Object.defineProperty(scope.Uint8Array, 'fromHex', {
          configurable: true,
          writable: true,
          value: function fromHex(string) {
            if (typeof string !== 'string') throw new TypeError('Uint8Array.fromHex: the argument must be a string')
            // Hex, unlike base64, does NOT skip ASCII whitespace — measured
            // against Chromium, which throws for " ff 00\n10 ". Digits only, and
            // an even number of them.
            const digits = []
            for (const character of string) {
              const code = character.charCodeAt(0)
              const digit =
                code >= 0x30 && code <= 0x39
                  ? code - 0x30
                  : code >= 0x61 && code <= 0x66
                    ? code - 0x57
                    : code >= 0x41 && code <= 0x46
                      ? code - 0x37
                      : -1
              if (digit < 0) throw new SyntaxError('Uint8Array.fromHex: invalid hexadecimal character')
              digits.push(digit)
            }
            if (digits.length % 2 !== 0) throw new SyntaxError('Uint8Array.fromHex: an even number of digits is required')
            const bytes = new scope.Uint8Array(digits.length / 2)
            for (let index = 0; index < bytes.length; index++) {
              bytes[index] = (digits[index * 2] << 4) | digits[index * 2 + 1]
            }
            return bytes
          },
        })
        record('Uint8Array.fromHex')
        installed = true
      }

      if (typeof scope.Uint8Array.prototype.toBase64 !== 'function') {
        Object.defineProperty(scope.Uint8Array.prototype, 'toBase64', {
          configurable: true,
          writable: true,
          enumerable: false,
          value: function toBase64(options) {
            const settings = options === undefined || options === null ? {} : Object(options)
            if (settings.alphabet !== undefined && settings.alphabet !== 'base64') {
              throw new TypeError('Uint8Array.prototype.toBase64: only the base64 alphabet is implemented')
            }
            if (settings.omitPadding !== undefined && settings.omitPadding !== false) {
              throw new TypeError('Uint8Array.prototype.toBase64: omitting padding is not implemented')
            }
            const bytes = receiverOf(this)
            let text = ''
            for (let index = 0; index < bytes.length; index += 3) {
              const remaining = bytes.length - index
              const chunk =
                (bytes[index] << 16) |
                (remaining > 1 ? bytes[index + 1] << 8 : 0) |
                (remaining > 2 ? bytes[index + 2] : 0)
              text += alphabet[(chunk >> 18) & 63]
              text += alphabet[(chunk >> 12) & 63]
              text += remaining > 1 ? alphabet[(chunk >> 6) & 63] : '='
              text += remaining > 2 ? alphabet[chunk & 63] : '='
            }
            return text
          },
        })
        record('Uint8Array.prototype.toBase64')
        installed = true
      }

      if (typeof scope.Uint8Array.prototype.toHex !== 'function') {
        Object.defineProperty(scope.Uint8Array.prototype, 'toHex', {
          configurable: true,
          writable: true,
          enumerable: false,
          value: function toHex() {
            const bytes = receiverOf(this)
            let text = ''
            for (const byte of bytes) text += hexadecimal[byte >> 4] + hexadecimal[byte & 15]
            return text
          },
        })
        record('Uint8Array.prototype.toHex')
        installed = true
      }
    }

    // URL.parse. pdf.js's display layer resolves annotation, font and link URLs
    // with `URL.parse(value[, base])` and reads `null` as "not a usable absolute
    // URL" — a null-returning parser, not `new URL`, which throws. An engine that
    // has `new URL` but not this static leaves that path throwing on every call,
    // so it is shimmed for the same reason as the rest: unguarded, on a served
    // path, and answerable exactly.
    if (typeof scope.URL === 'function' && typeof scope.URL.parse !== 'function') {
      Object.defineProperty(scope.URL, 'parse', {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function parse(url, base) {
          try {
            return base === undefined ? new scope.URL(url) : new scope.URL(url, base)
          } catch {
            return null
          }
        },
      })
      record('URL.parse')
      installed = true
    }

    return installed
  }

  /**
   * Ship those shims into worker realms.
   *
   * A worker is its own realm: nothing installed on the page reaches it, and the
   * served bundles do build one. The document-preview plugin makes the pdf.js
   * worker from a string at runtime —
   *
   *   url = URL.createObjectURL(new Blob([workerSource, …], { type: "text/javascript" }))
   *   worker = new Worker(url, { type: "module", name: "dsh-pdf" })
   *
   * — and that worker's own copy of pdf.js repeats the unguarded `Iterator` read,
   * so without this the PDF path would still fail on the very engine that needed
   * the shims. `dsh-client-file-upload` builds a worker the same way.
   *
   * `URL.createObjectURL` is the one seam every such script passes through, and a
   * Blob part may itself be a Blob: the original source is never read, decoded or
   * copied, only prepended to, so a script of any size costs one extra wrapper.
   * Only javascript-typed blobs are touched, and only when this realm needed a
   * shim at all; the URL the caller is handed is the one it revokes, later,
   * exactly as before. Same-origin workers created from a URL are left alone —
   * no served bundle makes one, and rewriting a URL a server owns is not ours.
   */
  function installBlobScriptShim(scope, installer) {
    const createObjectURL = scope.URL?.createObjectURL
    const BlobClass = scope.Blob
    if (typeof createObjectURL !== 'function' || typeof BlobClass !== 'function') return
    const source = `;try{(${installer.toString()})(globalThis)}catch(error){}`
    // NOTE the inner name: a named function expression binds its own name INSIDE
    // its body, so calling `createObjectURL.call(…)` there would call the wrapper
    // again — infinite recursion that only shows up when a javascript blob is
    // actually created. The original is captured under a different name.
    scope.URL.createObjectURL = function dshEngineShimCreateObjectURL(blob) {
      try {
        if (blob instanceof BlobClass && typeof blob.type === 'string' && blob.type.includes('javascript')) {
          blob = new BlobClass([source, blob], { type: blob.type })
        }
      } catch (error) {
        // A blob this code cannot classify stays exactly as it was: refusing to
        // wrap is a missing shim in one worker, throwing here is a broken page.
      }
      return createObjectURL.call(scope.URL, blob)
    }
  }

  // A realm that already has every one of these installs nothing and is not
  // touched again — including this window, whose WebView2 is far ahead of them.
  //
  // What the engine was missing is published rather than kept: a phone whose
  // engine lacks one of these is exactly the page whose LISTS never arrive, with
  // nothing on screen to say so. `window.__DSH_ENGINE__` lets the phone-side
  // diagnostics name the gap in `~/.dsh/desktop-diag.log` (see
  // `ui-overlay/connection-note.js`) instead of the app degrading quietly.
  const missingEngineApis = []
  if (installEngineShims(globalThis, missingEngineApis)) installBlobScriptShim(globalThis, installEngineShims)

  /**
   * The newer standards APIs that are STILL absent once the shims have run.
   *
   * A fingerprint, not a requirement list: the two previous phone reports were
   * both "an API nobody shimmed", and each one cost a full round of guessing
   * because the page could only say that its lists were empty. Everything here is
   * reported whether or not this script installs it, so the next such report is
   * answered by `~/.dsh/desktop-diag.log` rather than by reproduction. Nothing in
   * this table changes any behaviour: it only asks the engine what it has.
   *
   * Computed AFTER the shims on purpose — the two lists together are the whole
   * story, and neither alone is: `missing` is what this page closed, `absent` is
   * what is still not there.
   */
  function absentEngineApis() {
    const present = {
      Iterator: () => typeof globalThis.Iterator === 'function',
      'Promise.try': () => typeof globalThis.Promise.try === 'function',
      'Promise.withResolvers': () => typeof globalThis.Promise.withResolvers === 'function',
      'Math.sumPrecise': () => typeof globalThis.Math.sumPrecise === 'function',
      'AbortSignal.prototype.throwIfAborted': () => typeof globalThis.AbortSignal?.prototype?.throwIfAborted === 'function',
      'AbortSignal.any': () => typeof globalThis.AbortSignal?.any === 'function',
      'AbortSignal.timeout': () => typeof globalThis.AbortSignal?.timeout === 'function',
      'Uint8Array.fromBase64': () => typeof globalThis.Uint8Array.fromBase64 === 'function',
      'Uint8Array.fromHex': () => typeof globalThis.Uint8Array.fromHex === 'function',
      'Uint8Array.prototype.toBase64': () => typeof globalThis.Uint8Array.prototype.toBase64 === 'function',
      'Uint8Array.prototype.toHex': () => typeof globalThis.Uint8Array.prototype.toHex === 'function',
      'URL.parse': () => typeof globalThis.URL?.parse === 'function',
      'URL.canParse': () => typeof globalThis.URL?.canParse === 'function',
      structuredClone: () => typeof globalThis.structuredClone === 'function',
      'Object.groupBy': () => typeof globalThis.Object.groupBy === 'function',
      'Map.groupBy': () => typeof globalThis.Map.groupBy === 'function',
      'Array.fromAsync': () => typeof globalThis.Array.fromAsync === 'function',
      'RegExp.escape': () => typeof globalThis.RegExp.escape === 'function',
      Float16Array: () => typeof globalThis.Float16Array === 'function',
      'Set.prototype.union': () => typeof globalThis.Set?.prototype?.union === 'function',
    }
    const absent = []
    for (const name of Object.keys(present)) {
      try {
        if (!present[name]()) absent.push(name)
      } catch {
        // An engine where the probe itself throws does not have the API.
        absent.push(name)
      }
    }
    return absent
  }

  window.__DSH_ENGINE__ = {
    missing: missingEngineApis,
    absent: absentEngineApis(),
    userAgent: (() => {
      try {
        return String(window.navigator?.userAgent ?? '')
      } catch {
        return ''
      }
    })(),
  }

  const browser = !window.__DSH_DESKTOP_BOOT_HOST__ && !window.__TAURI__?.core?.invoke
  // LAN HTTP omits randomUUID in both the WebView and remote browsers. Changes
  // tabs need it before they can open their resource and request the file list.
  // Keep the native crypto object and CSPRNG; supply only the missing UUID API.
  if (typeof window.crypto?.getRandomValues === 'function' && typeof window.crypto.randomUUID !== 'function') {
    Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value() {
      const bytes = window.crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 15) | 64
      bytes[8] = (bytes[8] & 63) | 128
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    } })
  }
  // THIS WINDOW OWNS THE HOST, AND MUST SAY SO. DSH decides whether a page gets
  // the Host-persistence settings namespace from one expression in
  // `dsh-client-connection`: `transport?.ownsHost === true || pageLocation ===
  // undefined || isLoopbackHostname(pageLocation.hostname)`. The official desktop
  // host sets `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, … }` before it
  // loads any client plugin, and that declaration is the only reason its window
  // counts as the host's own even when the address it is served from is not
  // loopback. This app has no such bootstrap — its window is an ordinary WebView2
  // document — so with remote control on (the backend bound to a LAN address, the
  // window therefore served from `http://<lan-ip>:<port>`) DSH classified the
  // desktop window as a genuinely remote browser: `persistence = "memory"`, the
  // describe mirror sits on `unavailable` for the page's life, and every surface
  // that reads it fails. The model page was the visible casualty ("加载提供方目录
  // 失败: settings are unavailable in this browser"), because it refuses to render
  // at all without a settings view; 通用设置's document store and this project's
  // terminal and appearance settings degrade the same way.
  //
  // The declaration is scoped by the SAME test the flag below uses, and that test
  // cannot be forged from off the machine: `window.__TAURI__` exists only in this
  // app's own WebView, so a phone or any other browser on the LAN keeps upstream's
  // memory-mode policy — which is upstream's deliberate answer for a genuinely
  // remote page, and the reason a remote page cannot write the host's
  // `settings.yaml`. A transport already installed (a future DSH desktop host, or
  // a page that supplies real carriers) is extended rather than replaced, and one
  // that cannot be extended is left alone: whatever installed it owns that
  // decision.
  if (!browser) {
    try {
      const transport = window.__DSH_TRANSPORT__
      const carrier = transport !== null && typeof transport === 'object' ? transport : {}
      carrier.ownsHost = true
      window.__DSH_TRANSPORT__ = carrier
    } catch {}
  }
  document.documentElement.toggleAttribute('data-dsh-browser', browser)
  if (!browser) return
  // iOS keeps vh/dvh tied to the layout viewport while the keyboard shrinks and
  // pans the visible viewport. Publish that rectangle directly; subtracting its
  // height from 100vh applies Safari's browser chrome/keyboard inset twice.
  let height, top
  const update = () => {
    const viewport = window.visualViewport
    const scale = viewport?.scale || 1
    const zoomed = Math.abs(scale - 1) > 0.01
    // Keep pinch zoom as browser magnification/panning, without reflowing the
    // app into the smaller zoomed rectangle or chasing the user's pan.
    if (zoomed && height !== undefined) return
    const nextHeight = (viewport?.height || window.innerHeight) * (zoomed ? scale : 1)
    const nextTop = zoomed ? 0 : Math.max(0, viewport?.offsetTop || 0)
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return
    if (nextHeight !== height) {
      height = nextHeight
      document.documentElement.style.setProperty('--dsh-mobile-height', height + 'px')
    }
    if (nextTop !== top) {
      top = nextTop
      document.documentElement.style.setProperty('--dsh-mobile-top', top + 'px')
    }
  }
  update()
  window.visualViewport?.addEventListener('resize', update)
  window.visualViewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  window.addEventListener('pageshow', update)
})()
