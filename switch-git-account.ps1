param()

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

git config credential.helper manager | Out-Null

# Clear cached credential for github.com in Git Credential Manager.
"protocol=https`nhost=github.com`n`n" | git credential-manager erase | Out-Null

Start-Process "https://github.com/login" | Out-Null

Write-Host "Cleared cached GitHub credential for git CLI and opened GitHub login."
