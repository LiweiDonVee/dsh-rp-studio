import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../shared/ipc-schema.js'
import { isIpcOperationAllowed } from './ipc-capability.js'
import { trustedPageForIpcSender } from './ipc-trust.js'
import { runDesktopDoctor } from './desktop-doctor.js'
import { validateNodeExecutable } from './runtime-doctor.js'
import type { GatewayClient } from './gateway-client.js'
import type { GatewayNotificationSubscriber } from './notification-subscriber.js'
import type { DesktopSettings, PathSelectionVault, SettingsStore } from './settings.js'
import type { DesktopSupervisor } from './supervisor-adapter.js'
import { isAllowedNavigation } from './policy.js'
import { validateRuntimeSettings } from './runtime-discovery.js'

export { isTrustedIpcSender } from './ipc-trust.js'

export interface IpcDependencies {
  window: BrowserWindow
  localUrl: string
  getStudioUrl(): string | undefined
  setStudioUrl(url: string | undefined): void
  getSettings(): DesktopSettings
  settingsStore: SettingsStore
  selections: PathSelectionVault
  getSupervisor(): DesktopSupervisor
  onSettingsSaved(settings: DesktopSettings): Promise<void>
  onStudioStarted(url: string): Promise<void>
  gateway: GatewayClient
  notifications: GatewayNotificationSubscriber
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const handler = async (event: IpcMainInvokeEvent, request: unknown): Promise<unknown> => {
    const input = parseIpcRequest(request)
    const page = trustedPageForIpcSender(event, dependencies.window.webContents, dependencies.getStudioUrl(), dependencies.localUrl)
    if (!page || !isIpcOperationAllowed(page, input.type)) throw new Error('IPC operation is not allowed for this page')
    let output: unknown
    switch (input.type) {
      case 'status': output = await dependencies.getSupervisor().status(); break
      case 'doctor': output = await runDesktopDoctor(dependencies.getSettings().nodeExecutable, dependencies.getSupervisor()); break
      case 'get-settings': output = dependencies.selections.expose(dependencies.getSettings()); break
      case 'choose-runtime-path': {
        const directory = input.field === 'dshHome' || input.field === 'runtimeRoot'
        const result = await dialog.showOpenDialog(dependencies.window, { properties: directory ? ['openDirectory', 'createDirectory'] : ['openFile'] })
        const selectedPath = result.filePaths[0]
        if (result.canceled || !selectedPath) { output = { selected: false }; break }
        if (input.field === 'nodeExecutable') {
          const diagnostics = await validateNodeExecutable(selectedPath)
          if (diagnostics.length > 0) throw new Error('Selected executable must be an independent Node.js 24 runtime')
        }
        output = { selected: true, ...dependencies.selections.select(input.field, selectedPath) }
        break
      }
      case 'save-settings': {
        const settings = dependencies.selections.consume(
          dependencies.getSettings(),
          Object.fromEntries(Object.entries(input.selections).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          input.dshPort,
          input.studioPort,
        )
        const nodeDiagnostics = await validateNodeExecutable(settings.nodeExecutable)
        if (nodeDiagnostics.length > 0) throw new Error('Selected executable must be an independent Node.js 24 runtime')
        await dependencies.settingsStore.save(settings)
        await dependencies.onSettingsSaved(settings)
        output = { ok: true }
        break
      }
      case 'start': {
        const invalid = await validateRuntimeSettings(dependencies.getSettings())
        if (invalid.length > 0) throw new Error(`Runtime setup is incomplete: ${invalid.join(', ')}`)
        const result = await dependencies.getSupervisor().start()
        if (!isAllowedNavigation(result.studioUrl, result.studioUrl)) throw new Error('Supervisor returned an unsafe Studio origin')
        const origin = new URL(result.studioUrl).origin
        dependencies.setStudioUrl(origin)
        await dependencies.onStudioStarted(origin)
        output = { ok: true, studioUrl: origin }
        break
      }
      case 'stop':
        dependencies.notifications.stop()
        await dependencies.getSupervisor().stop()
        dependencies.setStudioUrl(undefined)
        output = { ok: true }
        break
      case 'import-asset': {
        const origin = dependencies.getStudioUrl()
        if (!origin) throw new Error('Studio is not running')
        const result = await dialog.showOpenDialog(dependencies.window, { properties: ['openFile'], filters: [{ name: 'Supported assets', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'ogg', 'wav', 'pdf'] }] })
        const selectedPath = result.filePaths[0]
        output = result.canceled || !selectedPath ? { selected: false } : { selected: true, ...await dependencies.gateway.uploadAsset(origin, input.sessionId, selectedPath) }
        break
      }
      case 'backup-export': {
        const result = await dialog.showOpenDialog(dependencies.window, { properties: ['openDirectory', 'createDirectory'] })
        const selectedPath = result.filePaths[0]
        const origin = dependencies.getStudioUrl()
        if (!origin) throw new Error('Studio is not running')
        output = result.canceled || !selectedPath ? { selected: false } : { selected: true, ...await dependencies.gateway.exportBackup(origin, input.sessionId, selectedPath) }
        break
      }
      case 'backup-import': {
        const result = await dialog.showOpenDialog(dependencies.window, { properties: ['openFile'], filters: [{ name: 'DSH RP Studio backup', extensions: ['dsh-rp-backup'] }] })
        const selectedPath = result.filePaths[0]
        const origin = dependencies.getStudioUrl()
        if (!origin) throw new Error('Studio is not running')
        output = result.canceled || !selectedPath ? { selected: false } : { selected: true, ...await dependencies.gateway.importBackup(origin, input.sessionId, selectedPath) }
        break
      }
      case 'subscribe-notifications': {
        const origin = dependencies.getStudioUrl()
        if (!origin) throw new Error('Studio is not running')
        await dependencies.notifications.start(origin, input.sessionId)
        output = { ok: true }
        break
      }
    }
    return parseIpcResponse(input.type, output)
  }
  ipcMain.handle('desktop:request', handler)
  return () => ipcMain.removeHandler('desktop:request')
}
