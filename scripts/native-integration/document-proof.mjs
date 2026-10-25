import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const hash = text => createHash('sha256').update(text).digest('hex')
export function verifyDocumentCache({ databaseHash, query, documents, entries, warmResults, coldResult, requests, beforeIndex, warmIndex, revisions }) {
  assert.match(databaseHash, /^[a-f0-9]{64}$/u)
  const warm = requests.filter(row => row.phase === 'source-before-cold-index' && row.path.endsWith('/embeddings'))
  const cold = requests.filter(row => row.phase === 'source-after-cold-index' && row.path.endsWith('/embeddings'))
  assert.ok(warm.some(row => row.inputHashes.includes(hash(query))) && cold.length > 0)
  assert.ok(cold.every(row => row.model === 'studio-native-embedding' && row.inputHashes.every(value => value === hash(query))), 'unchanged bodies were embedded after restart')
  const chunks = []
  for (const document of documents) for (const chunk of document.chunks) {
    assert.equal(chunk.ref.documentId, document.documentId); assert.equal(chunk.ref.documentVersion, document.documentVersion); assert.equal(hash(chunk.text), chunk.sha256)
    const entry = entries.find(row => row.ref.sourceKey === document.key && row.ref.entryId === chunk.ref.chunkId)
    assert.ok(entry, 'document chunk is not bound'); assert.equal(entry.content, chunk.text)
    assert.equal(entry.provenance.kind, 'document-chunk'); assert.equal(entry.provenance.textSha256, chunk.sha256)
    for (const [key, value] of Object.entries(chunk.ref)) assert.equal(entry.provenance[key], value)
    for (const result of [...warmResults, coldResult]) assert.ok(result.candidates.some(row => row.ref.sourceKey === document.key && row.ref.entryId === chunk.ref.chunkId), 'search did not return the exact document/chunk ref')
    const bodies = warm.flatMap(row => row.snippets.flatMap((text, index) => text.includes(`\n${chunk.text}\n`) && hash(text) === row.inputHashes[index] ? [{ hash: row.inputHashes[index], model: row.model }] : []))
    assert.equal(bodies.length, 1, 'document body was not indexed exactly once in warm queries'); assert.equal(bodies[0].model, 'studio-native-embedding')
    assert.ok(!requests.some(row => !['source-before-cold-index', 'source-after-cold-index'].includes(row.phase) && row.path.endsWith('/embeddings') && row.inputHashes.includes(bodies[0].hash)), 'document body had already been embedded before the measured first query')
    chunks.push({ sourceKey: document.key, ref: chunk.ref, textHash: chunk.sha256, embeddingInputHash: bodies[0].hash })
  }
  assert.ok(chunks.length > 0); assert.ok(warmIndex.readyChunks >= beforeIndex.readyChunks + new Set(chunks.map(chunk => chunk.embeddingInputHash)).size); assert.equal(warmIndex.staleChunks, 0)
  for (const revision of revisions.slice(1)) assert.deepEqual(revision, revisions[0], 'cache changed content revision')
  return { databaseHash, queryHash: hash(query), chunks, beforeIndex, warmIndex, coldQueryEmbeddingRequests: cold.length, unchangedContentRevision: revisions[0] }
}
