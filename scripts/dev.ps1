$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$processes = @()

function Start-AppProcess {
  param(
    [string]$Name,
    [string]$WorkingDirectory
  )

  Write-Host "Starting $Name..."
  $process = Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("run", "dev") `
    -WorkingDirectory $WorkingDirectory `
    -NoNewWindow `
    -PassThru

  return $process
}

try {
  $processes += Start-AppProcess -Name "API server" -WorkingDirectory (Join-Path $root "server")
  $processes += Start-AppProcess -Name "Vite client" -WorkingDirectory (Join-Path $root "client")

  Write-Host ""
  Write-Host "API:    http://localhost:3001"
  Write-Host "Client: http://localhost:5173"
  Write-Host "Press Ctrl+C to stop both processes."
  Write-Host ""

  while ($true) {
    $running = $processes | Where-Object { -not $_.HasExited }
    if ($running.Count -eq 0) {
      break
    }
    Start-Sleep -Seconds 1
  }
} finally {
  foreach ($process in $processes) {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
  }
}
