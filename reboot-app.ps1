param(
  [int]$AppPort = 5173,
  [int]$ControlPort = 8787
)

$ErrorActionPreference = "Stop"

function Stop-ListenersOnPort {
  param([int]$Port)

  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $listeners) {
    return
  }

  $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $pids) {
    if ($procId -and $procId -gt 0) {
      try {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      } catch {}
    }
  }
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Stop-ListenersOnPort -Port $AppPort
Stop-ListenersOnPort -Port $ControlPort

Start-Sleep -Milliseconds 600

$runner = Join-Path $projectRoot "Run-Even-Sim.cmd"
if (-not (Test-Path $runner)) {
  throw "Missing launcher file: $runner"
}

Start-Process -FilePath $runner -WorkingDirectory $projectRoot | Out-Null
