# Windows.Media.Ocr wrapper: image in, JSON out with per-word bounding boxes.
#
# Geometry is the point. The ruteros vary in row count, colour theme and layout
# between the Plegable and Volante templates, so the structure has to be recovered
# from word positions rather than from fixed crops.
#
# Writes via -Out rather than stdout because redirecting PowerShell output through
# the shell re-encodes it in the console codepage and corrupts the accented text.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [string]$Lang = 'es',
  [string]$Out
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$path = (Resolve-Path $Image).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $Lang))
if ($null -eq $engine) { throw "Sin motor OCR para '$Lang'" }

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($ln in $result.Lines) {
  $words = @()
  foreach ($w in $ln.Words) {
    $r = $w.BoundingRect
    $words += [pscustomobject]@{
      t = $w.Text
      x = [int][math]::Round($r.X); y = [int][math]::Round($r.Y)
      w = [int][math]::Round($r.Width); h = [int][math]::Round($r.Height)
    }
  }
  $lines += [pscustomobject]@{ text = $ln.Text; words = $words }
}
$stream.Dispose()

$json = [pscustomobject]@{
  image  = $path
  width  = $decoder.PixelWidth
  height = $decoder.PixelHeight
  lines  = $lines
} | ConvertTo-Json -Depth 6 -Compress

if ($Out) {
  $abs = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
  [System.IO.File]::WriteAllText($abs, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "ok $abs"
} else {
  $json
}
