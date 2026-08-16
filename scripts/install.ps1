[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$SkipSnapshot
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm is required. Install pnpm 11 or enable it through Corepack.'
}

$presetRoot = Join-Path $DshHome '.agent-presets'
$presetRootResolved = if (Test-Path -LiteralPath $presetRoot) { (Resolve-Path -LiteralPath $presetRoot).Path } else { $null }
$presets = @('rp-runtime', 'zombie-world')
$snapshotFiles = @('agent.cordis.yml', 'rp-card.json', 'plugins\rp-engine.js', 'plugins\rp-runtime.js')

if (-not $SkipSnapshot -and $presetRootResolved) {
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
  $snapshotRoot = Join-Path $projectRoot ".snapshots\$stamp-before-install"
  New-Item -ItemType Directory -Force -Path $snapshotRoot | Out-Null
  $manifest = @('# RP Runtime Snapshot', '', "Captured: $(Get-Date -Format o)", '')

  foreach ($preset in $presets) {
    foreach ($relativeFile in $snapshotFiles) {
      $source = Join-Path (Join-Path $presetRoot $preset) $relativeFile
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
      $resolvedSource = (Resolve-Path -LiteralPath $source).Path
      if (-not $resolvedSource.StartsWith($presetRootResolved, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Snapshot source escaped DSH preset root: $resolvedSource"
      }
      $destination = Join-Path (Join-Path $snapshotRoot $preset) $relativeFile
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $resolvedSource -Destination $destination
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
      $manifest += "- ``$hash``  ``$preset\$relativeFile``"
    }
  }
  $manifest | Set-Content -LiteralPath (Join-Path $snapshotRoot 'MANIFEST.md') -Encoding utf8
  Write-Host "Snapshot: $snapshotRoot"
}

& pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

& pnpm check
if ($LASTEXITCODE -ne 0) { throw 'Build verification failed.' }

foreach ($preset in $presets) {
  $manifestPath = Join-Path (Join-Path $presetRoot $preset) 'rp-card.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Write-Warning "RP card manifest not installed: $manifestPath"
  }
}

Write-Host 'DSH RP Studio installation verified.'
