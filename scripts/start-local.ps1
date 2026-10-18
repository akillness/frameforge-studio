param(
  [ValidateSet('studio', 'bridge', 'aside-inbox')]
  [string[]]$Services = @('studio', 'bridge', 'aside-inbox')
)
$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$studioNode = (Get-Command node.exe).Source
$opsDir = Join-Path $studioRoot 'ops'
New-Item -ItemType Directory -Force $opsDir | Out-Null
foreach ($service in @(@{Name='studio'; Port=4310; Script='server/app.mjs'}, @{Name='bridge'; Port=4311; Script='scripts/agent-bridge.mjs'}, @{Name='aside-inbox'; Port=0; Script='scripts/aside-inbox.mjs'})) {
  if ($service.Name -notin $Services) { continue }
  $scriptPath = Join-Path $studioRoot $service.Script
  $pidFile = Join-Path $opsDir ($service.Name + '.pid')
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile)
    $savedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    if ($savedProcess -and $savedProcess.ExecutablePath -eq $studioNode -and $savedProcess.CommandLine -and $savedProcess.CommandLine.Contains('"' + $scriptPath + '"')) { Write-Output ($service.Name + ' already running'); continue }
    if ($savedProcess) {
      if ($service.Port -gt 0 -and (Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue)) { throw ('PID ownership changed and port is occupied for ' + $service.Name + '; refusing to start.') }
      # Reboots can recycle a recorded PID. Preserve our stale record, never touch
      # the unrelated process, and only replace the service's own PID file.
      $stalePidFile = $pidFile + '.stale-' + [guid]::NewGuid().ToString('N')
      Move-Item -LiteralPath $pidFile -Destination $stalePidFile
      Write-Output ($service.Name + ' stale PID record archived; unrelated process left running')
    }
  }
  if ($service.Port -gt 0 -and (Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue)) { throw "Port $($service.Port) is occupied; stop only the known FrameForge process before restart." }
  $argsList = @('--env-file="' + (Join-Path $studioRoot '.env') + '"', '"' + $scriptPath + '"')
  $p = Start-Process -FilePath $studioNode -ArgumentList $argsList -WorkingDirectory $studioRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $opsDir ($service.Name + '.log')) -RedirectStandardError (Join-Path $opsDir ($service.Name + '.error.log')) -PassThru
  Set-Content -LiteralPath $pidFile -Value $p.Id
  Write-Output ($service.Name + ' started PID ' + $p.Id)
}
