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

function Write-Ok {
  param([string]$Message)
  Write-Host "[even-g2] OK: $Message" -ForegroundColor Green
}

function Write-WarnLog {
  param([string]$Message)
  Write-Host "[even-g2] WARN: $Message" -ForegroundColor Yellow
}

function Write-Step {
  param([string]$Message)
  Write-Host "[even-g2] STEP: $Message" -ForegroundColor Magenta
}

function Write-Detail {
  param([string]$Message)
  Write-Host "[even-g2]      $Message" -ForegroundColor DarkGray
}

function Test-NodeVersionSupported {
  param([string]$VersionText)

  if (-not $VersionText) {
    return $false
  }

  $normalized = $VersionText.Trim().TrimStart('v')
  try {
    $version = [Version]$normalized
  } catch {
    return $false
  }

  if ($version.Major -ge 22) {
    return $version -ge ([Version]'22.12.0')
  }

  if ($version.Major -eq 20) {
    return $version -ge ([Version]'20.19.0')
  }

  return $false
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

function Start-NpmSimulator {
  param(
    [string]$ProjectRoot,
    [string]$TargetUrl
  )

  $localSimCmd = Join-Path $ProjectRoot "node_modules\.bin\evenhub-simulator.cmd"
  if (-not (Test-Path $localSimCmd)) {
    return $false
  }

  Write-Info "Launching npm simulator: $localSimCmd $TargetUrl"
  $simCmdLine = "set RUST_LOG=error && `"$localSimCmd`" `"$TargetUrl`""
  Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/d", "/c", $simCmdLine) `
    -WorkingDirectory $ProjectRoot | Out-Null

  return $true
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

function Assert-Ready {
  param(
    [string]$Name,
    [string]$Url,
    [int]$TimeoutSec
  )

  Write-Step "Waiting for $Name"
  Write-Detail $Url
  if (-not (Wait-ForUrl -Url $Url -TimeoutSec $TimeoutSec)) {
    throw "$Name did not become ready at $Url within $TimeoutSec seconds."
  }
  Write-Ok "$Name is ready"
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

Write-Step "Hydrate Windows launcher starting"
Write-Detail "Project root: $projectRoot"

$npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  throw "npm.cmd was not found in PATH. Install Node.js/npm and restart terminal."
}
$nodeCmd = Get-Command "node.exe" -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "node.exe was not found in PATH. Install Node.js and restart terminal."
}
$viteCmd = Join-Path $projectRoot "node_modules\.bin\vite.cmd"
if (-not (Test-Path $viteCmd)) {
  throw "Vite is not installed at $viteCmd. Run npm install in the project root and try again."
}

Write-Ok "Resolved Node runtime"
Write-Detail "node.exe: $($nodeCmd.Source)"
Write-Detail "npm.cmd:  $($npmCmd.Source)"
Write-Detail "vite.cmd: $viteCmd"

$nodeVersionText = (& $nodeCmd.Source -v).Trim()
Write-Detail "node -v:  $nodeVersionText"

if (-not (Test-NodeVersionSupported -VersionText $nodeVersionText)) {
  throw "Unsupported Node.js version $nodeVersionText. Hydrate requires Node.js 20.19+ or 22.12+ for Vite 8."
}

$uiUrl = "http://${HostIp}:${Port}"
$glassesUrl = "${uiUrl}/glasses.html"
$controlUrl = "http://${HostIp}:${ControlPort}/health"

Stop-ListenersOnPort -Port $Port
Stop-ListenersOnPort -Port $ControlPort

Write-Step "Starting local control service"
Write-Detail "Command: `"$($nodeCmd.Source)`" scripts/control-server.mjs"
Write-Detail "Window:  Hydrate Control"
$controlProcess = Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList @("/d", "/c", "title Hydrate Control && `"$($nodeCmd.Source)`" scripts/control-server.mjs") `
  -WorkingDirectory $projectRoot `
  -PassThru

Write-Ok "Control process launched (PID $($controlProcess.Id))"

Write-Step "Starting app dev server"
Write-Detail "Command: `"$viteCmd`" --host $HostIp --port $Port --strictPort"
Write-Detail "Window:  Hydrate Dev Server"
Write-Detail "Phone:   $uiUrl"
Write-Detail "Glasses: $glassesUrl"
$devProcess = Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList @("/d", "/c", "title Hydrate Dev Server && `"$viteCmd`" --host $HostIp --port $Port --strictPort") `
  -WorkingDirectory $projectRoot `
  -PassThru

Write-Ok "Dev process launched (PID $($devProcess.Id))"

Assert-Ready -Name "App dev server" -Url $uiUrl -TimeoutSec $StartupTimeoutSec
Assert-Ready -Name "Control service" -Url $controlUrl -TimeoutSec $StartupTimeoutSec

if (-not (Get-Process -Id $devProcess.Id -ErrorAction SilentlyContinue)) {
  throw "Dev server process exited unexpectedly."
}

if (-not (Get-Process -Id $controlProcess.Id -ErrorAction SilentlyContinue)) {
  throw "Control service process exited unexpectedly."
}

Write-Step "Opening browser previews"
Write-Detail "Phone:   $uiUrl"
Start-Process $uiUrl | Out-Null
Write-Detail "Glasses: $glassesUrl"
Start-Process $glassesUrl | Out-Null
Write-Ok "Browser launches requested"

$simStarted = Start-NpmSimulator -ProjectRoot $projectRoot -TargetUrl $glassesUrl
if (-not $simStarted) {
  $simPath = Resolve-SimulatorPath -ManualPath $SimulatorPath
  if ($simPath) {
    Write-Step "Launching Even Hub simulator"
    Write-Detail $simPath
    Start-Process -FilePath $simPath -ArgumentList @($glassesUrl) | Out-Null
    $simStarted = $true
    Write-Ok "Simulator launch requested"
  }
}

if (-not $simStarted) {
  Write-WarnLog "Even Hub simulator was not found (npm package or executable)."
  Write-Detail "Install with: npm install -D @evenrealities/evenhub-simulator"
  Write-Detail "Then rerun this script."
}

Write-Ok "Hydrate local environment is ready"
Write-Detail "App PID:     $($devProcess.Id)"
Write-Detail "Control PID: $($controlProcess.Id)"
Write-Detail "Press Ctrl+C in this window when done testing."

try {
  Wait-Process -Id $devProcess.Id
} finally {
  Write-Step "Stopping child processes"
  foreach ($procId in @($devProcess.Id, $controlProcess.Id)) {
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
      Stop-Process -Id $procId -Force
      Write-Detail "Stopped PID $procId"
    }
  }
  Write-Ok "Shutdown complete"
}
