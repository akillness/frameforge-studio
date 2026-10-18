param(
  [ValidateSet('studio', 'bridge', 'aside-inbox')]
  [string[]]$Services = @('studio', 'bridge', 'aside-inbox')
)
$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$studioNode = (Get-Command node.exe).Source
$serviceScripts = @{studio='server/app.mjs'; bridge='scripts/agent-bridge.mjs'; 'aside-inbox'='scripts/aside-inbox.mjs'}
foreach ($name in @('studio','bridge','aside-inbox')) {
  if ($name -notin $Services) { continue }
  $scriptPath = Join-Path $studioRoot $serviceScripts[$name]
  $pidFile = Join-Path $studioRoot ('ops/' + $name + '.pid')
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile)
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.ExecutablePath -eq $studioNode -and $processInfo.CommandLine -and $processInfo.CommandLine.Contains('"' + $scriptPath + '"')) { Stop-Process -Id $savedPid; Write-Output ($name + ' stopped') }
    elseif ($processInfo) { throw ('PID ownership changed for ' + $name) }
    Remove-Item -LiteralPath $pidFile
  }
}
