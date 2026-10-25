import test from 'node:test'
import assert from 'node:assert/strict'
import { startRetrievalProvider } from './retrieval-provider.mjs'

test('real local HTTP embedding/rerank requests are bounded and record only fixture metadata', async () => {
  const provider = await startRetrievalProvider({ maxRequests: 2 })
  try {
    const post = (path, body) => fetch(provider.baseURL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const embedded = await (await post('/embeddings', { model: 'fixture-embedding', input: ['ordinary letter', 'buried-observatory'] })).json()
    assert.equal(embedded.data.length, 2); assert.equal(embedded.data[0].embedding.length, 4)
    assert.notDeepEqual(embedded.data[0].embedding, embedded.data[1].embedding)
    const ranked = await (await post('/rerank', { model: 'fixture-rerank', query: 'buried-observatory', documents: ['ordinary letter', 'buried-observatory'] })).json()
    assert.equal(ranked.results[0].index, 1)
    assert.equal((await post('/embeddings', { model: 'fixture-embedding', input: ['another'] })).status, 429)
    assert.equal(provider.stats().requests.length, 2)
    assert.equal(provider.stats().requests[0].inputHashes.length, 2)
    assert.equal(provider.stats().requests[0].disabledSentinelSeen, false)
  } finally { await provider.close() }
})
