import { createHash, timingSafeEqual } from 'node:crypto'
import { DataIntegrityError, DataValidationError } from './errors.js'
import { MAX_ASSET_BYTES, type AssetMetadata, type DataScope, type LedgerCreate, type PageQuery, type ProjectionReplacement } from './types.js'

const hashPattern = /^sha256:[a-f0-9]{64}$/u
const allowedCategories = new Set(['portrait', 'background', 'audio', 'sticker', 'attachment'])
const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/pdf'])

export function assertScope(scope: DataScope): void {
  assertKeys(scope, ['workspaceId', 'cardId', 'sessionId', 'branchId'])
  for (const name of ['workspaceId', 'cardId', 'sessionId', 'branchId'] as const) {
    const value = scope[name]
    if (typeof value !== 'string') throw new DataValidationError(`Missing scope ${name}`)
    if (!validIdentifier(value)) throw new DataValidationError(`Invalid scope ${name}`)
  }
}

export function assertQuery(scope: DataScope, query: PageQuery): number {
  assertScope(scope)
  if (query.sessionId !== scope.sessionId) throw new DataValidationError('Query session does not match its scope')
  const limit = query.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DataValidationError('Page limit must be between 1 and 100')
  if (query.category !== undefined && !allowedCategories.has(query.category)) throw new DataValidationError('Invalid asset category')
  return limit
}

export function assertIsoDate(value: string, field: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new DataValidationError(`${field} must be an ISO UTC date`)
}

export function assertAsset(metadata: AssetMetadata, bytes: Uint8Array): void {
  assertAssetMetadata(metadata)
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new DataValidationError('Asset exceeds the 10 MiB limit')
  if (metadata.bytes !== bytes.byteLength) throw new DataIntegrityError('Asset byte length does not match metadata')
  const actual = sha256(bytes)
  if (actual !== metadata.id) throw new DataIntegrityError('Asset hash does not match its id')
  assertMagic(metadata.mimeType, bytes)
}

export function assertAssetMetadata(metadata: AssetMetadata): void {
  assertKeys(metadata, ['id', 'fileName', 'mimeType', 'category', 'bytes', 'createdAt'], ['label'])
  assertText(metadata.fileName, 'fileName', 255)
  if (metadata.label !== undefined) assertText(metadata.label, 'label', 500, true)
  if (!hashPattern.test(metadata.id)) throw new DataValidationError('Asset id must be a SHA-256 id')
  if (metadata.fileName === '.' || metadata.fileName === '..' || /[\\/:]/u.test(metadata.fileName) || [...metadata.fileName].some(character => character.charCodeAt(0) < 32)) throw new DataValidationError('Asset fileName must not contain a path')
  if (!allowedMimes.has(metadata.mimeType)) throw new DataValidationError('Unsupported asset MIME type')
  if (!allowedCategories.has(metadata.category)) throw new DataValidationError('Unsupported asset category')
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > MAX_ASSET_BYTES) throw new DataValidationError('Asset byte length is invalid')
  assertIsoDate(metadata.createdAt, 'createdAt')
}

export function validBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false
  const padding = value.indexOf('=')
  return padding === -1 || padding >= value.length - 2
}

export function assertProjection(scope: DataScope, replacement: ProjectionReplacement): void {
  assertScope(scope)
  assertKeys(replacement, ['branchId', 'fromSeq', 'memories', 'relationships', 'locations'])
  if (!validIdentifier(replacement.branchId) || !Number.isSafeInteger(replacement.fromSeq) || replacement.fromSeq < 0) throw new DataValidationError('Invalid projection replacement boundary')
  const groups = [
    { items: replacement.memories, keys: new Set(['id', 'sessionId', 'branchId', 'sourceSeq', 'text', 'emotion']) },
    { items: replacement.relationships, keys: new Set(['id', 'sessionId', 'branchId', 'sourceSeq', 'subject', 'object', 'relation', 'status']) },
    { items: replacement.locations, keys: new Set(['id', 'sessionId', 'branchId', 'sourceSeq', 'world', 'region', 'scene', 'landmark']) },
  ]
  for (const group of groups) {
    if (!Array.isArray(group.items)) throw new DataValidationError('Projection rows must be arrays')
    const ids = new Set<string>()
    for (const item of group.items) {
      if (!item || typeof item !== 'object') throw new DataValidationError('Invalid projection row')
      if (Object.keys(item).some(key => !group.keys.has(key))) throw new DataValidationError('Projection item contains a non-public field')
      if (Object.prototype.hasOwnProperty.call(item, 'private')) throw new DataValidationError('Private RP state cannot enter a public projection')
      if (!validIdentifier(item.id) || item.sessionId !== scope.sessionId || item.branchId !== replacement.branchId || !Number.isSafeInteger(item.sourceSeq) || item.sourceSeq < replacement.fromSeq) throw new DataValidationError('Projection item is outside the replacement scope')
      if (ids.has(item.id)) throw new DataValidationError('Projection ids must be unique within a replacement')
      ids.add(item.id)
    }
  }
  for (const item of replacement.memories) {
    assertText(item.text, 'memory.text', 20_000)
    if (item.emotion !== undefined) assertText(item.emotion, 'memory.emotion', 200, true)
  }
  for (const item of replacement.relationships) {
    for (const field of ['subject', 'object', 'relation'] as const) assertText(item[field], field, 500)
    if (item.status !== undefined) assertText(item.status, 'status', 500, true)
  }
  for (const item of replacement.locations) {
    assertText(item.world, 'world', 500)
    for (const field of ['region', 'scene', 'landmark'] as const) if (item[field] !== undefined) assertText(item[field], field, 500, true)
  }
}

export function assertKeys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DataValidationError('Expected an object')
  const keys = Object.keys(value)
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) throw new DataValidationError('Object has missing or unknown fields')
}

export function assertText(value: unknown, field: string, maximum: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maximum) throw new DataValidationError(`Invalid ${field}`)
}

export function assertLedger(input: LedgerCreate): void {
  assertKeys(input, ['commandId', 'amountMinor', 'currency', 'description', 'occurredAt'], ['reversesEntryId'])
  assertText(input.commandId, 'commandId', 200)
  assertText(input.description, 'description', 2_000)
  if (!Number.isSafeInteger(input.amountMinor) || typeof input.currency !== 'string' || !/^[A-Z]{3}$/u.test(input.currency)) throw new DataValidationError('Invalid ledger amount or currency')
  assertIsoDate(input.occurredAt, 'occurredAt')
  if (input.reversesEntryId !== undefined && !validIdentifier(input.reversesEntryId)) throw new DataValidationError('Invalid reversal id')
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function sortJson(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new DataValidationError('JSON nesting exceeds its limit')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new DataValidationError('JSON requires finite numbers')
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new DataValidationError('Value is not JSON')
  if (Array.isArray(value)) return value.map(item => sortJson(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DataValidationError('JSON objects must be plain objects')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortJson(item, depth + 1)]))
  }
  return value
}

function validIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) return false
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function assertMagic(mime: AssetMetadata['mimeType'], bytes: Uint8Array): void {
  const starts = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value)
  const ascii = (offset: number, value: string): boolean => Buffer.from(bytes).subarray(offset, offset + value.length).toString('ascii') === value
  const valid = mime === 'image/png' ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    : mime === 'image/jpeg' ? starts(0xff, 0xd8, 0xff)
      : mime === 'image/gif' ? ascii(0, 'GIF87a') || ascii(0, 'GIF89a')
        : mime === 'image/webp' ? ascii(0, 'RIFF') && ascii(8, 'WEBP')
          : mime === 'audio/ogg' ? ascii(0, 'OggS')
            : mime === 'audio/wav' ? ascii(0, 'RIFF') && ascii(8, 'WAVE')
              : mime === 'application/pdf' ? ascii(0, '%PDF-')
                : ascii(0, 'ID3') || (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
  if (!valid) throw new DataIntegrityError(`Asset content does not match ${mime}`)
}
