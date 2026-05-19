# Generate PWA app icons from the GSO logo.
#
# Output: public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png
# Source: public/forms/gso-logo.png
#
# Re-run any time the logo changes. Safe to commit.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$logoPath    = Join-Path $projectRoot 'public\forms\gso-logo.png'
$outDir      = Join-Path $projectRoot 'public\icons'

if (-not (Test-Path $logoPath)) { throw "Logo not found: $logoPath" }
if (-not (Test-Path $outDir))   { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$logo = [System.Drawing.Image]::FromFile($logoPath)

# Icon background. The logo PNG has an opaque #000 fill baked in, so we
# composite on pure black to avoid a visible inner-rectangle seam. The app's
# theme color (#111111) is set separately in the manifest / meta tags.
$brandBg     = [System.Drawing.Color]::FromArgb(255, 0, 0, 0)           # #000000
$brandAccent = [System.Drawing.Color]::FromArgb(255, 255, 182, 0)       # #ffb600

function Render-Icon {
    param(
        [Parameter(Mandatory)][int]$Size,
        [Parameter(Mandatory)][string]$OutPath,
        # Fraction of canvas the logo should occupy. Maskable spec: keep
        # content inside an 80% safe-zone circle, so 0.65 leaves margin.
        [double]$LogoScale = 0.78,
        [System.Drawing.Color]$Background = $brandBg
    )

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $brush = New-Object System.Drawing.SolidBrush($Background)
    $g.FillRectangle($brush, 0, 0, $Size, $Size)
    $brush.Dispose()

    # Fit logo to LogoScale * Size while preserving aspect ratio.
    $maxW = $Size * $LogoScale
    $maxH = $Size * $LogoScale
    $aspect = $logo.Width / $logo.Height
    $maxAspect = $maxW / $maxH
    if ($aspect -gt $maxAspect) {
        $w = $maxW
        $h = $maxW / $aspect
    } else {
        $h = $maxH
        $w = $maxH * $aspect
    }
    $x = ($Size - $w) / 2.0
    $y = ($Size - $h) / 2.0

    $g.DrawImage($logo, $x, $y, $w, $h)
    $g.Dispose()

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "wrote $OutPath ($Size x $Size)"
}

Render-Icon -Size 192 -OutPath (Join-Path $outDir 'icon-192.png')           -LogoScale 0.80
Render-Icon -Size 512 -OutPath (Join-Path $outDir 'icon-512.png')           -LogoScale 0.80
# Maskable: tighter safe zone — keep logo inside ~65% of canvas so the OS mask
# (which can crop up to a 20% radius ring) doesn't clip the wordmark.
Render-Icon -Size 512 -OutPath (Join-Path $outDir 'icon-maskable-512.png')  -LogoScale 0.62
# Apple touch icon — Apple ignores transparency and rounds corners itself.
Render-Icon -Size 180 -OutPath (Join-Path $outDir 'apple-touch-icon.png')   -LogoScale 0.80
# Favicon-grade
Render-Icon -Size 32  -OutPath (Join-Path $outDir 'favicon-32.png')         -LogoScale 0.90

$logo.Dispose()
Write-Output 'done.'
