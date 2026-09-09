import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const mode = process.env.SUPERVISOR_TEST_DSH_MODE ?? 'ok'
const requested = Number(process.argv[process.argv.indexOf('--port') + 1])
const secret = process.env.SUPERVISOR_TEST_SECRET ?? 'fixture-secret'

if (mode === 'spawn-error') process.exit(19)
if (mode === 'timeout') setInterval(() => {}, 1_000)
else {
  const server = createServer((request, response) => {
    if (request.url === `/?token=${secret}`) {
      response.writeHead(303, { location: '/', 'set-cookie': 'dsh_session=fixture-cookie; HttpOnly; Path=/' }).end()
      return
    }
    if (request.headers.cookie !== 'dsh_session=fixture-cookie') {
      response.writeHead(401).end()
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(mode === 'wrong-identity' ? '<title>Unrelated server</title>' : '<title>DeepSeek Harness</title>')
  })
  server.listen(requested, '127.0.0.1', async () => {
    const address = server.address()
    if (!address || typeof address === 'string') process.exit(20)
    if (mode === 'grandchild') {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
      if (process.env.SUPERVISOR_TEST_PID_FILE) await writeFile(process.env.SUPERVISOR_TEST_PID_FILE, `${process.pid},${child.pid}`)
    }
    process.stdout.write(`\u001b[32mdsh web: http://127.0.0.1:${address.port}/?token=${secret.slice(0, 7)}`)
    setTimeout(() => process.stdout.write(`${secret.slice(7)}\u001b[0m\n`), 5)
  })
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
