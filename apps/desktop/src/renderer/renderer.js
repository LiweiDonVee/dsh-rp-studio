const status = document.querySelector('#status')
const diagnostics = document.querySelector('#diagnostics')
const dshPort = document.querySelector('#dshPort')
const studioPort = document.querySelector('#studioPort')
const startButton = document.querySelector('#start')
const desktop = globalThis.dshDesktop
const selections = {}
const requiredFields = ['nodeExecutable', 'dshBin', 'gatewayEntry', 'dshHome', 'runtimeRoot']
function updateStartEnabled() { startButton.disabled = requiredFields.some(field => !selections[field]) }

async function showDiagnostics() {
  try { diagnostics.textContent = JSON.stringify(await desktop.doctor(), null, 2) }
  catch { diagnostics.textContent = 'Diagnostics failed. No private runtime details were displayed.' }
}

async function save() {
  return desktop.saveSettings({ selections, dshPort: Number(dshPort.value), studioPort: Number(studioPort.value) })
}

document.querySelector('#doctor')?.addEventListener('click', showDiagnostics)
document.querySelector('#save')?.addEventListener('click', async () => { await save(); await showDiagnostics() })
document.querySelector('#start')?.addEventListener('click', async () => {
  try { await save(); await desktop.start() } catch { diagnostics.textContent = 'Start failed. Run diagnostics for safe details.' }
})
document.querySelectorAll('[data-field]').forEach(button => button.addEventListener('click', async () => {
  const field = button.dataset.field
  const result = await desktop.chooseRuntimePath(field)
  if (!result.selected) return
  selections[field] = result.selectionId
  document.querySelector(`[data-label="${field}"]`).textContent = result.label
  updateStartEnabled()
}))

if (desktop) {
  Promise.all([desktop.status(), desktop.getSettings()]).then(([result, settings]) => {
    status.textContent = `Studio status: ${result.state}`
    Object.assign(selections, Object.fromEntries(Object.entries(settings.selections).map(([field, value]) => [field, value.selectionId])))
    for (const [field, value] of Object.entries(settings.selections)) document.querySelector(`[data-label="${field}"]`).textContent = value.label
    updateStartEnabled()
    dshPort.value = String(settings.dshPort)
    studioPort.value = String(settings.studioPort)
    document.documentElement.dataset.ipcReady = 'true'
  }).catch(() => { status.textContent = 'Studio diagnostics unavailable' })
  void showDiagnostics()
} else status.textContent = 'Secure desktop bridge unavailable'
