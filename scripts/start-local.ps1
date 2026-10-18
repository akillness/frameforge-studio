$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$studioNode = (Get-Command node.exe).Source
$opsDir = Join-Path $studioRoot 'ops'
New-Item -ItemType Directory -Force $opsDir | Out-Null
foreach ($service in @(@{Name='studio'; Port=4310; Script='server/app.mjs'}, @{Name='bridge'; Port=4311; Script='scripts/agent-bridge.mjs'}, @{Name='aside-inbox'; Port=0; Script='scripts/aside-inbox.mjs'})) {
  $pidFile = Join-Path $opsDir ($service.Name + '.pid')
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile)
    $savedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    if ($savedProcess -and $savedProcess.CommandLine.Contains($studioRoot)) { Write-Output ($service.Name + ' already running'); continue }
  }
  if ($service.Port -gt 0 -and (Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue)) { throw "Port $($service.Port) is occupied; stop only the known FrameForge process before restart." }
  $scriptPath = Join-Path $studioRoot $service.Script
  $argsList = @('--env-file="' + (Join-Path $studioRoot '.env') + '"', '"' + $scriptPath + '"')
  $p = Start-Process -FilePath $studioNode -ArgumentList $argsList -WorkingDirectory $studioRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $opsDir ($service.Name + '.log')) -RedirectStandardError (Join-Path $opsDir ($service.Name + '.error.log')) -PassThru
  Set-Content -LiteralPath $pidFile -Value $p.Id
  Write-Output ($service.Name + ' started PID ' + $p.Id)
}
