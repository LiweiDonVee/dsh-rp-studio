import type { ProductDataStore } from './product-service.js'
import type { SessionDetail } from '@dsh-rp/protocol'

export const productDetail = {
  session: { id: 'session-1', cardId: 'zombie-world', title: '档案', updatedAt: 1, running: false, blank: false },
  card: { id: 'zombie-world', title: '世界', description: '', world: '虚构世界', protagonist: '玩家', art: 'zombie-world', accent: 'crimson' },
  messages: [],
  state: { started: true, relationships: [], faction: [], inventory: [], memories: [{ id: 'm-1', text: '公开记忆' }], quests: [], eventLog: [], statusLines: [], extensions: {}, checkpoints: { count: 0, canRollback: false, activeTurn: null } },
} satisfies SessionDetail

export function fakeProductStore(): ProductDataStore {
  return {
    status: async () => ({ storage: 'ready', schemaVersion: 1, projection: 'current' }), close: async () => {},
    listAssets: async () => ({ items: [], nextCursor: null }), putAsset: async input => input.metadata, readAsset: async () => undefined, updateAsset: async () => undefined, deleteAsset: async () => false,
    listLedger: async () => ({ items: [], nextCursor: null }), appendLedger: async (_scope, input) => ({ id: 'ledger-1', ...input, createdAt: '2026-09-08T12:00:00.000Z' }),
    listKnowledge: async () => ({ items: [], nextCursor: null }), createKnowledge: async (_scope, input) => ({ id: 'knowledge-1', text: input.text, source: 'user', createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z' }), updateKnowledge: async () => undefined, deleteKnowledge: async () => false,
    listMemories: async () => ({ items: [], nextCursor: null }), listRelationships: async () => ({ items: [], nextCursor: null }), listLocations: async () => ({ items: [], nextCursor: null }), replaceProjections: async () => {},
    readNotifications: async (_scope, cursor) => ({ items: [], cursor: cursor ?? 'cursor-0', resetRequired: false }), appendNotification: async (_scope, input) => ({ ...input, cursor: `cursor-${input.id}`, acknowledged: false }), acknowledgeNotification: async () => false,
    listBackups: async () => ({ items: [], nextCursor: null }), createBackup: async scope => ({ id: 'backup-1', schemaVersion: 1, scope, createdAt: '2026-09-08T12:00:00.000Z', state: 'ready', manifestHash: `sha256:${'a'.repeat(64)}`, includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false } }), stageRestore: async () => undefined, commitRestore: async () => undefined,
    exportBackup: async () => undefined, importBackup: async scope => ({ id: 'backup-imported', schemaVersion: 1, scope, createdAt: '2026-09-08T12:00:00.000Z', state: 'ready', manifestHash: `sha256:${'c'.repeat(64)}`, includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false } }),
    savePairingToken: async () => {}, findPairingToken: async () => undefined, listPairingClients: async () => [], revokePairingClient: async () => false,
  }
}
