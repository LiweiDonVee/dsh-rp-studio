export const SERVICES = {
  database: { key: 'rpDatabase', apiVersion: 2, methods: ['import', 'bindSources', 'effectiveV2', 'searchV2', 'patchV2', 'importDocument', 'document', 'indexState', 'rebuildIndex', 'exportContent', 'importContent', 'exportState', 'preflightRestore', 'restoreState', 'contentRevision'] },
  context: { key: 'rpContext', methods: ['state', 'configure', 'prepare', 'authorNote', 'setAuthorNote', 'material', 'exportState', 'preflightRestore', 'restoreState', 'contentRevision'] },
  lastStep: { key: 'rpLastStep', methods: ['ensureBuiltinProfile', 'narratives', 'presentationSummaries', 'material', 'createDraft', 'editDraft', 'drafts', 'adoptDraft', 'retryPresentation', 'inheritSession', 'exportContent', 'importContent', 'exportState', 'preflightRestore', 'restoreState', 'contentRevision'] },
  gm: { key: 'rpGM', apiVersion: 1, methods: ['listStories', 'binding', 'storyState', 'forkStory', 'rollbackStory', 'exportState', 'preflightRestore', 'restoreState', 'contentRevision', 'reserveRestore', 'activateRestored'] },
  storyKit: { key: 'rpStoryKit', apiVersion: 1, methods: ['state', 'asset', 'importAsset', 'importWorldbook', 'createPersona', 'launch', 'resumeLaunch', 'exportPack', 'previewPack', 'importPack', 'exportReading', 'exportSavedStory', 'previewSavedStory', 'restoreSavedStory'] },
  loop: { key: 'loopStudio', methods: ['inspect', 'savePolicy'] },
}
export const STORY_KIT_CAPS = ['databaseImport', 'packExport', 'packImport', 'launch', 'readingExport', 'savedStoryExport', 'savedStoryPreview', 'savedStoryRestore']
export const SCENARIOS = ['png-worldbook-persona-opening', 'facts-once', 'context-search-history-note', 'frozen-writer-and-restricted-retry', 'manual-generated-draft-version-adoption', 'next-turn-branch-cold-restart', 'document-index-cache', 'content-pack-new-story', 'exact-id-second-home-continue-rollback']

export function assessServices(observed) {
  const deferred = []
  for (const [name, definition] of Object.entries(SERVICES)) {
    const actual = observed.services?.[name]
    if (!actual?.available) { deferred.push({ code: 'SERVICE_MISSING', service: name }); continue }
    if (definition.apiVersion !== undefined && actual.apiVersion !== definition.apiVersion) deferred.push({ code: 'API_VERSION_MISMATCH', service: name, expected: definition.apiVersion, actual: actual.apiVersion })
    for (const method of definition.methods) if (actual.methods?.[method] !== true) deferred.push({ code: 'METHOD_MISSING', service: name, method })
  }
  for (const capability of STORY_KIT_CAPS) if (observed.storyKitCapabilities?.[capability] !== true) deferred.push({ code: 'CAPABILITY_UNAVAILABLE', service: 'storyKit', capability })
  return { interfacesReady: deferred.length === 0, deferred, scenarios: SCENARIOS.map(id => ({ id, status: 'not-run' })) }
}
