import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifyDocumentCache } from './document-proof.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
function sample() {
  const ref = { documentId: 'document', documentVersion: 1, chunkId: 'chunk', paragraph: 1 }, text = 'Actual public document body', body = `Public document title\n${text}\n`, entryRef = { sourceKey: 'document-0', entryId: 'chunk' }, query = 'cache query'
  const embedding = (value, phase) => ({ path: '/v1/embeddings', phase, model: 'studio-native-embedding', inputHashes: [hash(value)], snippets: [value] })
  return { databaseHash: 'a'.repeat(64), query, documents: [{ key: 'document-0', documentId: 'document', documentVersion: 1, chunks: [{ ref, text, sha256: hash(text) }] }], entries: [{ ref: entryRef, content: text, provenance: { kind: 'document-chunk', ...ref, textSha256: hash(text) } }], warmResults: [{ candidates: [{ ref: entryRef }] }], coldResult: { candidates: [{ ref: entryRef }] }, requests: [embedding(query, 'source-before-cold-index'), embedding(body, 'source-before-cold-index'), embedding(query, 'source-after-cold-index')], beforeIndex: { readyChunks: 0 }, warmIndex: { readyChunks: 1, staleChunks: 0 }, revisions: [{ revision: 2 }, { revision: 2 }, { revision: 2 }] }
}
test('query calls and a nonempty index do not prove that document chunks were bound and returned', () => {
  const input = sample(); input.entries = []
  assert.throws(() => verifyDocumentCache(input))
})
test('a cache claim requires the actual warm document body embedding, not only query embeddings', () => {
  const input = sample(); input.requests.splice(1, 1)
  assert.throws(() => verifyDocumentCache(input))
})
test('exact document/chunk hits and first body indexing survive cold query-only reuse', () => {
  const input = sample()
  assert.equal(verifyDocumentCache(input).chunks[0].ref.chunkId, 'chunk')
  input.requests.push({ ...input.requests[1], phase: 'source-after-cold-index' })
  assert.throws(() => verifyDocumentCache(input))
})
