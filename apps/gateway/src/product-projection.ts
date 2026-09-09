import { createHash } from 'node:crypto'
import type { ProductLocation, ProductMemory, ProductRelationship, SessionDetail } from '@dsh-rp/protocol'
import type { ProductProjectionReplacement } from './product-service.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function stableId(prefix: string, sessionId: string, sourceSeq: number, index: number, value: string): string {
  return `${prefix}-${createHash('sha256').update(`${sessionId}\u0000${sourceSeq}\u0000${index}\u0000${value}`).digest('hex').slice(0, 24)}`
}

export function toProductProjection(detail: SessionDetail, branchId: string, sourceSeq: number): ProductProjectionReplacement {
  const sessionId = detail.session.id
  const memories = detail.state.memories.flatMap((value, index): ProductMemory[] => {
    const item = record(value)
    if (!item) return []
    const content = text(item, ['text', 'summary', 'description', 'memory', 'title'])
    if (!content) return []
    const emotion = text(item, ['emotion', 'mood', 'feeling'])
    const id = text(item, ['id']) ?? stableId('memory', sessionId, sourceSeq, index, content)
    return [{ id, sessionId, branchId, sourceSeq, text: content, ...(emotion ? { emotion } : {}) }]
  })
  const relationships = detail.state.relationships.flatMap((value, index): ProductRelationship[] => {
    const item = record(value)
    if (!item) return []
    const subject = text(item, ['subject', 'from', 'actor']) ?? detail.card.protagonist
    const object = text(item, ['object', 'to', 'name', 'npcName', 'npc', 'target'])
    const measures = (['trust', 'affection', 'affinity'] as const).flatMap(key => {
      const value = item[key]
      return typeof value === 'number' && Number.isFinite(value) ? [{ key, value: `${value}` }] : []
    })
    const relation = text(item, ['relation', 'type', 'kind', 'stage', 'status', 'stance']) ?? measures[0]?.key
    if (!subject || !object || !relation) return []
    const status = [...new Set([text(item, ['status']), text(item, ['role']), text(item, ['stance']), text(item, ['notes']), ...measures.map(measure => measure.value)].filter((value): value is string => Boolean(value)))].join('; ')
    const id = text(item, ['id']) ?? stableId('relationship', sessionId, sourceSeq, index, `${subject}:${object}:${relation}`)
    return [{ id, sessionId, branchId, sourceSeq, subject, object, relation, ...(status ? { status } : {}) }]
  })
  const locations: ProductLocation[] = []
  const scene = detail.state.scene
  if (scene?.region || scene?.location) {
    const value = `${detail.card.world}:${scene.region ?? ''}:${scene.location ?? ''}`
    locations.push({
      id: stableId('location', sessionId, sourceSeq, 0, value), sessionId, branchId, sourceSeq, world: detail.card.world,
      ...(scene.region ? { region: scene.region } : {}), ...(scene.location ? { scene: scene.location } : {}),
    })
  }
  return { branchId, fromSeq: 0, memories, relationships, locations }
}
