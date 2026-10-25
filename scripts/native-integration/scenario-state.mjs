export function scenarioState(ids, onChange = () => {}) {
  const rows = ids.map(id => ({ id, status: 'not-run' }))
  return {
    snapshot: () => structuredClone(rows),
    async run(id, work) {
      const row = rows.find(item => item.id === id)
      if (!row || row.status !== 'not-run') throw new Error('SCENARIO_ALREADY_STARTED_OR_UNKNOWN')
      row.status = 'running'; await onChange(rows)
      try { const result = await work(); row.status = 'passed'; row.evidence = result; await onChange(rows); return result }
      catch (error) { row.status = error.deferred ? 'deferred' : 'failed'; row.error = String(error.message).slice(0, 4000); await onChange(rows); throw error }
    },
  }
}
