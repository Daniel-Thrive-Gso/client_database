param([string[]]$DeployArgs = @('--only', 'hosting'))

# Deploy the client_database app with a fresh cache-buster stamp.
#
# Rewrites SW_VERSION in public/sw.js and the ?v= query string on the entry
# <script> tag in public/index.html with a timestamp + git short SHA, then
# calls firebase deploy. The new SW_VERSION invalidates the service-worker
# cache on next visit, so users always get the latest JS / CSS / HTML in one
# stroke. Retires the manual "bump app.js?v= before committing" ritual.
#
# Default target: --only hosting. Pass any other firebase-deploy flags and
# they replace the default:
#   .\scripts\deploy.ps1                                # hosting only (default)
#   .\scripts\deploy.ps1 --only functions               # functions only
#   .\scripts\deploy.ps1 --only hosting,functions       # both
#   .\scripts\deploy.ps1 --only firestore:rules         # just rules
#
# Side effect: every run leaves public/sw.js and public/index.html with
# uncommitted changes (the new stamp). Commit them when convenient:
#   git add public/sw.js public/index.html && git commit -m 'Bump cache-buster'

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$swPath      = Join-Path $projectRoot 'public\sw.js'
$indexPath   = Join-Path $projectRoot 'public\index.html'

if (-not (Test-Path $swPath))    { throw "Not found: $swPath" }
if (-not (Test-Path $indexPath)) { throw "Not found: $indexPath" }

# Build the version stamp. Timestamp is the load-bearing part (always unique);
# the SHA helps when diagnosing what code is actually live in production.
$timestamp = (Get-Date -Format 'yyyyMMdd-HHmm')
$shaSuffix = ''
try {
    $sha = (& git -C $projectRoot rev-parse --short HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $sha) {
        $shaSuffix = "-$($sha.Trim())"
    }
} catch {
    # Not a git repo or git not installed — fall back to timestamp-only stamp.
}
$stamp = "$timestamp$shaSuffix"

# UTF-8 without BOM. PS 5.1's Set-Content -Encoding utf8 writes a BOM, which
# would change file size on first write and confuse `git diff`.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1. Rewrite SW_VERSION in public/sw.js
$swContent = Get-Content -Raw $swPath
$newSw = $swContent -replace "const SW_VERSION = '[^']+';", "const SW_VERSION = 'gso-thrive-$stamp';"
if ($newSw -eq $swContent) { throw "Did not match SW_VERSION pattern in $swPath" }
[System.IO.File]::WriteAllText($swPath, $newSw, $utf8NoBom)
Write-Output "sw.js       -> SW_VERSION = 'gso-thrive-$stamp'"

# 2. Rewrite ?v= on the entry <script> tag in public/index.html
$indexContent = Get-Content -Raw $indexPath
$pattern = '(<script type="module" src="app\.js\?v=)[^"]+(")'
$newIndex = [regex]::Replace($indexContent, $pattern, "`${1}$stamp`${2}")
if ($newIndex -eq $indexContent) { throw "Did not match entry <script> ?v= pattern in $indexPath" }
[System.IO.File]::WriteAllText($indexPath, $newIndex, $utf8NoBom)
Write-Output "index.html  -> app.js?v=$stamp"

# 3. Deploy. firebase looks for firebase.json in the cwd, so cd into the project.
Push-Location $projectRoot
try {
    Write-Output ""
    Write-Output "firebase deploy $($DeployArgs -join ' ')"
    & firebase deploy @DeployArgs
    if ($LASTEXITCODE -ne 0) { throw "firebase deploy failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Output ""
Write-Output "Deployed. Commit the cache-buster bump when ready:"
Write-Output "  git add public/sw.js public/index.html && git commit -m 'Bump cache-buster to $stamp'"
