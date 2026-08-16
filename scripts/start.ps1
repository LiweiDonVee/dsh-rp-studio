[CmdletBinding()]
param(
  [int]$Port = 4317,
  [int]$DshPort = 3080,
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Test-LocalPortAvailable([int]$Candidate) {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Candidate)
  try {
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    $listener.Stop()
  }
}

try {
  $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 2
  if ($existing.protocolVersion -eq 1) {
    Write-Host "DSH RP Studio is already running: http://127.0.0.1:$Port"
    return
  }
} catch {
  # The preferred port is either free or belongs to another local process.
}

$selectedPort = $Port
while (-not (Test-LocalPortAvailable $selectedPort)) {
  $selectedPort++
  if ($selectedPort -gt ($Port + 20)) { throw 'No local RP Studio port is available.' }
}

if (-not $NoBuild) {
  & pnpm --filter '@dsh-rp/web' build
  if ($LASTEXITCODE -ne 0) { throw 'Web production build failed.' }
}

$env:DSH_BASE_URL = "http://127.0.0.1:$DshPort"
$env:DSH_RP_HOST = '127.0.0.1'
$env:DSH_RP_PORT = [string]$selectedPort
Write-Host "DSH RP Studio: http://127.0.0.1:$selectedPort"
Write-Host "DSH upstream:   http://127.0.0.1:$DshPort"

& pnpm --filter '@dsh-rp/gateway' start
if ($LASTEXITCODE -ne 0) { throw 'RP Gateway exited with an error.' }
