import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { LoopError, validatePolicy } from './core.mjs'

/** One serialized, revisioned policy store per plugin instance/DSH home. */
export async function createPolicyStore({ home = process.env.DSH_HOME ?? join(homedir(), '.dsh'), directory = join(home, 'app-data', 'loop-studio') } = {}) {
  const path = join(resolve(directory), 'policies.json')
  let state = { schemaVersion: 1, revision: 0, sessions: {}, presets: {} }
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'))
    if (saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0
      || !saved.sessions || !saved.presets) throw new Error('Unsupported Loop Studio policy data.')
    for (const records of [saved.sessions, saved.presets]) for (const policy of Object.values(records)) validatePolicy(policy)
    state = saved
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let pending = Promise.resolve()

  function target(input) {
    const key = input.scope === 'session' ? input.sessionId : input.scope === 'preset' ? input.presetId : undefined
    if (typeof key !== 'string' || !key || key.length > 256) throw new LoopError('bad-request', 'A valid policy scope and identity are required.')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new LoopError('bad-request', 'expectedRevision is required.')
    return { table: input.scope === 'session' ? 'sessions' : 'presets', key }
  }

  function write(input, reset) {
    const operation = pending.then(async () => {
      const { table, key } = target(input)
      if (input.expectedRevision !== state.revision) throw new LoopError('revision-conflict', 'The policy changed. Reload before saving.', 409)
      const next = structuredClone(state)
      if (reset) delete next[table][key]
      else Object.defineProperty(next[table], key, { value: validatePolicy(input.policy), enumerable: true, configurable: true, writable: true })
      next.revision += 1
      await mkdir(resolve(directory), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, path)
      } catch (error) { await rm(temporary, { force: true }); throw error }
      state = next
      return { revision: state.revision }
    })
    pending = operation.catch(() => {})
    return operation
  }

  return {
    read({ sessionId, presetId } = {}) {
      return structuredClone({ revision: state.revision, policies: {
        session: Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : null,
        preset: Object.hasOwn(state.presets, presetId) ? state.presets[presetId] : null,
      } })
    },
    savePolicy: input => write(input, false),
    resetPolicy: input => write(input, true),
  }
}
