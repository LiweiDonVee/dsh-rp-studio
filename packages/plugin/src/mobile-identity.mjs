import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A plugin reload is not a host reboot. Keep this process's boot token outside
// the plugin lifetime, partitioned by the real profile rather than its label.
const bootsKey = Symbol.for('dsh-rp-studio.mobile-identity.boots.v1')
const boots = globalThis[bootsKey] ??= new Map()
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)

export function createMobileIdentity({ getProfile, bootIds = boots }) {
  let pending
  return () => pending ??= (async () => {
    const profile = getProfile()
    if (!profile || typeof profile.dir !== 'string' || !profile.dir || typeof profile.name !== 'string' || !profile.name) {
      throw new Error('Profile identity is unavailable')
    }
    const dir = await realpath(profile.dir)
    const scope = createHash('sha256').update(JSON.stringify([dir, profile.name])).digest('hex')
    const path = join(dir, '.rp-studio-mobile-identity.json')
    const read = async () => JSON.parse(await readFile(path, 'utf8'))
    let saved
    try { saved = await read() }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const fresh = { schemaVersion: 1, scope, instanceId: randomUUID() }
      try { await writeFile(path, JSON.stringify(fresh) + '\n', { flag: 'wx', mode: 0o600, flush: true }); saved = fresh }
      catch (error) { if (error.code !== 'EEXIST') throw error; saved = await read() }
    }
    // A copied profile must acquire its own identity. A malformed record is
    // deliberately not repaired into a false identity while clients are live.
    if (saved.schemaVersion !== 1 || !uuid(saved.instanceId) || typeof saved.scope !== 'string') throw new Error('Invalid profile identity')
    if (saved.scope !== scope) {
      saved = { schemaVersion: 1, scope, instanceId: randomUUID() }
      await writeFile(path, JSON.stringify(saved) + '\n', { mode: 0o600, flush: true })
    }
    if (!bootIds.has(scope)) bootIds.set(scope, randomUUID())
    return Object.freeze({ schemaVersion: 1, instanceId: saved.instanceId, bootId: bootIds.get(scope) })
  })().catch(error => { pending = undefined; throw error })
}
