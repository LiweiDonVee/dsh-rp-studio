import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528

export interface ZstdFrameRange {
  start: number
  end: number
}

export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  tornStart?: number
}

export function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return { frames }
}

export interface CompressedSessionMigration {
  expectedSessionId: string
  expectedCwd: string
  targetCwd: string
  expectedAgentPreset?: string
  targetAgentPreset?: string
}

function sessionHeader(line: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('session log has an invalid JSON header')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session log has an invalid header')
  }
  return value as Record<string, unknown>
}

export function migrateCompressedSessionLog(
  source: Uint8Array,
  options: CompressedSessionMigration,
): Buffer {
  if (!options.targetCwd) throw new Error('target cwd must not be empty')
  if ((options.expectedAgentPreset === undefined) !== (options.targetAgentPreset === undefined)) {
    throw new Error('source and target agent preset must be specified together')
  }
  if (options.targetAgentPreset === '') throw new Error('target agent preset must not be empty')
  const input = Buffer.isBuffer(source)
    ? source
    : Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  const scan = scanZstdFrames(input)
  if (scan.tornStart !== undefined) {
    throw new Error(`session log has an incomplete Zstandard frame at byte ${scan.tornStart}`)
  }
  const firstFrame = scan.frames[0]
  if (!firstFrame) throw new Error('session log has no complete header frame')
  const text = zstdDecompressSync(input.subarray(firstFrame.start, firstFrame.end)).toString('utf8')
  const newline = text.indexOf('\n')
  if (newline < 0 || newline !== text.length - 1) {
    throw new Error('session log header frame must contain exactly one complete line')
  }
  const header = sessionHeader(text.slice(0, newline))
  // This offline helper predates immutable adjacent-version migration and locks.
  // Only legacy v0 headers are understood; let DSH own v1/v2 and future formats.
  if (header.version !== 0) throw new Error('unsupported session log version; use the matching DSH migration/export tools')
  if (header.type !== 'session' || header.id !== options.expectedSessionId) {
    throw new Error(`session id does not match ${options.expectedSessionId}`)
  }
  if (header.cwd !== options.expectedCwd) {
    throw new Error(`session cwd does not match ${options.expectedCwd}`)
  }
  if (
    options.expectedAgentPreset !== undefined
    && header.agentPreset !== options.expectedAgentPreset
  ) {
    throw new Error(`session agent preset does not match ${options.expectedAgentPreset}`)
  }

  const nextHeader = {
    ...header,
    cwd: options.targetCwd,
    ...(options.targetAgentPreset === undefined ? {} : { agentPreset: options.targetAgentPreset }),
  }
  const headerFrame = zstdCompressSync(
    Buffer.from(`${JSON.stringify(nextHeader)}\n`),
    { params: { [constants.ZSTD_c_checksumFlag]: 1 } },
  )
  const originalTail = input.subarray(firstFrame.end)
  const migrated = Buffer.concat([headerFrame, originalTail])
  const migratedScan = scanZstdFrames(migrated)
  const migratedHeaderFrame = migratedScan.frames[0]
  if (
    migratedScan.tornStart !== undefined
    || !migratedHeaderFrame
    || migratedScan.frames.length !== scan.frames.length
    || !migrated.subarray(migratedHeaderFrame.end).equals(originalTail)
  ) {
    throw new Error('session history changed during migration')
  }
  return migrated
}
