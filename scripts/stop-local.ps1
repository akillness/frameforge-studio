$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
foreach ($name in @('studio','bridge','aside-inbox')) {
  $pidFile = Join-Path $studioRoot ('ops/' + $name + '.pid')
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile)
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.CommandLine.Contains($studioRoot)) { Stop-Process -Id $savedPid; Write-Output ($name + ' stopped') }
    elseif ($processInfo) { throw ('PID ownership changed for ' + $name) }
    Remove-Item -LiteralPath $pidFile
  }
}
