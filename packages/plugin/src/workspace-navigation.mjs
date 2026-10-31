export const ACTION_SLOT = 'rp.studio.workspace.actions'
const coveredEntries = new Set(['dsh-rp-gm/workspace', 'dsh-rp-story-kit/workspace', 'dsh-rp-database/workspace', 'dsh-rp-context/workspace', 'dsh-rp-last-step/workspace'])

export function extensionEntryIds(entries) {
  return [...new Set(entries.map(entry => entry.options.id).filter(id => typeof id === 'string' && !coveredEntries.has(id)))]
}
