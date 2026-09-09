import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopApi } from './api.js'
import { createSessionNotificationMonitor } from './session-notifications.js'

const desktop = createDesktopApi((channel, input) => ipcRenderer.invoke(channel, input))
contextBridge.exposeInMainWorld('dshDesktop', desktop)

const notificationMonitor = createSessionNotificationMonitor(
  () => {
    try { return globalThis.localStorage?.getItem('dsh-rp-studio:last-session') ?? null } catch { return null }
  },
  sessionId => desktop.subscribeNotifications(sessionId),
)
globalThis.addEventListener('pagehide', () => notificationMonitor.stop(), { once: true })
