import { parseIpcRequest, parseIpcResponse, type DesktopDoctor, type DesktopStatus, type IpcRequest, type PublicSettings, type RuntimePathField } from '../shared/ipc-schema.js'

export type IpcInvoker = (channel: string, input: IpcRequest) => Promise<unknown>

export interface DesktopApi {
  status(): Promise<DesktopStatus>
  doctor(): Promise<DesktopDoctor>
  getSettings(): Promise<PublicSettings>
  chooseRuntimePath(field: RuntimePathField): Promise<unknown>
  saveSettings(input: { selections: Partial<Record<RuntimePathField, string>>; dshPort: number; studioPort: number }): Promise<unknown>
  start(): Promise<unknown>
  stop(): Promise<unknown>
  importAsset(sessionId: string): Promise<unknown>
  exportBackup(sessionId: string): Promise<unknown>
  importBackup(sessionId: string): Promise<unknown>
  subscribeNotifications(sessionId: string): Promise<unknown>
}

export function createDesktopApi(invoke: IpcInvoker): Readonly<DesktopApi> {
  const send = async (candidate: unknown): Promise<unknown> => {
    const input = parseIpcRequest(candidate)
    return parseIpcResponse(input.type, await invoke('desktop:request', input))
  }
  return Object.freeze({
    status: async () => send({ type: 'status' }) as Promise<DesktopStatus>,
    doctor: async () => send({ type: 'doctor' }) as Promise<DesktopDoctor>,
    getSettings: async () => send({ type: 'get-settings' }) as Promise<PublicSettings>,
    chooseRuntimePath: (field: RuntimePathField) => send({ type: 'choose-runtime-path', field }),
    saveSettings: (input: { selections: Partial<Record<RuntimePathField, string>>; dshPort: number; studioPort: number }) => send({ type: 'save-settings', ...input }),
    start: () => send({ type: 'start' }),
    stop: () => send({ type: 'stop' }),
    importAsset: (sessionId: string) => send({ type: 'import-asset', sessionId }),
    exportBackup: (sessionId: string) => send({ type: 'backup-export', sessionId }),
    importBackup: (sessionId: string) => send({ type: 'backup-import', sessionId }),
    subscribeNotifications: (sessionId: string) => send({ type: 'subscribe-notifications', sessionId }),
  })
}
