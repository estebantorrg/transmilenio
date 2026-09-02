# ocr.ps1 for a whole directory: every PNG in -Dir, one JSON out, one startup.
#
# Spawning powershell per crop is what made the per-image wrapper unusable at
# scale — `detalle.mjs` asks for roughly twenty-five crops per sheet across a
# hundred and fifty sheets, and the interpreter start dominated every one of
# them. The recognition itself is milliseconds.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Lang = 'es',
  [Parameter(Mandatory = $true)][string]$Out
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

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $Lang))
if ($null -eq $engine) { throw "Sin motor OCR para '$Lang'" }

$results = @{}
foreach ($img in (Get-ChildItem -Path $Dir -Filter *.png -File)) {
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($img.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
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
    $results[$img.Name] = [pscustomobject]@{ width = $decoder.PixelWidth; height = $decoder.PixelHeight; lines = $lines }
  } catch {
    $results[$img.Name] = [pscustomobject]@{ error = $_.Exception.Message }
  }
}

$json = [pscustomobject]$results | ConvertTo-Json -Depth 7 -Compress
$abs = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
[System.IO.File]::WriteAllText($abs, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "ok $abs $($results.Count)"
