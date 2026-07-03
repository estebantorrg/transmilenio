# Generates Android launcher icons and splash screens from the web client's
# TransMilenio logo, replacing Capacitor's default placeholder art.
#
#   powershell -ExecutionPolicy Bypass -File scripts/generate-assets.ps1
#
# Icons: dark rounded-square (and round) background + centered logo.
# Splash: dark background + centered logo, regenerated at each existing
# density's exact dimensions (Android 12+ uses the launcher icon instead,
# via AppTheme.NoActionBarLaunch / Theme.SplashScreen).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$mobileDir = Split-Path -Parent $PSScriptRoot
$logoPath  = Join-Path $mobileDir '..\client\public\transmiLogo.png'
$resDir    = Join-Path $mobileDir 'android\app\src\main\res'
$bg        = [System.Drawing.Color]::FromArgb(255, 0x0A, 0x0E, 0x17)

$logo = [System.Drawing.Image]::FromFile((Resolve-Path $logoPath))

function New-Canvas([int]$w, [int]$h, [bool]$transparent) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  if (-not $transparent) { $g.Clear($script:bg) } else { $g.Clear([System.Drawing.Color]::Transparent) }
  return @($bmp, $g)
}

function Draw-Logo([System.Drawing.Graphics]$g, [int]$w, [int]$h, [double]$scale) {
  # Fit the logo into a centered box of (scale * min(w,h)), preserving ratio.
  $box = [Math]::Min($w, $h) * $scale
  $ratio = [Math]::Min($box / $script:logo.Width, $box / $script:logo.Height)
  $lw = [int]($script:logo.Width * $ratio)
  $lh = [int]($script:logo.Height * $ratio)
  $g.DrawImage($script:logo, [int](($w - $lw) / 2), [int](($h - $lh) / 2), $lw, $lh)
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "  wrote $path"
}

# ── Launcher icons ──
$densities = @(
  @{ dir = 'mipmap-mdpi';    icon = 48;  fg = 108 },
  @{ dir = 'mipmap-hdpi';    icon = 72;  fg = 162 },
  @{ dir = 'mipmap-xhdpi';   icon = 96;  fg = 216 },
  @{ dir = 'mipmap-xxhdpi';  icon = 144; fg = 324 },
  @{ dir = 'mipmap-xxxhdpi'; icon = 192; fg = 432 }
)

foreach ($d in $densities) {
  $dir = Join-Path $resDir $d.dir
  $s = $d.icon

  # ic_launcher.png — rounded-square dark tile + logo
  $bmp, $g = New-Canvas $s $s $true
  $radius = [int]($s * 0.18)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, 2 * $radius, 2 * $radius, 180, 90)
  $path.AddArc($s - 2 * $radius, 0, 2 * $radius, 2 * $radius, 270, 90)
  $path.AddArc($s - 2 * $radius, $s - 2 * $radius, 2 * $radius, 2 * $radius, 0, 90)
  $path.AddArc(0, $s - 2 * $radius, 2 * $radius, 2 * $radius, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillPath($brush, $path)
  Draw-Logo $g $s $s 0.62
  Save-Png $bmp (Join-Path $dir 'ic_launcher.png')
  $g.Dispose(); $bmp.Dispose()

  # ic_launcher_round.png — circular dark tile + logo
  $bmp, $g = New-Canvas $s $s $true
  $g.FillEllipse($brush, 0, 0, $s, $s)
  Draw-Logo $g $s $s 0.56
  Save-Png $bmp (Join-Path $dir 'ic_launcher_round.png')
  $g.Dispose(); $bmp.Dispose()

  # ic_launcher_foreground.png — logo on transparency (adaptive icon layer;
  # the visible safe zone is the middle ~2/3, so keep the logo small).
  $s = $d.fg
  $bmp, $g = New-Canvas $s $s $true
  Draw-Logo $g $s $s 0.40
  Save-Png $bmp (Join-Path $dir 'ic_launcher_foreground.png')
  $g.Dispose(); $bmp.Dispose()
  $brush.Dispose()
}

# ── Splash screens (regenerate every existing splash.png at its own size) ──
Get-ChildItem -Path $resDir -Recurse -Filter 'splash.png' | ForEach-Object {
  $existing = [System.Drawing.Image]::FromFile($_.FullName)
  $w = $existing.Width; $h = $existing.Height
  $existing.Dispose()

  $bmp, $g = New-Canvas $w $h $false
  Draw-Logo $g $w $h 0.28
  $g.Dispose()
  Save-Png $bmp $_.FullName
  $bmp.Dispose()
}

$logo.Dispose()
Write-Host 'Done.'
