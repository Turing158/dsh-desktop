// Run against an actual DSH installation, including its long managed path.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { installRuntimeConptyFallback } from '../dsh-plugin/sidebar-terminal/conpty.mjs'

if (process.platform !== 'win32') throw Error('This check needs Windows ConPTY')
process.env.DSH_DESKTOP_DSH_BIN ||= join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const runtime = createRequire(process.env.DSH_DESKTOP_DSH_BIN)
const provider = createRequire(runtime.resolve('@deepseek-ai/dsh-subprocess-local'))
const pty = provider('node-pty'), original = pty.spawn, attempts = []
pty.spawn = function(file, args, options) {
  attempts.push(options.useConptyDll)
  return original.call(this, file, args, options)
}
const dispose = installRuntimeConptyFallback()
let terminal
try {
  terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/q'], {
    cwd: process.cwd(), cols: 80, rows: 24, env: process.env, useConptyDll: true,
  })
  let output = '', sent = false
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('ConPTY timed out: ' + output)), 15000)
    terminal.onData(data => {
      output += data
      if (!sent) {
        sent = true
        terminal.resize(100, 30)
        terminal.write('echo DESKTOP_CONPTY_OK\r\nexit /b 0\r\n')
      }
    })
    terminal.onExit(event => { clearTimeout(timer); resolve(event) })
  })
  assert.equal(exit.exitCode, 0)
  assert.match(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), /DESKTOP_CONPTY_OK/)
  assert.equal(attempts[0], true)
  assert.ok(attempts.length === 1 || attempts.length === 2 && attempts[1] === false)
  console.log(`PASS: real terminal starts, resizes, accepts input, emits output and exits; ConPTY DLL attempts=${attempts.join(',')}`)
} finally {
  terminal?.kill()
  // Some node-pty DLL versions leave their output worker waiting after an
  // already-exited shell. Release this fixture's worker and pipes explicitly.
  terminal?._agent?._conoutSocketWorker?.dispose()
  terminal?._agent?._inSocket?.destroy()
  terminal?._agent?._outSocket?.destroy()
  dispose()
  pty.spawn = original
}
