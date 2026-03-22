param(
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

function Write-Info {
  param([string]$Message)
  Write-Host "[even-g2] $Message" -ForegroundColor Cyan
}

function Invoke-Git {
  param(
    [string[]]$GitArgs
  )

  & git @GitArgs
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Ask-IfMissing {
  param(
    [string]$Value,
    [string]$Prompt
  )

  if ($Value) {
    return $Value
  }

  if ($NonInteractive) {
    return ""
  }

  return (Read-Host $Prompt).Trim()
}

function Select-FromMenu {
  param(
    [string]$Title,
    [array]$Options,
    [string]$CurrentValue,
    [string]$ManualPrompt
  )

  if (-not $Options -or $Options.Count -eq 0) {
    if ($NonInteractive) {
      return $CurrentValue
    }
    return (Read-Host $ManualPrompt).Trim()
  }

  if ($NonInteractive) {
    if ($CurrentValue) {
      return $CurrentValue
    }
    return [string]$Options[0]
  }

  Write-Host ""
  Write-Host $Title -ForegroundColor Yellow
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $label = [string]$Options[$i]
    $marker = ""
    if ($label -eq $CurrentValue) {
      $marker = " (current)"
    }
    Write-Host "[$($i + 1)] $label$marker"
  }
  Write-Host "[M] Manual entry"

  $choice = (Read-Host "Choose option number or M").Trim()
  if (-not $choice) {
    if ($CurrentValue) {
      return $CurrentValue
    }
    return (Read-Host $ManualPrompt).Trim()
  }

  if ($choice.ToUpper() -eq "M") {
    if ($NonInteractive) {
      return $CurrentValue
    }
    return (Read-Host $ManualPrompt).Trim()
  }

  $index = 0
  if ([int]::TryParse($choice, [ref]$index)) {
    if ($index -ge 1 -and $index -le $Options.Count) {
      return [string]$Options[$index - 1]
    }
  }

  Write-Host "Invalid choice, using current/manual value." -ForegroundColor DarkYellow
  if ($CurrentValue) {
    return $CurrentValue
  }
  if ($NonInteractive) {
    return ""
  }
  return (Read-Host $ManualPrompt).Trim()
}

function Parse-GitHubRepo {
  param([string]$RemoteUrl)

  if (-not $RemoteUrl) {
    return $null
  }

  if ($RemoteUrl -match "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)(\.git)?$") {
    return @{
      owner = $Matches.owner
      repo = $Matches.repo
    }
  }

  return $null
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$configPath = Join-Path $projectRoot "app.config.json"
if (-not (Test-Path $configPath)) {
  throw "Missing app.config.json"
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$gitConfig = $config.git
if (-not $gitConfig) {
  Write-Info "No git block in app.config.json. Skipping git publish."
  exit 0
}

$enabled = [bool]$gitConfig.enabled
if (-not $enabled) {
  Write-Info "Git publish disabled in app.config.json."
  exit 0
}

$branch = [string]$gitConfig.branch
if (-not $branch) {
  $branch = "main"
}

$userName = [string]$gitConfig.userName
$userEmail = [string]$gitConfig.userEmail
$remoteUrl = [string]$gitConfig.remoteUrl
$users = @($gitConfig.users)
$repos = @($gitConfig.repos)
$messagePrefix = [string]$gitConfig.commitMessagePrefix
if (-not $messagePrefix) {
  $messagePrefix = "publish"
}

$autoSetGithubPagesUrl = [bool]$gitConfig.autoSetGithubPagesUrl

$git = Get-Command "git" -ErrorAction SilentlyContinue
if (-not $git) {
  throw "git was not found in PATH."
}

if (-not (Test-Path ".git")) {
  Write-Info "Initializing git repo with branch '$branch'"
  Invoke-Git @("init", "-b", $branch)
}

if ($users.Count -gt 0) {
  $userLabels = @()
  foreach ($u in $users) {
    $n = [string]$u.name
    $e = [string]$u.email
    if ($n -and $e) {
      $userLabels += "$n <$e>"
    }
  }

  $currentUserLabel = ""
  if ($userName -and $userEmail) {
    $currentUserLabel = "$userName <$userEmail>"
  }

  $selectedUserLabel = Select-FromMenu -Title "Select Git User" -Options $userLabels -CurrentValue $currentUserLabel -ManualPrompt "Enter git user as Name <email>"
  if ($selectedUserLabel -match "^(?<name>.+)\s<(?<email>[^>]+)>$") {
    $userName = $Matches.name.Trim()
    $userEmail = $Matches.email.Trim()
  } else {
    $userName = Ask-IfMissing -Value $userName -Prompt "Enter git user.name"
    $userEmail = Ask-IfMissing -Value $userEmail -Prompt "Enter git user.email"
  }
} else {
  $userName = Ask-IfMissing -Value $userName -Prompt "Enter git user.name"
  $userEmail = Ask-IfMissing -Value $userEmail -Prompt "Enter git user.email"
}

$repoOptions = @()
foreach ($r in $repos) {
  $repoUrl = [string]$r
  if ($repoUrl) {
    $repoOptions += $repoUrl
  }
}
$remoteUrl = Select-FromMenu -Title "Select Git Repo (origin)" -Options $repoOptions -CurrentValue $remoteUrl -ManualPrompt "Enter git remote URL (origin)"

if (-not $userName -or -not $userEmail -or -not $remoteUrl) {
  if ($NonInteractive) {
    throw "Missing git config for non-interactive publish. Set app.config.json git.userName/git.userEmail/git.remoteUrl or run setup-git.ps1 once."
  }
  throw "git userName/userEmail/remoteUrl are required."
}

if ($remoteUrl -like "*github.com/your-user/your-repo.git*") {
  throw "Placeholder repo URL detected. Open Link Git/Repo and set your real GitHub user/repo."
}

if ($gitConfig.userName -ne $userName -or $gitConfig.userEmail -ne $userEmail -or $gitConfig.remoteUrl -ne $remoteUrl) {
  $config.git.userName = $userName
  $config.git.userEmail = $userEmail
  $config.git.remoteUrl = $remoteUrl
  ($config | ConvertTo-Json -Depth 8) | Set-Content $configPath
}

Invoke-Git @("config", "user.name", $userName)
Invoke-Git @("config", "user.email", $userEmail)
Invoke-Git @("config", "credential.helper", "manager")

$originExists = $false
$originUrl = ""
try {
  $originUrl = (git remote get-url origin 2>$null)
  if ($originUrl) {
    $originExists = $true
  }
} catch {}

if (-not $originExists -and $remoteUrl) {
  Write-Info "Adding origin remote"
  Invoke-Git @("remote", "add", "origin", $remoteUrl)
  $originExists = $true
  $originUrl = $remoteUrl
}

if ($originExists -and $originUrl -ne $remoteUrl) {
  Write-Info "Updating origin remote URL"
  Invoke-Git @("remote", "set-url", "origin", $remoteUrl)
  $originUrl = $remoteUrl
}

if ($autoSetGithubPagesUrl) {
  $repoUrlForPages = $remoteUrl
  if (-not $repoUrlForPages) {
    $repoUrlForPages = $originUrl
  }
  $repoInfo = Parse-GitHubRepo -RemoteUrl $repoUrlForPages
  if ($repoInfo) {
    $currentPublishUrl = [string]$config.publishUrl
    if (-not $currentPublishUrl -or $currentPublishUrl -like "https://example.com/*") {
      $pagesUrl = "https://$($repoInfo.owner).github.io/$($repoInfo.repo)/"
      Write-Info "Auto-setting publishUrl -> $pagesUrl"
      $config.publishUrl = $pagesUrl
      ($config | ConvertTo-Json -Depth 8) | Set-Content $configPath
    }
  }
}

Invoke-Git @("add", "-A")
$hasStagedChanges = (git diff --cached --name-only).Length -gt 0
if ($hasStagedChanges) {
  $commitMessage = "$messagePrefix $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  Write-Info "Committing changes"
  Invoke-Git @("commit", "-m", $commitMessage)
} else {
  Write-Info "No file changes to commit."
}

if ($originExists) {
  Write-Info "Pushing branch '$branch' to origin"
  Invoke-Git @("push", "-u", "origin", $branch)
} else {
  Write-Info "No origin remote configured. Skipping push."
}
