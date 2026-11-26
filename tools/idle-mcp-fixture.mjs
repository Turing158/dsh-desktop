// Offline stdio server used only by idle-performance-smoke.mjs.
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2], String(process.pid))
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'idle-fixture', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: 'idle_ping', description: 'Offline idle verification',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} } }] }
  else if (request.method === 'tools/call') { writeFileSync(process.argv[3], 'called'); result = { content: [{ type: 'text', text: 'pong' }], isError: false } }
  else result = {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
