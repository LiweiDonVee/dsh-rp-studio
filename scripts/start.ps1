[CmdletBinding()]
param(
  [int]$Port = 4317,
  [int]$DshPort = 3080,
  [int]$PromptPresetsPort = 3091,
  [switch]$NoBuild,
  [switch]$ProbeOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if ($Port -lt 1 -or $Port -gt 65535) { throw 'Studio port must be between 1 and 65535.' }
if ($DshPort -lt 1 -or $DshPort -gt 65535) { throw 'DSH port must be between 1 and 65535.' }
if ($PromptPresetsPort -lt 1 -or $PromptPresetsPort -gt 65535) { throw 'Prompt Presets port must be between 1 and 65535.' }

$probeOutput = & node (Join-Path $PSScriptRoot 'launcher-ports.mjs') $Port $DshPort $PromptPresetsPort 2>&1
if ($LASTEXITCODE -ne 0) { throw ($probeOutput -join [Environment]::NewLine) }
$probe = $probeOutput | ConvertFrom-Json

if ($ProbeOnly) {
  $probeOutput
  return
}
if ($probe.existing) {
  Write-Host "DSH RP Studio is already running: http://127.0.0.1:$Port"
  return
}
$selectedPort = ([uri]$probe.studioUrl).Port

if (-not $NoBuild) {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
}

$env:DSH_BASE_URL = "http://127.0.0.1:$DshPort"
$env:PROMPT_PRESETS_BASE_URL = "http://127.0.0.1:$PromptPresetsPort/prompt-presets/api"
$env:DSH_RP_HOST = '127.0.0.1'
$env:DSH_RP_PORT = [string]$selectedPort
Write-Host "DSH RP Studio: http://127.0.0.1:$selectedPort"
Write-Host "DSH upstream:   http://127.0.0.1:$DshPort"
Write-Host "Prompt presets: http://127.0.0.1:$PromptPresetsPort/prompt-presets/api"

& pnpm --filter '@dsh-rp/gateway' start
if ($LASTEXITCODE -ne 0) { throw 'RP Gateway exited with an error.' }
