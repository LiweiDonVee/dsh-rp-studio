import { createServer } from 'node:net'
import { get } from 'node:http'

function portArgument(value, fallback, label) {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} port must be between 1 and 65535.`)
  return port
}

function canListen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(error => error ? reject(error) : resolve(true))
    })
  })
}

function isExistingStudio(port) {
  return new Promise((resolve, reject) => {
    // The launcher accepts every valid TCP port, including browser-fetch restricted ports.
    const request = get(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2_000) }, async response => {
      try {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume()
          resolve(false)
          return
        }
        response.setEncoding('utf8')
        let body = ''
        for await (const chunk of response) body += chunk
        resolve(JSON.parse(body).protocolVersion === 1)
      } catch (error) { reject(error) }
    })
    request.once('error', reject)
  })
}

async function probe() {
  const port = portArgument(process.argv[2], 4317, 'Studio')
  const dshPort = portArgument(process.argv[3], 3080, 'DSH')
  const promptPresetsPort = portArgument(process.argv[4], 3091, 'Prompt Presets')
  const result = (selectedPort, existing) => ({
    studioUrl: `http://127.0.0.1:${selectedPort}`,
    dshUrl: `http://127.0.0.1:${dshPort}`,
    promptPresetsUrl: `http://127.0.0.1:${promptPresetsPort}/prompt-presets/api`,
    existing,
  })

  try {
    if (await isExistingStudio(port)) return result(port, true)
  } catch {
    // The preferred port is either free or belongs to another local process.
  }

  const lastPort = Math.min(port + 20, 65_535)
  for (let selectedPort = port; selectedPort <= lastPort; selectedPort += 1) {
    if (await canListen(selectedPort)) return result(selectedPort, false)
  }
  throw new Error('No local RP Studio port is available.')
}

probe().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
