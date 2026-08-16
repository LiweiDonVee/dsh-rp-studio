export type SurfaceOperation = 'append' | {
  op: 'replace'
  start: number
  end: number
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

  for (const event of events) {
    bySeq.set(event.seq, event)
    if (event.surfaceOp === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (event.surfaceOp?.op !== 'replace') continue
    const start = nodes.indexOf(event.surfaceOp.start)
    const end = nodes.indexOf(event.surfaceOp.end)
    if (start < 0 || end < start) continue
    nodes.splice(start, end - start + 1, event.seq)
  }

  return nodes.flatMap((seq) => {
    const event = bySeq.get(seq)
    return event ? [event] : []
  })
}
