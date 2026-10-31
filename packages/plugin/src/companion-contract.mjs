export class CompanionError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'CompanionError'; this.code = code; this.status = status }
}
export const fail = (code, message, status) => { throw new CompanionError(code, message, status) }
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && !!value.trim() && value.length <= 256
const text = value => typeof value === 'string'
const rev = value => Number.isSafeInteger(value) && value >= 0
const ver = value => Number.isSafeInteger(value) && value > 0
const array = value => Array.isArray(value)
const enumOf = values => value => values.includes(value)
const fields = (required, optional = {}) => ({ required, optional })
const entry = (owner, apiVersion, method, shape, run) => ({ owner, apiVersion, method, ...shape, run })
const sourceRef = value => object(value) && Object.keys(value).every(key => ['key', 'databaseId', 'version'].includes(key)) && id(value.key) && id(value.databaseId) && ver(value.version)
const sources = value => array(value) && value.every(sourceRef) && new Set(value.map(item => item.key)).size === value.length
const assetRef = value => object(value) && Object.keys(value).every(key => ['assetId', 'version'].includes(key)) && id(value.assetId) && ver(value.version)
const profileRef = value => value === null || object(value) && Object.keys(value).every(key => ['profileId', 'version'].includes(key)) && id(value.profileId) && ver(value.version)
const objectOrArray = value => object(value) || array(value)
const orderId = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
const variables = value => object(value) && Object.values(value).every(text)
const settings = value => object(value) && Object.keys(value).every(key => ['enabled', 'recentTurns', 'maxChars', 'maxSteps'].includes(key))
  && (value.enabled === undefined || typeof value.enabled === 'boolean')
  && [['recentTurns', 1000], ['maxChars', 1000000], ['maxSteps', 32]].every(([key, max]) => value[key] === undefined || ver(value[key]) && value[key] <= max)

// Every closure fixes its one owner method and its real positional/object signature.
export const INSPECT = Object.freeze({
  overview: entry(null, null, null, fields({}, { sessionId: id }), null),
  'assets.state': entry('rpStoryKit', 1, 'state', fields({}), (owner, input, signal) => owner.state({ ...input, signal })),
  'assets.asset': entry('rpStoryKit', 1, 'asset', fields({ kind: enumOf(['character', 'persona']), assetId: id }, { version: ver }), (owner, input, signal) => owner.asset({ ...input, signal })),
  'assets.source': entry('rpStoryKit', 1, 'source', fields({ sourceId: id }), (owner, input, signal) => owner.source({ ...input, signal })),
  'assets.previewPack': entry('rpStoryKit', 1, 'previewPack', fields({ pack: object }), (owner, input, signal) => owner.previewPack({ ...input, signal })),
  'database.state': entry('rpDatabase', 2, 'state', fields({}, { sessionId: id }), (owner, input, signal) => owner.state({ ...input, signal })),
  'database.database': entry('rpDatabase', 2, 'database', fields({ databaseId: id }, { version: ver }), (owner, input, signal) => owner.database({ ...input, signal })),
  'database.source': entry('rpDatabase', 2, 'source', fields({ sourceId: id }), (owner, input, signal) => owner.source({ ...input, signal })),
  'presets.state': entry('rpLastStep', 1, 'state', fields({}, { sessionId: id }), (owner, input, signal) => owner.state(input.sessionId, signal)),
  'presets.profile': entry('rpLastStep', 1, 'profile', fields({ profileId: id }, { version: ver }), (owner, input, signal) => owner.profile(input, signal)),
  'presets.source': entry('rpLastStep', 1, 'source', fields({ sourceId: id }), (owner, input, signal) => owner.source(input, signal)),
  'presets.preview': entry('rpLastStep', 1, 'preview', fields({ profile: object, phase: enumOf(['agent', 'render']) }, { sessionId: id, variables }), (owner, input, signal) => owner.preview(input, signal)),
  'context.state': entry('rpContext', null, 'state', fields({ sessionId: id }), (owner, input, signal) => owner.state({ ...input, signal })),
  'context.authorNote': entry('rpContext', null, 'authorNote', fields({ sessionId: id }), (owner, input, signal) => owner.authorNote({ ...input, signal })),
  'routes.inspect': entry('loopStudio', null, 'inspect', fields({ sessionId: id }), (owner, input, signal) => owner.inspect(input.sessionId, signal)),
  'story.state': entry('rpGM', 1, 'storyState', fields({ sessionId: id }), (owner, input, signal) => owner.storyState({ ...input, signal })),
})

export const APPLY = Object.freeze({
  'assets.import': entry('rpStoryKit', 1, 'importAsset', fields({ format: enumOf(['json', 'png']), expectedRevision: rev }, { rawText: text, dataBase64: text, name: id }), (owner, input, signal) => owner.importAsset({ ...input, signal })),
  'assets.createCharacter': entry('rpStoryKit', 1, 'createCharacter', fields({ character: object, expectedRevision: rev }), (owner, input, signal) => owner.createCharacter({ ...input, signal })),
  'assets.saveCharacter': entry('rpStoryKit', 1, 'saveCharacter', fields({ character: object, expectedRevision: rev }), (owner, input, signal) => owner.saveCharacter({ ...input, signal })),
  'assets.createPersona': entry('rpStoryKit', 1, 'createPersona', fields({ persona: object, expectedRevision: rev }), (owner, input, signal) => owner.createPersona({ ...input, signal })),
  'assets.savePersona': entry('rpStoryKit', 1, 'savePersona', fields({ persona: object, expectedRevision: rev }), (owner, input, signal) => owner.savePersona({ ...input, signal })),
  'assets.importWorldbook': entry('rpStoryKit', 1, 'importWorldbook', fields({ assetId: id, version: ver, descriptorId: id, expectedRevision: rev, expectedDatabaseRevision: rev }), (owner, input, signal) => owner.importWorldbook({ ...input, signal })),
  'assets.importPack': entry('rpStoryKit', 1, 'importPack', fields({ pack: object, expectedRevision: rev }), (owner, input, signal) => owner.importPack({ ...input, signal })),
  'database.import': entry('rpDatabase', 2, 'import', fields({ rawText: text, expectedRevision: rev }, { name: id }), (owner, input, signal) => owner.import({ ...input, signal })),
  'database.importDocument': entry('rpDatabase', 2, 'importDocument', fields({ name: id, mimeType: enumOf(['text/plain', 'text/markdown', 'application/pdf']), requestId: id, expectedRevision: rev }, { text, dataBase64: text }), (owner, input, signal) => owner.importDocument({ ...input, signal })),
  'database.save': entry('rpDatabase', 2, 'save', fields({ database: object, expectedRevision: rev }), (owner, input, signal) => owner.save({ ...input, signal })),
  'database.bindSources': entry('rpDatabase', 2, 'bindSources', fields({ sessionId: id, sources, expectedRevision: rev, resetOverlay: value => value === false }), (owner, input, signal) => owner.bindSources({ ...input, resetOverlay: false, signal })),
  'presets.create': entry('rpLastStep', 1, 'createProfile', fields({ name: id, expectedRevision: rev }), (owner, input, signal) => owner.createProfile(input, signal)),
  'presets.import': entry('rpLastStep', 1, 'importSillyTavern', fields({ rawText: text, expectedRevision: rev }, { name: id, orderCharacterId: orderId }), (owner, input, signal) => owner.importSillyTavern(input, signal)),
  'presets.save': entry('rpLastStep', 1, 'saveProfile', fields({ profile: object, expectedRevision: rev }), (owner, input, signal) => owner.saveProfile(input, signal)),
  'presets.migrate': entry('rpLastStep', 1, 'migrate', fields({ sessionId: id, profileId: id, version: ver, expectedRevision: rev }), (owner, input, signal) => owner.migrate(input, signal)),
  'presets.bind': entry('rpLastStep', 1, 'bindSession', fields({ sessionId: id, profileId: id, version: ver, expectedRevision: rev }), (owner, input, signal) => owner.bindSession(input, signal)),
  'context.configure': entry('rpContext', null, 'configure', fields({ sessionId: id, settings, expectedRevision: rev }), (owner, input, signal) => owner.configure({ ...input, signal })),
  'context.setAuthorNote': entry('rpContext', null, 'setAuthorNote', fields({ sessionId: id, text, expectedRevision: rev }), (owner, input, signal) => owner.setAuthorNote({ ...input, signal })),
  'routes.save': entry('loopStudio', null, 'savePolicy', fields({ sessionId: id, scope: enumOf(['session', 'preset']), expectedRevision: rev, policy: object }, { presetId: id }), (owner, input, signal) => owner.savePolicy(input, signal)),
  'routes.reset': entry('loopStudio', null, 'resetPolicy', fields({ sessionId: id, scope: enumOf(['session', 'preset']), expectedRevision: rev }, { presetId: id }), (owner, input, signal) => owner.resetPolicy(input, signal)),
  'story.launch': entry('rpStoryKit', 1, 'launch', fields({ launchId: id, character: assetRef, persona: assetRef, openingId: id, sources, initialScene: object, initialFacts: objectOrArray }, { profile: profileRef }), (owner, input, signal) => owner.launch({ ...input, signal })),
  'story.resumeLaunch': entry('rpStoryKit', 1, 'resumeLaunch', fields({ launchId: id }), (owner, input, signal) => owner.resumeLaunch({ ...input, signal })),
})

export function validateInput(definition, input) {
  if (!object(input) || Object.keys(input).some(key => !Object.hasOwn(definition.required, key) && !Object.hasOwn(definition.optional, key))) fail('INVALID_ARGUMENTS', '操作 input 含未知字段，或不是 JSON 对象。')
  for (const [key, validate] of Object.entries(definition.required)) if (!Object.hasOwn(input, key) || !validate(input[key])) fail('INVALID_ARGUMENTS', `需要有效的 ${key}。`)
  for (const [key, validate] of Object.entries(definition.optional)) if (Object.hasOwn(input, key) && !validate(input[key])) fail('INVALID_ARGUMENTS', `${key} 无效。`)
}

export function validateOperation(table, args) {
  if (!object(args) || Object.keys(args).some(key => !['operation', 'input'].includes(key)) || !Object.hasOwn(table, args.operation)) fail('UNKNOWN_OPERATION', '未提供已支持的固定 RP 操作；请先 inspect overview。')
  const definition = table[args.operation]
  validateInput(definition, args.input)
  const input = structuredClone(args.input)
  if (args.operation === 'assets.import' && (input.format === 'json' ? typeof input.rawText !== 'string' || input.dataBase64 !== undefined : typeof input.dataBase64 !== 'string' || input.rawText !== undefined)) fail('INVALID_ARGUMENTS', 'JSON 需要 rawText，PNG 需要 dataBase64；文件请使用 import_file。')
  if (args.operation === 'database.importDocument' && ((input.text === undefined) === (input.dataBase64 === undefined) || input.mimeType === 'application/pdf' && input.text !== undefined)) fail('INVALID_ARGUMENTS', '资料需要且仅需要 text 或 dataBase64；PDF 使用原始 bytes。')
  for (const [suffix, key] of [['Character', 'character'], ['Persona', 'persona']]) {
    if (args.operation === `assets.create${suffix}` && ['id', 'version', 'sourceId'].some(field => Object.hasOwn(input[key], field))) fail('INVALID_ARGUMENTS', '创建资产不可伪造 ID、版本或来源。')
    if (args.operation === `assets.save${suffix}` && (!id(input[key].id) || !ver(input[key].version))) fail('INVALID_ARGUMENTS', '保存资产需要真实 ID 与 base version。')
  }
  if (input.rawText?.length > 8_000_000 || input.text?.length > 8_000_000 || input.dataBase64?.length > 32_000_000) fail('FILE_TOO_LARGE', '导入内容超出工具大小上限。')
  return { definition, input }
}

export function supported(definition, owner) {
  return !!owner && (definition.apiVersion === null || owner.apiVersion === definition.apiVersion) && typeof owner[definition.method] === 'function'
}

export const FILE_KINDS = Object.freeze(['character', 'worldbook', 'preset', 'document', 'content-pack'])
export function validateFileInput(input) {
  validateInput(fields({ kind: enumOf(FILE_KINDS), path: value => text(value) && !!value.trim(), expectedRevision: rev }, { name: id, requestId: id, orderCharacterId: orderId }), input)
  if (input.kind === 'document' && !id(input.requestId)) fail('INVALID_ARGUMENTS', '文档导入必须提供稳定 requestId。')
  if (input.kind !== 'document' && input.requestId !== undefined || input.kind !== 'preset' && input.orderCharacterId !== undefined) fail('INVALID_ARGUMENTS', 'requestId 仅用于文档，orderCharacterId 仅用于预设。')
}
