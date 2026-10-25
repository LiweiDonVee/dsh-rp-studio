import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { syntheticStoryData } from './data-fixtures.mjs'

test('synthetic PNG retains exact full-card JSON and a valid one-pixel image', () => {
  const data = syntheticStoryData(), chunks = []
  assert.equal(data.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  for (let offset = 8; offset < data.png.length;) {
    const length = data.png.readUInt32BE(offset), type = data.png.subarray(offset + 4, offset + 8).toString('ascii')
    chunks.push({ type, body: data.png.subarray(offset + 8, offset + 8 + length), crc: data.png.subarray(offset + 8 + length, offset + 12 + length).toString('hex') }); offset += length + 12
  }
  assert.equal(chunks.find(chunk => chunk.type === 'IHDR').crc, '1f15c489')
  const raw = chunks.find(chunk => chunk.type === 'tEXt').body.toString('latin1')
  assert.equal(raw.slice(0, 6), 'chara\0')
  assert.equal(Buffer.from(raw.slice(6), 'base64').toString('utf8'), data.cardJson)
  assert.deepEqual(inflateSync(chunks.find(chunk => chunk.type === 'IDAT').body), Buffer.from([0, 0, 0, 0, 0]))
})
test('reviewed seed, outside search data and real text PDF pages remain explicit fixtures', () => {
  const data = syntheticStoryData(), world = JSON.parse(data.worldJson)
  assert.deepEqual(data.initialFacts, { schemaVersion: 1, items: [{ id: 'letter-holder', text: '密封信件当前由旅人持有。' }] })
  assert.equal(world.entries.filter(entry => entry.id.startsWith('decoy-')).length, 40)
  assert.equal(world.entries.some(entry => entry.id === 'outside' && entry.keywords.includes('buried-observatory')), true)
  const pdf = data.documents.find(document => document.mimeType === 'application/pdf').bytes.toString('ascii')
  assert.ok(pdf.startsWith('%PDF-1.4')); assert.ok(pdf.includes('/Count 2'))
  const start = Number(/startxref\n(\d+)/u.exec(pdf)[1])
  assert.equal(pdf.slice(start, start + 4), 'xref')
  assert.ok(pdf.includes('Harbor alpha')); assert.ok(pdf.includes('Observatory beta'))
})
