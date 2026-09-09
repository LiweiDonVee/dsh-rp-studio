import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGatewayClient } from '../src/main/gateway-client.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('main-process Gateway client', () => {
  it('reads a selected asset in main and returns only its Gateway asset id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-asset-'))
    directories.push(directory)
    const path = join(directory, '贴纸.png')
    await writeFile(path, 'png-bytes')
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { id: `sha256:${'a'.repeat(64)}` } }), { status: 201, headers: { 'content-type': 'application/json' } }))

    const result = await createGatewayClient(request).uploadAsset('http://127.0.0.1:49123', '会话-7', path)

    expect(result).toEqual({ ok: true, assetId: `sha256:${'a'.repeat(64)}` })
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:49123/api/v1/product/assets?sessionId=%E4%BC%9A%E8%AF%9D-7', expect.objectContaining({ method: 'POST' }))
    expect(JSON.stringify(result)).not.toContain(path)
  })

  it('uses the Gateway backup byte endpoints and never sends a local path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-backup-'))
    directories.push(directory)
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { id: 'backup-7' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const client = createGatewayClient(request)

    await expect(client.exportBackup('http://127.0.0.1:4317', '会话-7', directory)).resolves.toEqual({ ok: true, backupId: 'backup-7' })
    expect(request).toHaveBeenCalled()
    expect(JSON.stringify(request.mock.calls)).not.toContain(directory)
  })

  it('rejects an asset before reading it when the selected file exceeds the limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-large-'))
    directories.push(directory)
    const path = join(directory, 'large.png')
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1))
    const request = vi.fn<typeof fetch>()
    await expect(createGatewayClient(request).uploadAsset('http://127.0.0.1:49123', '会话-7', path)).resolves.toMatchObject({ ok: false, diagnostic: { code: 'asset-too-large' } })
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds the actual asset read when the file grows after the size check', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-grown-'))
    directories.push(directory)
    const path = join(directory, 'grown.png')
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1))
    const request = vi.fn<typeof fetch>()

    await expect(createGatewayClient(request).uploadAsset('http://127.0.0.1:49123', '会话-7', path)).resolves.toMatchObject({ ok: false, diagnostic: { code: 'asset-too-large' } })
    expect(request).not.toHaveBeenCalled()
  })

  it('accepts only the native DSH RP backup extension before reading an import', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-filter-'))
    directories.push(directory)
    const path = join(directory, 'backup.zip')
    await writeFile(path, 'backup-bytes')
    const request = vi.fn<typeof fetch>()

    await expect(createGatewayClient(request).importBackup('http://127.0.0.1:49123', '会话-7', path)).resolves.toMatchObject({ ok: false, diagnostic: { code: 'backup-type-unsupported' } })
    expect(request).not.toHaveBeenCalled()
  })
})
