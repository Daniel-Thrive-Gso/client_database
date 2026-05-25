param([string]$Only = 'hosting')

# Deploy the client_database app with a fresh cache-buster stamp.
#
# Rewrites SW_VERSION in public/sw.js and the ?v= query string on the entry
# <script> tag in public/index.html with a timestamp + git short SHA, then
# calls firebase deploy. The new SW_VERSION invalidates the service-worker
# cache on next visit, so users always get the latest JS / CSS / HTML in one
# stroke. Retires the manual "bump app.js?v= before committing" ritual.
#
# Default target: -Only hosting. Pass another --only value via -Only:
#   .\scripts\deploy.ps1                                # hosting only (default)
#   .\scripts\deploy.ps1 -Only functions                # functions only
#   .\scripts\deploy.ps1 -Only "hosting,functions"      # both (quote required —
#                                                       # comma is array-literal
#                                                       # syntax otherwise)
#   .\scripts\deploy.ps1 -Only firestore:rules          # just rules
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

# UTF-8 without BOM. Used for BOTH read and write — PS 5.1's Get-Content -Raw
# defaults to the system code page (Windows-1252 on English locales), which
# mangles UTF-8 multi-byte chars like em-dash and ellipsis on round-trip.
# Set-Content -Encoding utf8 in PS 5.1 also writes a BOM. The .NET path is the
# only reliable UTF-8 round-trip on Windows PowerShell 5.1.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1. Rewrite SW_VERSION in public/sw.js. Verify the pattern matched first —
# the earlier "did the file change?" check false-positived when two runs
# within the same minute produced the same stamp.
$swContent = [System.IO.File]::ReadAllText($swPath, $utf8NoBom)
$swPattern = "const SW_VERSION = '[^']+';"
if ($swContent -notmatch $swPattern) { throw "Did not match SW_VERSION pattern in $swPath" }
$newSw = $swContent -replace $swPattern, "const SW_VERSION = 'gso-thrive-$stamp';"
[System.IO.File]::WriteAllText($swPath, $newSw, $utf8NoBom)
Write-Output "sw.js       -> SW_VERSION = 'gso-thrive-$stamp'"

# 2. Rewrite ?v= on the entry <script> tag in public/index.html. Same
# verify-then-replace pattern as above.
$indexContent = [System.IO.File]::ReadAllText($indexPath, $utf8NoBom)
$indexPattern = '(<script type="module" src="app\.js\?v=)[^"]+(")'
if ($indexContent -notmatch $indexPattern) { throw "Did not match entry <script> ?v= pattern in $indexPath" }
$newIndex = [regex]::Replace($indexContent, $indexPattern, "`${1}$stamp`${2}")
[System.IO.File]::WriteAllText($indexPath, $newIndex, $utf8NoBom)
Write-Output "index.html  -> app.js?v=$stamp"

# 3. Deploy. firebase looks for firebase.json in the cwd, so cd into the project.
# Pass --only as one '--only=value' arg so a comma-separated list like
# 'hosting,functions' survives PowerShell's array-literal parsing intact.
Push-Location $projectRoot
try {
    Write-Output ""
    Write-Output "firebase deploy --only=$Only"
    & firebase deploy "--only=$Only"
    if ($LASTEXITCODE -ne 0) { throw "firebase deploy failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Output ""
Write-Output "Deployed. Commit the cache-buster bump when ready:"
Write-Output "  git add public/sw.js public/index.html && git commit -m 'Bump cache-buster to $stamp'"
