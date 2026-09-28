[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm is required. Install pnpm 11 or enable it through Corepack.'
}

$profileRoot = Join-Path (Join-Path $DshHome 'profiles') 'web'
$profileManifest = Join-Path $profileRoot 'package.json'
if (Test-Path -LiteralPath $profileRoot) {
  if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) {
    throw "DSH rc2 web profile manifest is missing: $profileManifest"
  }
  $profile = Get-Content -Raw -LiteralPath $profileManifest | ConvertFrom-Json
  $bundles = @($profile.dsh.profile.bundles)
  if ($bundles.Count -eq 0) { throw "DSH rc2 web profile declares no plugin bundles: $profileManifest" }
  Write-Host "DSH rc2 web profile bundles: $($bundles -join ', ')"
} else {
  Write-Warning "DSH rc2 web profile is not present yet: $profileRoot"
}

& pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

& pnpm check
if ($LASTEXITCODE -ne 0) { throw 'Build verification failed.' }

Write-Host 'DSH RP Studio installation verified.'
