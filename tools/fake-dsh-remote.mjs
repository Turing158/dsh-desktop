// Real process-tree fixture for fixed-port restarts; never loads a user profile.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
const flag = name => process.argv[process.argv.indexOf(name) + 1]
if (process.argv.includes('--version')) console.log('0.1.5-rc.2')
else if (!process.argv.includes('--listener')) {
  const child = spawn(process.execPath, [import.meta.filename, '--listener', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
  child.on('exit', code => process.exit(code || 0))
} else {
  const host = process.argv.includes('--host') ? flag('--host') : '127.0.0.1'
  const server = createServer((req,res) => res.end('fixture'))
  server.listen(Number(flag('--port')), host, () => console.log(`dsh web: http://${host}:${server.address().port}/?token=fixture-secret`))
}
