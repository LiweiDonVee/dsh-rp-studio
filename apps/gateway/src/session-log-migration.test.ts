import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { migrateCompressedSessionLog, scanZstdFrames } from './session-log-migration.js'

function decodeFrames(source: Buffer): string {
  const scan = scanZstdFrames(source)
  expect(scan.tornStart).toBeUndefined()
  return scan.frames
    .map(frame => zstdDecompressSync(source.subarray(frame.start, frame.end)).toString('utf8'))
    .join('')
}

describe('RP session log migration', () => {
  it.each([1, 2, 3, undefined])('refuses version %s logs owned by the DSH migration pipeline', (version) => {
    const source = zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: 'session', version, id: 's1', cwd: 'source',
    })}\n`))
    expect(() => migrateCompressedSessionLog(source, {
      expectedSessionId: 's1', expectedCwd: 'source', targetCwd: 'target',
    })).toThrow('unsupported session log version')
  })
  it('changes only the durable header cwd and preserves the session history', () => {
    const header = JSON.stringify({
      type: 'session', version: 0, id: 'session-rp-1', createdAt: 1,
      cwd: 'E:\\WorkSpace\\deepseek-harness-local', delegationDepth: 0,
    })
    const events = [
      JSON.stringify({ type: 'user/message', time: 2, data: { text: '开始游戏' } }),
      JSON.stringify({ type: 'assistant/message', time: 3, data: { text: '历史保持不变' } }),
    ]
    const source = Buffer.concat([
      zstdCompressSync(Buffer.from(`${header}\n`)),
      zstdCompressSync(Buffer.from(`${events.join('\n')}\n`)),
    ])

    const migrated = migrateCompressedSessionLog(source, {
      expectedSessionId: 'session-rp-1',
      expectedCwd: 'E:\\WorkSpace\\deepseek-harness-local',
      targetCwd: 'C:\\Users\\Owner\\.dsh\\rp-workspaces\\rp-runtime',
    })
    const sourceFrames = scanZstdFrames(source).frames
    const migratedFrames = scanZstdFrames(migrated).frames
    const text = decodeFrames(migrated)
    const [migratedHeader, ...migratedEvents] = text.trimEnd().split('\n')

    expect(JSON.parse(migratedHeader!)).toEqual({
      type: 'session', version: 0, id: 'session-rp-1', createdAt: 1,
      cwd: 'C:\\Users\\Owner\\.dsh\\rp-workspaces\\rp-runtime', delegationDepth: 0,
    })
    expect(migratedEvents).toEqual(events)
    expect(migratedFrames).toHaveLength(sourceFrames.length)
    expect(migrated.subarray(migratedFrames[0]!.end)).toEqual(source.subarray(sourceFrames[0]!.end))
  })

  it('refuses a mismatched session identity or source cwd', () => {
    const source = zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: 'session', version: 0, id: 'session-rp-1', createdAt: 1, cwd: 'C:\\wrong', delegationDepth: 0,
    })}\n`))
    expect(() => migrateCompressedSessionLog(source, {
      expectedSessionId: 'session-rp-2', expectedCwd: 'C:\\wrong', targetCwd: 'C:\\target',
    })).toThrow('session id')
    expect(() => migrateCompressedSessionLog(source, {
      expectedSessionId: 'session-rp-1', expectedCwd: 'C:\\other', targetCwd: 'C:\\target',
    })).toThrow('cwd')
  })

  it('changes the durable preset only when the source preset is explicitly verified', () => {
    const header = zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: 'session', version: 0, id: 'session-rp-1', createdAt: 1,
      cwd: 'C:\\source', delegationDepth: 0, agentPreset: 'standard',
    })}\n`))
    const events = zstdCompressSync(Buffer.from('{"type":"agent/preset-selected"}\n'))
    const source = Buffer.concat([header, events])

    const migrated = migrateCompressedSessionLog(source, {
      expectedSessionId: 'session-rp-1',
      expectedCwd: 'C:\\source',
      targetCwd: 'C:\\target',
      expectedAgentPreset: 'standard',
      targetAgentPreset: 'zombie-world',
    })
    const [migratedHeader] = decodeFrames(migrated).trimEnd().split('\n')

    expect(JSON.parse(migratedHeader!)).toMatchObject({
      cwd: 'C:\\target', agentPreset: 'zombie-world',
    })
    expect(migrated.subarray(scanZstdFrames(migrated).frames[0]!.end)).toEqual(events)
    expect(() => migrateCompressedSessionLog(source, {
      expectedSessionId: 'session-rp-1',
      expectedCwd: 'C:\\source',
      targetCwd: 'C:\\target',
      expectedAgentPreset: 'other',
      targetAgentPreset: 'zombie-world',
    })).toThrow('agent preset')
  })

  it('refuses a truncated final frame instead of silently dropping history', () => {
    const header = zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: 'session', version: 0, id: 'session-rp-1', createdAt: 1,
      cwd: 'C:\\source', delegationDepth: 0,
    })}\n`))
    const event = zstdCompressSync(Buffer.from('{"type":"user/message"}\n'))
    const source = Buffer.concat([header, event.subarray(0, event.length - 2)])

    expect(() => migrateCompressedSessionLog(source, {
      expectedSessionId: 'session-rp-1', expectedCwd: 'C:\\source', targetCwd: 'C:\\target',
    })).toThrow('incomplete Zstandard frame')
  })

  it('refuses structurally corrupt Zstandard data', () => {
    const source = Buffer.from('not-a-zstd-session-log')
    expect(() => migrateCompressedSessionLog(source, {
      expectedSessionId: 'session-rp-1', expectedCwd: 'C:\\source', targetCwd: 'C:\\target',
    })).toThrow('invalid frame magic')
  })
})
