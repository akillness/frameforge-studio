param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$receiptPath = Join-Path $studioRoot 'ops/docker-wsl-recovery.json'
$result = [ordered]@{ startedAt = (Get-Date).ToUniversalTime().ToString('o'); applied = $false; service = 'WSLService'; status = 'preview'; actions = @(); preservesDistributions = $true; resetsDockerData = $false; restartsWindows = $false }
function Save-Receipt {
  New-Item -ItemType Directory -Force (Split-Path $receiptPath) | Out-Null
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
}
try {
  $service = Get-CimInstance Win32_Service -Filter "Name='WSLService'"
  if (-not $service) { throw 'WSLService is not installed; this recovery does not apply.' }
  $result.before = @{ state = $service.State; processId = $service.ProcessId }
  $activeGuests = @(Get-Process -Name 'vmmem','vmmemWSL','wslhost' -ErrorAction SilentlyContinue)
  if ($activeGuests.Count) { throw 'Active WSL guest processes found. Preserve their work before recovery.' }
  if (-not $Apply) {
    $result.plan = 'If WSLService remains Stop Pending with the same PID, terminate only its verified Microsoft-signed process, then start WSLService. No distribution, volume, network or Docker settings are deleted.'
    Save-Receipt
    $result | ConvertTo-Json -Depth 5
    exit 0
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator consent through Windows UAC is required to repair WSLService.' }
  if ($service.State -eq 'Stop Pending') {
    $serviceProcessId = [int]$service.ProcessId
    Start-Sleep -Seconds 5
    $current = Get-CimInstance Win32_Service -Filter "Name='WSLService'"
    if ($current.State -ne 'Stop Pending' -or $current.ProcessId -ne $serviceProcessId) { throw 'Service changed during observation. Rerun diagnostics before recovery.' }
    if (@(Get-Process -Name 'vmmem','vmmemWSL','wslhost' -ErrorAction SilentlyContinue).Count) { throw 'A WSL guest became active. Recovery aborted.' }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serviceProcessId"
    $expected = Join-Path $env:ProgramFiles 'WSL/wslservice.exe'
    if (-not $process -or -not [String]::Equals($process.ExecutablePath, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Service executable does not match the expected installed WSL process.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $expected
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'WSL executable signature verification failed.' }
    Stop-Process -Id $serviceProcessId -Force -ErrorAction Stop
    $result.actions += 'Stopped the unchanged, verified Stop Pending WSLService process'
    $deadline = (Get-Date).AddSeconds(20)
    do {
      $current = Get-Service WSLService
      if ($current.Status -eq 'Stopped' -or $current.Status -eq 'Running') { break }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
  } elseif ($service.State -ne 'Stopped' -and $service.State -ne 'Running') {
    throw "WSLService state '$($service.State)' is outside this bounded recovery."
  }
  if ((Get-Service WSLService).Status -eq 'Stopped') {
    Start-Service WSLService
    $result.actions += 'Started WSLService'
  }
  (Get-Service WSLService).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  $after = Get-CimInstance Win32_Service -Filter "Name='WSLService'"
  $result.after = @{ state = $after.State; processId = $after.ProcessId }
  $result.applied = $true
  $result.status = 'service-recovered'
  $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-Receipt
} catch {
  $result.status = 'blocked'
  $result.error = $_.Exception.Message
  Save-Receipt
  Write-Error $_
  exit 1
}
