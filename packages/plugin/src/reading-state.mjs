export const narrativeRefFields = ['sessionId', 'presentationId', 'assistantMessageId', 'callSeq', 'baseResultSeq', 'resultSeq']

export const refKey = ref => JSON.stringify(narrativeRefFields.map(key => ref?.[key]))
export const familyKey = ref => JSON.stringify(narrativeRefFields.filter(key => key !== 'resultSeq').map(key => ref?.[key]))
export const roundKey = ref => JSON.stringify([ref.sessionId, ref.presentationId])
export const fullNarrativeRef = ref => Object.fromEntries(narrativeRefFields.map(key => [key, ref[key]]))
export const sameRef = (left, right) => refKey(left) === refKey(right)
export const validNarrativeRef = ref => ref && narrativeRefFields.every(key => key.endsWith('Seq') ? Number.isSafeInteger(ref[key]) && ref[key] >= 0 : typeof ref[key] === 'string' && ref[key].length > 0)

export function validReadingPage(value, sessionId) {
  return value?.schemaVersion === 1 && typeof value.projectionKey === 'string' && Array.isArray(value.records)
    && value.records.every(record => typeof record.text === 'string' && validNarrativeRef(record.ref) && record.ref.sessionId === sessionId)
    && typeof value.hasOlder === 'boolean' && Number.isSafeInteger(value.totalCount) && value.totalCount >= value.records.length
    && (value.nextBefore === null || value.nextBefore?.projectionKey === value.projectionKey && Number.isSafeInteger(value.nextBefore.callSeq) && typeof value.nextBefore.presentationId === 'string')
    && (!value.hasOlder || value.nextBefore !== null)
}
