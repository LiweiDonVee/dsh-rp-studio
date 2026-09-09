import { createServer } from 'node:http'

const requested = Number(process.env.DSH_RP_PORT)
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/api/v1/health') {
    response.end(JSON.stringify({ ok: true, protocolVersion: 1, data: { upstream: 'ready', version: 'control-fixture' } }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/product/backups' && url.searchParams.get('sessionId')) {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const commandId = JSON.parse(body).commandId
      response.statusCode = 201
      response.end(JSON.stringify({
        ok: true,
        protocolVersion: 1,
        data: {
          id: `backup-${commandId}`,
          schemaVersion: 1,
          state: 'ready',
          manifestHash: `sha256:${'a'.repeat(64)}`,
        },
      }))
    })
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ ok: false, protocolVersion: 1, error: { code: 'not-found', message: 'fixture route not found' } }))
})

server.listen(requested, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
