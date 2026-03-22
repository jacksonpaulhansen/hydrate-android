param(
  [string]$PublishUrl = "",
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

# Optional git publish step (config-driven)
if (Test-Path ".\publish-git.ps1") {
  if ($NonInteractive) {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-git.ps1 -NonInteractive
  } else {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-git.ps1
  }
  if ($LASTEXITCODE -ne 0) {
    throw "publish-git.ps1 failed with exit code $LASTEXITCODE"
  }
}

if (-not $PublishUrl) {
  $configPath = Join-Path $projectRoot "app.config.json"
  if (-not (Test-Path $configPath)) {
    throw "Missing app.config.json"
  }

  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  $PublishUrl = [string]$config.publishUrl
}

if (-not $PublishUrl) {
  throw "publishUrl is empty. Set app.config.json -> publishUrl."
}

Write-Host "[even-g2] Generating QR for: $PublishUrl" -ForegroundColor Cyan
node .\scripts\generate-qr.mjs "$PublishUrl"

$htmlPath = Join-Path $projectRoot "publish-qr.html"
if (Test-Path $htmlPath) {
  Start-Process $htmlPath | Out-Null
}
