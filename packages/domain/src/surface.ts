export type SurfaceOperation = 'append' | {
  op: 'replace'
  startSeq: number
  endSeq: number
}

export interface RawSessionEvent {
  seq: number
  time: number
  type: string
  data: Record<string, unknown>
  surfaceOp?: SurfaceOperation
  sourceEventSeqs?: number[]
}

export function foldSurface(events: readonly RawSessionEvent[]): RawSessionEvent[] {
  const bySeq = new Map<number, RawSessionEvent>()
  const nodes: number[] = []
  const coverage = new Map<number, number[]>()

  for (const event of events) {
    bySeq.set(event.seq, event)
    if (event.surfaceOp === 'append') {
      nodes.push(event.seq)
      coverage.set(event.seq, [event.seq])
      continue
    }
    if (event.surfaceOp?.op !== 'replace') continue
    const start = nodes.indexOf(event.surfaceOp.startSeq)
    const end = nodes.indexOf(event.surfaceOp.endSeq)
    if (start < 0 || end < start) continue
    // Compaction is a representation of the covered history, not a narrative
    // deletion. Ordinary replacements still supersede their target rows.
    const source = event.data.source as Record<string, unknown> | undefined
    const originals = event.type === 'user/message' && source?.kind === 'compact-checkpoint'
      ? nodes.slice(start, end + 1).flatMap(seq => coverage.get(seq) ?? [seq]) : []
    coverage.set(event.seq, [...originals, event.seq])
    nodes.splice(start, end - start + 1, event.seq)
  }

  return nodes.flatMap(seq => coverage.get(seq) ?? [seq]).flatMap((seq) => {
    const event = bySeq.get(seq)
    return event ? [event] : []
  })
}
