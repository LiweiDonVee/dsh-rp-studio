import type { IpcRequestType } from '../shared/ipc-schema.js'

export type TrustedPage = 'local' | 'studio'

const localOperations = new Set<IpcRequestType>([
  'status', 'doctor', 'get-settings', 'choose-runtime-path', 'save-settings', 'start', 'stop',
])
const studioOperations = new Set<IpcRequestType>([
  'status', 'import-asset', 'backup-export', 'backup-import', 'subscribe-notifications',
])

export function isIpcOperationAllowed(page: TrustedPage, operation: IpcRequestType): boolean {
  return (page === 'local' ? localOperations : studioOperations).has(operation)
}
