import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
const digest = text => createHash('sha256').update(text).digest('hex')
const textOf = value => typeof value === 'string' ? value : String(value?.text ?? '')
export async function startRetrievalProvider({ maxRequests = 256 } = {}) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 512) throw new Error('RETRIEVAL_BUDGET_INVALID')
  const requests = []; let phase = 'setup'
  const server = createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    try {
      if (!['/v1/embeddings', '/v1/rerank'].includes(request.url)) return send(404, { error: 'fixture endpoint not found' })
      if (requests.length >= maxRequests) return send(429, { error: 'RETRIEVAL_REQUEST_LIMIT' })
      let body = '', bytes = 0
      for await (const part of request) { bytes += part.length; if (bytes > 1000000) return send(413, { error: 'RETRIEVAL_BODY_LIMIT' }); body += part }
      const input = JSON.parse(body), embedded = request.url.endsWith('/embeddings')
      const values = (embedded ? Array.isArray(input.input) ? input.input : [input.input] : input.documents).map(textOf)
      requests.push({ path: request.url, phase, model: input.model, inputCount: values.length, inputHashes: values.map(digest), snippets: values.map(text => text.slice(0, 180)), queryHash: input.query === undefined ? null : digest(String(input.query)), disabledSentinelSeen: values.some(text => text.includes('DISABLED_NATIVE_PROVIDER_SENTINEL')) })
      if (embedded) return send(200, { data: values.map((text, index) => ({ index, embedding: text.includes('buried-observatory') ? [0, 1, 0, 0] : [1, 0, 0, 0] })) })
      const query = String(input.query ?? '')
      send(200, { results: values.map((text, index) => ({ index, relevance_score: query.includes('buried-observatory') && text.includes('buried-observatory') ? 1 : 0.5 / (index + 1) })).sort((a, b) => b.relevance_score - a.relevance_score) })
    } catch (error) { send(400, { error: String(error.message).slice(0, 300) }) }
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, phase(value) { phase = String(value).slice(0, 80) }, stats: () => structuredClone({ requests }), close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)) } }
}
