param()

$ErrorActionPreference = "Stop"

function Read-WithDefault {
  param(
    [string]$Prompt,
    [string]$DefaultValue
  )

  if ($DefaultValue) {
    $value = Read-Host "$Prompt [$DefaultValue]"
    if ([string]::IsNullOrWhiteSpace($value)) {
      return $DefaultValue
    }
    return $value.Trim()
  }

  return (Read-Host $Prompt).Trim()
}

function Parse-GitHubRemote {
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
if (-not $config.git) {
  throw "Missing git block in app.config.json"
}

$current = $config.git
$remoteParsed = Parse-GitHubRemote -RemoteUrl ([string]$current.remoteUrl)

$globalName = ""
$globalEmail = ""
try { $globalName = (git config --global user.name 2>$null).Trim() } catch {}
try { $globalEmail = (git config --global user.email 2>$null).Trim() } catch {}

$defaultName = [string]$current.userName
if (-not $defaultName -or $defaultName -eq "Your Name") { $defaultName = $globalName }

$defaultEmail = [string]$current.userEmail
if (-not $defaultEmail -or $defaultEmail -eq "you@example.com") { $defaultEmail = $globalEmail }

$defaultOwner = ""
if ($remoteParsed) { $defaultOwner = [string]$remoteParsed.owner }
if (-not $defaultOwner -or $defaultOwner -eq "your-user") {
  $defaultOwner = Read-WithDefault -Prompt "GitHub username" -DefaultValue ""
}

$defaultRepo = ""
if ($remoteParsed) { $defaultRepo = [string]$remoteParsed.repo }
if (-not $defaultRepo -or $defaultRepo -eq "your-repo") {
  $defaultRepo = Split-Path -Leaf $projectRoot
}

Write-Host ""
Write-Host "Even G2 Link Git/Repo Wizard" -ForegroundColor Cyan
Write-Host "This sets your local git identity + repo URL used by Publish." -ForegroundColor DarkGray
Write-Host ""

$name = Read-WithDefault -Prompt "Git user.name" -DefaultValue $defaultName
$email = Read-WithDefault -Prompt "Git user.email" -DefaultValue $defaultEmail
$owner = Read-WithDefault -Prompt "GitHub username" -DefaultValue $defaultOwner
$repo = Read-WithDefault -Prompt "GitHub repository name" -DefaultValue $defaultRepo

if (-not $name -or -not $email -or -not $owner -or -not $repo) {
  throw "Name, email, GitHub username, and repo are required."
}

$remoteUrl = "https://github.com/$owner/$repo.git"
$publishUrl = "https://$owner.github.io/$repo/"

Write-Host ""
Write-Host "Remote URL: $remoteUrl"
Write-Host "Publish URL: $publishUrl"
Write-Host ""

$openPages = Read-WithDefault -Prompt "Open GitHub sign-in and create-repo pages now? (Y/N)" -DefaultValue "Y"
if ($openPages.ToUpper() -eq "Y") {
  Start-Process "https://github.com/login" | Out-Null
  Start-Process "https://github.com/new" | Out-Null
}

if (-not (Test-Path ".git")) {
  $branch = [string]$current.branch
  if (-not $branch) { $branch = "main" }
  git init -b $branch | Out-Null
}

git config user.name $name
git config user.email $email
git config credential.helper manager | Out-Null

$originExists = $false
try {
  $originUrl = (git remote get-url origin 2>$null)
  if ($originUrl) { $originExists = $true }
} catch {}

if ($originExists) {
  git remote set-url origin $remoteUrl
} else {
  git remote add origin $remoteUrl
}

$config.git.enabled = $true
$config.git.userName = $name
$config.git.userEmail = $email
$config.git.remoteUrl = $remoteUrl
$config.publishUrl = $publishUrl

$users = @($config.git.users)
$userExists = $false
foreach ($u in $users) {
  if ([string]$u.name -eq $name -and [string]$u.email -eq $email) {
    $userExists = $true
    break
  }
}
if (-not $userExists) {
  $users += [pscustomobject]@{ name = $name; email = $email }
}
$config.git.users = $users

$repos = @($config.git.repos)
if (-not ($repos -contains $remoteUrl)) {
  $repos += $remoteUrl
}
$config.git.repos = $repos

($config | ConvertTo-Json -Depth 8) | Set-Content $configPath

Write-Host ""
Write-Host "Saved app.config.json and linked origin remote." -ForegroundColor Green
Write-Host "Next: create the repo on GitHub (if needed), then click Publish in app." -ForegroundColor Green
