import { createServer } from 'node:http'

const mode = process.env.SUPERVISOR_TEST_GATEWAY_MODE ?? 'ok'
const requested = Number(process.env.DSH_RP_PORT)
const secret = process.env.DSH_WEB_TOKEN ?? ''

if (mode === 'spawn-error') process.exit(29)
if (mode === 'timeout') setInterval(() => {}, 1_000)
else {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/v1/health' && mode !== 'wrong-identity') {
      response.end(JSON.stringify({ ok: true, protocolVersion: 1, data: { upstream: 'ready', version: 'fixture' } }))
    } else {
      response.end(JSON.stringify({ hello: 'world' }))
    }
  })
  server.listen(requested, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') process.exit(30)
    process.stdout.write(`gateway token=${secret.slice(0, 5)}`)
    setTimeout(() => process.stdout.write(`${secret.slice(5)} ready\nDSH RP Studio: http://127.0.0.1:${address.port}\n`), 5)
    if (mode === 'exit-after-ready') setTimeout(() => process.exit(31), 80)
  })
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
