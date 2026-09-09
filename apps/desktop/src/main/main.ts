import { app, BrowserWindow, Menu, nativeImage, Notification, safeStorage, session, Tray } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGatewayClient } from './gateway-client.js'
import { registerIpcHandlers } from './ipc.js'
import { createGatewayNotificationSubscriber } from './notification-subscriber.js'
import { createShutdownCoordinator } from './orchestration.js'
import { isAllowedNavigation, isAllowedWindowOpen, shouldBlockDownload, shouldRevokeStudioTrust } from './policy.js'
import { discoverRuntimeSettings } from './runtime-discovery.js'
import { trayIconPath } from './tray-icon.js'
import { createPathSelectionVault, createSettingsStore, type DesktopSettings } from './settings.js'
import { createSupervisorAdapter, createSupervisorConfig, loadSupervisorConstructor, type DesktopSupervisor, type SupervisorConstructor } from './supervisor-adapter.js'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let trustedStudioOrigin: string | undefined
let settings: DesktopSettings
let supervisor: DesktopSupervisor = createSupervisorAdapter()
let supervisorConstructor: SupervisorConstructor | undefined

// Software rendering avoids Windows GPU-driver startup failures without relaxing renderer sandboxing.
app.disableHardwareAcceleration()

const localPage = join(app.getAppPath(), 'dist', 'renderer', 'index.html')
const localUrl = pathToFileURL(localPage).href
const settingsStore = createSettingsStore(app.getPath('userData'), safeStorage)
const selections = createPathSelectionVault()
const gateway = createGatewayClient()
const notifications = createGatewayNotificationSubscriber(value => {
  if (Notification.isSupported()) new Notification(value).show()
})

function configureSupervisor(): void {
  supervisor = supervisorConstructor ? createSupervisorAdapter(new supervisorConstructor(createSupervisorConfig(settings))) : createSupervisorAdapter()
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  const healthUrl = process.env.DSH_DESKTOP_SMOKE_HEALTH_URL
  const screenshotPath = process.env.DSH_DESKTOP_SMOKE_SCREENSHOT
  if (!healthUrl || !screenshotPath) throw new Error('Electron smoke configuration is incomplete')
  const health = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
  if (!health.ok) throw new Error('Electron smoke loopback health check failed')
  const deadline = Date.now() + 10_000
  let result: { title: string; status: string; bridge: boolean; ipcReady: boolean } | undefined
  while (Date.now() < deadline) {
    result = await window.webContents.executeJavaScript(`({ title: document.title, status: document.querySelector('#status')?.textContent || '', bridge: typeof globalThis.dshDesktop === 'object', ipcReady: document.documentElement.dataset.ipcReady === 'true' })`) as typeof result
    if (result?.bridge && result.ipcReady && result.status.includes('Studio status:')) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!result?.bridge || !result.ipcReady || !result.status.includes('Studio status:')) throw new Error('Electron smoke renderer IPC did not become ready')
  await writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG())
  console.log(`DSH_DESKTOP_SMOKE_RESULT:${JSON.stringify({ ...result, healthStatus: health.status, sandboxed: window.webContents.getOSProcessId() > 0 })}`)
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { preload: join(app.getAppPath(), 'dist', 'preload', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const removeIpc = registerIpcHandlers({
    window, localUrl,
    getStudioUrl: () => trustedStudioOrigin,
    setStudioUrl: value => { trustedStudioOrigin = value },
    getSettings: () => settings,
    settingsStore, selections,
    getSupervisor: () => supervisor,
    onSettingsSaved: async value => {
      await supervisor.stop()
      settings = value
      trustedStudioOrigin = undefined
      configureSupervisor()
    },
    onStudioStarted: async url => { setImmediate(() => { void window.loadURL(url) }) },
    gateway, notifications,
  })
  window.webContents.setWindowOpenHandler(({ url }) => ({ action: isAllowedWindowOpen(url) ? 'allow' : 'deny' }))
  const guardNavigation = (event: Electron.Event, target: string) => { if (!isAllowedNavigation(target, trustedStudioOrigin, localUrl)) event.preventDefault() }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
  window.on('closed', removeIpc)
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide() } })
  await window.loadURL(localUrl)
  window.show()
  return window
}

async function pollSupervisor(window: BrowserWindow): Promise<void> {
  if (!trustedStudioOrigin) return
  const status = await supervisor.status()
  if (!shouldRevokeStudioTrust(status)) return
  trustedStudioOrigin = undefined
  notifications.stop()
  await window.loadURL(localUrl)
}

async function boot(): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus() })
  await app.whenReady()
  const loadedSettings = await settingsStore.load()
  settings = await discoverRuntimeSettings(loadedSettings, app.getAppPath(), app.getPath('userData'), process.env)
  supervisorConstructor = await loadSupervisorConstructor(app.getAppPath())
  configureSupervisor()
  const shutdown = createShutdownCoordinator({ stop: async () => { notifications.stop(); await supervisor.stop() } })
  app.on('before-quit', event => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void shutdown.shutdown().finally(() => app.quit())
  })
  session.defaultSession.on('will-download', event => { if (shouldBlockDownload()) event.preventDefault() })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow = await createWindow()
  tray = new Tray(nativeImage.createFromPath(trayIconPath(app.getAppPath())))
  tray.setToolTip('DSH RP Studio')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Studio', click: () => { if (trustedStudioOrigin) void mainWindow?.loadURL(trustedStudioOrigin); mainWindow?.show() } },
    { label: 'Settings & Diagnostics', click: () => { void mainWindow?.loadURL(localUrl); mainWindow?.show() } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))
  setInterval(() => { if (mainWindow) void pollSupervisor(mainWindow) }, 1_000).unref()
  if (process.env.DSH_DESKTOP_SMOKE === '1') {
    try { await runSmoke(mainWindow) } catch (error) { console.error(error); process.exitCode = 1 } finally { app.quit() }
  } else {
    try {
      const started = await supervisor.start()
      if (!isAllowedNavigation(started.studioUrl, started.studioUrl)) throw new Error('Supervisor returned an unsafe Studio origin')
      trustedStudioOrigin = new URL(started.studioUrl).origin
      await mainWindow.loadURL(trustedStudioOrigin)
    } catch {
      // Stay on the bundled diagnostics page; status/doctor expose only safe public details.
      await mainWindow.loadURL(localUrl)
    }
  }
}

void boot().catch(error => { console.error(error); process.exitCode = 1; app.quit() })
