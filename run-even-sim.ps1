param(
  [string]$HostIp = "127.0.0.1",
  [int]$Port = 5173,
  [int]$ControlPort = 8787,
  [string]$SimulatorPath = "",
  [int]$StartupTimeoutSec = 45
)

$ErrorActionPreference = "Stop"

function Write-Info {
  param([string]$Message)
  Write-Host "[even-g2] $Message" -ForegroundColor Cyan
}

function Resolve-SimulatorPath {
  param([string]$ManualPath)

  if ($ManualPath -and (Test-Path $ManualPath)) {
    return $ManualPath
  }

  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Even Hub\Even Hub.exe",
    "$env:LOCALAPPDATA\Programs\EvenHub\EvenHub.exe",
    "$env:ProgramFiles\Even Hub\Even Hub.exe",
    "$env:ProgramFiles\EvenHub\EvenHub.exe",
    "$env:ProgramFiles(x86)\Even Hub\Even Hub.exe",
    "$env:ProgramFiles(x86)\EvenHub\EvenHub.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

function Wait-ForUrl {
  param(
    [string]$Url,
    [int]$TimeoutSec
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 2 -UseBasicParsing
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  return $false
}

function Stop-ListenersOnPort {
  param([int]$Port)

  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $listeners) {
    return
  }

  $listenerPids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $listenerPids) {
    if ($procId -and $procId -gt 0) {
      try {
        Write-Info "Stopping existing listener PID $procId on port $Port"
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      } catch {}
    }
  }
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if (-not (Test-Path "$projectRoot\package.json")) {
  throw "package.json not found in $projectRoot"
}

$npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  throw "npm.cmd was not found in PATH. Install Node.js/npm and restart terminal."
}

$uiUrl = "http://${HostIp}:${Port}"
$controlUrl = "http://${HostIp}:${ControlPort}/health"

Stop-ListenersOnPort -Port $Port
Stop-ListenersOnPort -Port $ControlPort

Write-Info "Starting local control service on port $ControlPort"
$controlProcess = Start-Process `
  -FilePath $npmCmd.Source `
  -ArgumentList @("run", "control") `
  -WorkingDirectory $projectRoot `
  -PassThru

Write-Info "Starting app dev server on $uiUrl"
$devProcess = Start-Process `
  -FilePath $npmCmd.Source `
  -ArgumentList @("run", "dev", "--", "--host", $HostIp, "--port", "$Port", "--strictPort") `
  -WorkingDirectory $projectRoot `
  -PassThru

if (-not (Wait-ForUrl -Url $uiUrl -TimeoutSec $StartupTimeoutSec)) {
  throw "Dev server did not become ready at $uiUrl within $StartupTimeoutSec seconds."
}

if (-not (Wait-ForUrl -Url $controlUrl -TimeoutSec $StartupTimeoutSec)) {
  throw "Control service did not become ready at $controlUrl within $StartupTimeoutSec seconds."
}

if (-not (Get-Process -Id $devProcess.Id -ErrorAction SilentlyContinue)) {
  throw "Dev server process exited unexpectedly."
}

if (-not (Get-Process -Id $controlProcess.Id -ErrorAction SilentlyContinue)) {
  throw "Control service process exited unexpectedly."
}

Write-Info "Opening app URL in browser: $uiUrl"
Start-Process $uiUrl | Out-Null

$simPath = Resolve-SimulatorPath -ManualPath $SimulatorPath
if ($simPath) {
  Write-Info "Launching simulator: $simPath"
  Start-Process -FilePath $simPath | Out-Null
} else {
  Write-Warning "Even Hub simulator executable not found automatically."
  Write-Host "Open Even Hub manually, then load URL: $uiUrl"
}

Write-Info "Ready. Use Publish button in the app to generate/open QR."
Write-Info "App PID: $($devProcess.Id), Control PID: $($controlProcess.Id)"
Write-Host "Press Ctrl+C in this window when done testing."

try {
  Wait-Process -Id $devProcess.Id
} finally {
  foreach ($procId in @($devProcess.Id, $controlProcess.Id)) {
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
      Stop-Process -Id $procId -Force
    }
  }
}
