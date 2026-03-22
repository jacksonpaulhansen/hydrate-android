param()

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$configPath = Join-Path $projectRoot "app.config.json"
if (-not (Test-Path $configPath)) {
  throw "Missing app.config.json"
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not $config.git) {
  throw "Missing git block in app.config.json"
}

$users = @($config.git.users)
$repos = @($config.git.repos)

if ($users.Count -gt 0) {
  Write-Host "Select Git User" -ForegroundColor Yellow
  for ($i = 0; $i -lt $users.Count; $i++) {
    Write-Host "[$($i + 1)] $($users[$i].name) <$($users[$i].email)>"
  }
  $u = Read-Host "Pick number (or Enter to keep current)"
  $tmpU = 0
  if ($u -and [int]::TryParse($u, [ref]$tmpU)) {
    $ui = [int]$u
    if ($ui -ge 1 -and $ui -le $users.Count) {
      $config.git.userName = [string]$users[$ui - 1].name
      $config.git.userEmail = [string]$users[$ui - 1].email
    }
  }
}

if (-not $config.git.userName) {
  $config.git.userName = (Read-Host "Enter git user.name").Trim()
}
if (-not $config.git.userEmail) {
  $config.git.userEmail = (Read-Host "Enter git user.email").Trim()
}

if ($repos.Count -gt 0) {
  Write-Host "Select Git Repo" -ForegroundColor Yellow
  for ($i = 0; $i -lt $repos.Count; $i++) {
    Write-Host "[$($i + 1)] $($repos[$i])"
  }
  $r = Read-Host "Pick number (or Enter to keep current)"
  $tmpR = 0
  if ($r -and [int]::TryParse($r, [ref]$tmpR)) {
    $ri = [int]$r
    if ($ri -ge 1 -and $ri -le $repos.Count) {
      $config.git.remoteUrl = [string]$repos[$ri - 1]
    }
  }
}

if (-not $config.git.remoteUrl) {
  $config.git.remoteUrl = (Read-Host "Enter git remote URL").Trim()
}

($config | ConvertTo-Json -Depth 8) | Set-Content $configPath

Write-Host "Saved git settings to app.config.json" -ForegroundColor Green
