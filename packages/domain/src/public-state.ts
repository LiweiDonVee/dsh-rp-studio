import {
  publicGameStateSchema,
  type PublicGameState,
} from '@dsh-rp/protocol'

type UnknownRecord = Record<string, unknown>

const OMITTED_KEY = /(?:secret|offscreen|reasoning|audit|toolresult|private|hidden)/iu
const PUBLIC_EXTENSION_KEYS = ['economy'] as const

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function isHidden(value: UnknownRecord): boolean {
  if (value.hidden === true || value.private === true) return true
  const visibility = value.visibility
  const labels = Array.isArray(visibility) ? visibility : [visibility]
  return labels.some(label => typeof label === 'string' && /(?:^|[-_:])(hidden|private|secret|gm-only|offscreen)(?:$|[-_:])/iu.test(label.trim()))
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const clean = sanitize(item)
      return clean === undefined ? [] : [clean]
    })
  }
  const input = record(value)
  if (!input) return value
  if (isHidden(input)) return undefined

  const output: UnknownRecord = {}
  for (const [key, child] of Object.entries(input)) {
    if (key === 'meta' || OMITTED_KEY.test(key)) continue
    const clean = sanitize(child)
    if (clean !== undefined) output[key] = clean
  }
  return output
}

function safeRecord(value: unknown): UnknownRecord | undefined {
  const clean = sanitize(value)
  return record(clean)
}

function records(value: unknown): UnknownRecord[] {
  const object = record(value)
  if (object && isHidden(object)) return []
  const values = Array.isArray(value)
    ? value
    : object
      ? Object.values(object)
      : []
  return values.flatMap((item) => {
    const clean = safeRecord(item)
    return clean ? [clean] : []
  })
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function publicConditions(value: unknown): UnknownRecord[] {
  return records(value).map(condition => ({
    ...condition,
    label: typeof condition.label === 'string'
      ? condition.label
      : typeof condition.name === 'string'
        ? condition.name
        : typeof condition.id === 'string'
          ? condition.id
          : '状态',
  }))
}

function publicProtagonist(value: unknown, economy: unknown): UnknownRecord | undefined {
  const input = safeRecord(value)
  if (!input || typeof input.name !== 'string') return undefined
  const output: UnknownRecord = {
    name: input.name,
    conditions: publicConditions(input.conditions),
  }
  if (typeof input.id === 'string') output.id = input.id
  if (typeof input.age === 'number') output.age = input.age
  if (typeof input.background === 'string') output.background = input.background
  const publicStatus = strings(input.publicStatus)
  if (publicStatus) output.publicStatus = publicStatus
  const attributes = safeRecord(input.attributes)
  if (attributes) output.attributes = attributes
  const resources = safeRecord(input.resources) ?? safeRecord(economy)
  if (resources) {
    output.resources = Object.fromEntries(Object.entries(resources)
      .filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number'))
  }
  if (typeof input.stress === 'number') output.stress = input.stress
  const body = safeRecord(input.body)
  if (body) output.body = body
  const talents = records(input.talents)
  if (talents.length > 0) output.talents = talents
  return output
}

function publicBeat(value: unknown): UnknownRecord | null | undefined {
  if (value === null) return null
  const input = safeRecord(value)
  if (!input) return undefined
  const output: UnknownRecord = {}
  for (const key of ['id', 'title', 'location', 'status'] as const) {
    if (typeof input[key] === 'string') output[key] = input[key]
  }
  for (const key of ['objectives', 'threats', 'participants'] as const) {
    const value = strings(input[key])
    if (value) output[key] = value
  }
  return output
}

function publicScene(value: unknown): UnknownRecord | undefined {
  const input = safeRecord(value)
  if (!input) return undefined
  const output: UnknownRecord = {}
  for (const key of ['location', 'region', 'weather'] as const) {
    if (typeof input[key] === 'string') output[key] = input[key]
  }
  const beat = publicBeat(input.currentBeat)
  if (beat !== undefined) output.currentBeat = beat
  const completedBeats = records(input.completedBeats)
  if (completedBeats.length > 0) output.completedBeats = completedBeats
  return output
}

function publicMemories(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return records(value)
  const input = record(value)
  if (!input || isHidden(input)) return []
  return [...records(input.public), ...records(input.protagonist)]
}

function checkpointSummary(metaValue: unknown): PublicGameState['checkpoints'] {
  const meta = record(metaValue)
  const checkpoints = Array.isArray(meta?.checkpoints)
    ? meta.checkpoints.flatMap((item) => record(item) ? [item as UnknownRecord] : [])
    : []
  if (checkpoints.length === 0 && Array.isArray(meta?.history)) {
    const history = meta.history.flatMap((item) => record(item) ? [item as UnknownRecord] : [])
    const active = history.at(-1)
    return {
      count: history.length,
      canRollback: history.length > 0,
      activeTurn: typeof active?.turn === 'number' && Number.isInteger(active.turn) && active.turn >= 0
        ? active.turn
        : null,
    }
  }
  const activeId = typeof meta?.activeCheckpointId === 'string' ? meta.activeCheckpointId : null
  const byId = new Map(checkpoints.flatMap(checkpoint => typeof checkpoint.id === 'string'
    ? [[checkpoint.id, checkpoint] as const]
    : []))
  const active = activeId ? byId.get(activeId) : undefined
  const visited = new Set<string>()
  let cursor = active
  while (cursor && typeof cursor.id === 'string' && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    cursor = typeof cursor.parentId === 'string' ? byId.get(cursor.parentId) : undefined
  }
  return {
    count: visited.size,
    canRollback: active !== undefined,
    activeTurn: typeof active?.turn === 'number' && Number.isInteger(active.turn) && active.turn >= 0
      ? active.turn
      : null,
  }
}

export function projectPublicState(value: unknown): PublicGameState {
  const projection = record(value) ?? {}
  const rawGame = record(projection.game) ?? projection
  const game = isHidden(projection) || isHidden(rawGame) ? {} : rawGame
  const extensions: UnknownRecord = {}
  for (const key of PUBLIC_EXTENSION_KEYS) {
    const clean = sanitize(game[key])
    if (clean !== undefined) extensions[key] = clean
  }

  const result: UnknownRecord = {
    started: game.started === true,
    relationships: records(game.relationships),
    faction: records(game.faction),
    inventory: records(game.inventory),
    memories: publicMemories(game.memories),
    quests: records(game.quests),
    eventLog: records(game.eventLog),
    statusLines: strings(game.statusLines) ?? [],
    extensions,
    checkpoints: checkpointSummary(projection.meta),
  }
  if (typeof game.schemaVersion === 'number' && Number.isInteger(game.schemaVersion) && game.schemaVersion >= 0) {
    result.schemaVersion = game.schemaVersion
  }
  if (typeof game.currentDate === 'string') result.currentDate = game.currentDate
  if (typeof game.currentTime === 'string') result.currentTime = game.currentTime
  const scene = publicScene(game.scene)
  if (scene) result.scene = scene
  const protagonist = publicProtagonist(game.protagonist, game.economy)
  if (protagonist) result.protagonist = protagonist
  const driver = safeRecord(game.driver)
  if (driver) {
    result.driver = {
      armed: driver.armed === true,
      ...(typeof driver.objective === 'string' ? { objective: driver.objective } : {}),
      ...(typeof driver.maxRounds === 'number' && Number.isInteger(driver.maxRounds) && driver.maxRounds > 0
        ? { maxRounds: driver.maxRounds }
        : {}),
    }
  }

  return publicGameStateSchema.parse(result)
}
