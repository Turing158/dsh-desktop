import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installConptyFallback } from './sidebar-terminal/conpty.mjs'

test('missing bundled ConPTY retries once with the same shell and Windows ConPTY', () => {
  for (const code of [2, 3]) {
    const calls = [], terminal = {}, args = ['/d'], options = { useConptyDll: true, cwd: 'D:/project', cols: 120, rows: 30, env: { TERM: 'xterm-256color' } }
    const pty = { spawn(file, argv, opts) {
      assert.equal(this, pty)
      calls.push({ file, argv, opts })
      if (opts.useConptyDll) throw Error(`Cannot find conpty.dll at , error code: ${code}`)
      return terminal
    } }
    const original = pty.spawn, dispose = installConptyFallback(pty, 'win32')
    assert.equal(pty.spawn('cmd.exe', args, options), terminal)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].file, 'cmd.exe')
    assert.equal(calls[1].argv, args)
    assert.deepEqual(calls[1].opts, { ...options, useConptyDll: false })
    assert.equal(options.useConptyDll, true)
    dispose()
    assert.equal(pty.spawn, original)
  }
})

test('healthy DLLs, non-Windows hosts, and unrelated launch errors retain upstream behavior', () => {
  const options = { useConptyDll: true }, terminal = {}, healthy = { spawn: (_f, _a, opt) => { assert.equal(opt, options); return terminal } }
  const original = healthy.spawn
  installConptyFallback(healthy, 'linux')()
  assert.equal(healthy.spawn, original)
  installConptyFallback(healthy, 'win32')
  assert.equal(healthy.spawn('cmd', [], options), terminal)
  for (const [message, useConptyDll] of [['File not found: missing.exe', true], ['Cannot find conpty.dll at x, error code: 5', true], ['Cannot find conpty.dll at x, error code: 3', false]]) {
    let calls = 0
    const failure = Error(message), pty = { spawn() { calls++; throw failure } }
    installConptyFallback(pty, 'win32')
    assert.throws(() => pty.spawn('cmd', [], { useConptyDll }), error => error === failure)
    assert.equal(calls, 1)
  }
})

test('system ConPTY failure propagates without further retries', () => {
  let calls = 0
  const failure = Error('Cannot launch conpty'), pty = { spawn() {
    if (++calls === 1) throw Error('Cannot find conpty.dll at , error code: 3')
    throw failure
  } }
  installConptyFallback(pty, 'win32')
  assert.throws(() => pty.spawn('cmd', [], { useConptyDll: true }), error => error === failure)
  assert.equal(calls, 2)
})
