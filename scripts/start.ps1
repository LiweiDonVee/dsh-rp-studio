[CmdletBinding()]
param(
  [int]$Port = 4317,
  [int]$DshPort = 3080,
  [switch]$NoBuild,
  [switch]$ProbeOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if ($Port -lt 1 -or $Port -gt 65535) { throw 'Studio port must be between 1 and 65535.' }
if ($DshPort -lt 1 -or $DshPort -gt 65535) { throw 'DSH port must be between 1 and 65535.' }

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
    if ($ProbeOnly) {
      [pscustomobject]@{ studioUrl = "http://127.0.0.1:$Port"; dshUrl = "http://127.0.0.1:$DshPort"; existing = $true } | ConvertTo-Json -Compress
      return
    }
    Write-Host "DSH RP Studio is already running: http://127.0.0.1:$Port"
    return
  }
} catch {
  # The preferred port is either free or belongs to another local process.
}

$selectedPort = $Port
$lastPort = [Math]::Min($Port + 20, 65535)
while (-not (Test-LocalPortAvailable $selectedPort)) {
  if ($selectedPort -ge $lastPort) { throw 'No local RP Studio port is available.' }
  $selectedPort++
}

if ($ProbeOnly) {
  [pscustomobject]@{ studioUrl = "http://127.0.0.1:$selectedPort"; dshUrl = "http://127.0.0.1:$DshPort"; existing = $false } | ConvertTo-Json -Compress
  return
}

if (-not $NoBuild) {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
}

$env:DSH_BASE_URL = "http://127.0.0.1:$DshPort"
$env:DSH_RP_HOST = '127.0.0.1'
$env:DSH_RP_PORT = [string]$selectedPort
Write-Host "DSH RP Studio: http://127.0.0.1:$selectedPort"
Write-Host "DSH upstream:   http://127.0.0.1:$DshPort"

& pnpm --filter '@dsh-rp/gateway' start
if ($LASTEXITCODE -ne 0) { throw 'RP Gateway exited with an error.' }
