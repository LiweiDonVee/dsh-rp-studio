const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
const rows = (value, idField) => Array.isArray(value) && value.every(row => exact(row, [idField, 'version', 'uses'])
  && typeof row[idField] === 'string' && row[idField].trim().length > 0
  && Number.isSafeInteger(row.version) && row.version > 0
  && Array.isArray(row.uses) && row.uses.every(use => use === 'current-binding' || use === 'asset-default'))

/** Recorded informational use only; this never supplies restore authority. */
export function validDependencySummary(value) {
  return exact(value, ['databases', 'profiles']) && rows(value.databases, 'databaseId') && rows(value.profiles, 'profileId')
}
