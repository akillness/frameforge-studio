param([switch]$Build)
$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dockerBinary = (Get-Command docker.exe -ErrorAction Stop).Source
$volumeName = 'frameforge-studio_studio-data'
$compose = @('compose', '-p', 'frameforge-studio', '--file', (Join-Path $studioRoot 'compose.yaml'), '--env-file', (Join-Path $studioRoot '.env'))

function Invoke-DockerBounded {
  param([string[]]$Arguments, [int]$TimeoutSeconds = 15)
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $dockerBinary
  # All arguments originate in this script; quote path/template arguments for Win32.
  $start.Arguments = (($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' ')
  $start.WorkingDirectory = $studioRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      # Terminate only this helper's Docker CLI, never the engine or a container.
      try { $process.Kill() } catch {}
      return @{ ExitCode = -1; Output = ''; TimedOut = $true }
    }
    return @{ ExitCode = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult().Trim(); TimedOut = $false }
  } finally { $process.Dispose() }
}

if (-not (Test-Path -LiteralPath (Join-Path $studioRoot '.env') -PathType Leaf)) {
  throw 'Missing .env. Configure the private deployment before starting Docker.'
}
$engine = Invoke-DockerBounded -Arguments @('info', '--format', '{{.ServerVersion}}') -TimeoutSeconds 8
if ($engine.ExitCode -ne 0) {
  Write-Output 'Starting Docker Desktop and waiting for the engine (up to 180 seconds).'
  $started = Invoke-DockerBounded -Arguments @('desktop', 'start', '--detach', '--timeout', '20') -TimeoutSeconds 25
  if ($started.ExitCode -ne 0) { throw 'Docker Desktop could not start. Inspect Docker Desktop/WSL diagnostics; this helper does not reset data or restart Windows.' }
  $deadline = (Get-Date).AddSeconds(180)
  do {
    $remaining = [Math]::Max(1, [Math]::Min(8, [int]($deadline - (Get-Date)).TotalSeconds))
    $engine = Invoke-DockerBounded -Arguments @('info', '--format', '{{.ServerVersion}}') -TimeoutSeconds $remaining
    if ($engine.ExitCode -eq 0) { break }
    if ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  } while ((Get-Date) -lt $deadline)
  if ($engine.ExitCode -ne 0) { throw 'Docker engine did not become ready. Read docs/docker-operations.md; no data was reset.' }
}

$volume = Invoke-DockerBounded -Arguments @('volume', 'inspect', '--format', '{{.Name}}', $volumeName)
if ($volume.ExitCode -ne 0 -or $volume.Output -ne $volumeName) {
  throw "Required production volume $volumeName is missing or inaccessible. Refusing an empty replacement. Follow the verified snapshot/import procedure in docs/docker-operations.md."
}

$listeners = @(Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count) {
  $containers = Invoke-DockerBounded -Arguments @('ps', '--filter', 'publish=4310', '--filter', 'label=com.docker.compose.project=frameforge-studio', '--filter', 'label=com.docker.compose.service=studio', '--format', '{{.ID}}')
  $ids = @($containers.Output -split '\r?\n' | Where-Object { $_ -match '^[a-f0-9]{12,64}$' })
  $ownedBinding = $false
  if ($containers.ExitCode -eq 0 -and $ids.Count -eq 1) {
    $bindings = Invoke-DockerBounded -Arguments @('inspect', '--format', '{{json .NetworkSettings.Ports}}', $ids[0])
    if ($bindings.ExitCode -eq 0) {
      $ports = $bindings.Output | ConvertFrom-Json
      $ownedBinding = @($ports.'4310/tcp' | Where-Object { $_.HostIp -eq '127.0.0.1' -and $_.HostPort -eq '4310' }).Count -gt 0
    }
  }
  $dockerResources = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'Docker/Docker/resources'))
  foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $dockerOwner = $owner -and $owner.ExecutablePath -and @('com.docker.backend.exe', 'vpnkit.exe') -contains (Split-Path $owner.ExecutablePath -Leaf) -and [String]::Equals((Split-Path $owner.ExecutablePath -Parent), $dockerResources, [StringComparison]::OrdinalIgnoreCase)
    # Docker's WSL port proxy can be owned by System; require the exact labeled binding too.
    if (-not $ownedBinding -or (-not $dockerOwner -and $listener.OwningProcess -ne 4)) {
      throw 'Port 4310 belongs to a native or unverified process. Complete the data snapshot/cutover first; stop only the verified native studio with scripts/stop-local.ps1 -Services studio. Nothing was stopped automatically.'
    }
  }
}

if (-not $Build) {
  $image = Invoke-DockerBounded -Arguments @('image', 'inspect', '--format', '{{.Id}}', 'frameforge-studio:local')
  if ($image.ExitCode -ne 0) { throw 'The local image is missing. Run scripts/start-docker.ps1 -Build after reviewing the source.' }
}
$previousPort = [Environment]::GetEnvironmentVariable('STUDIO_PORT', 'Process')
try {
  $env:STUDIO_PORT = '4310'
  if ($Build) {
    Write-Output 'Building the reviewed local image (up to 20 minutes).'
    $built = Invoke-DockerBounded -Arguments ($compose + @('build', 'studio')) -TimeoutSeconds 1200
    if ($built.ExitCode -ne 0) { throw 'Docker image build failed or timed out. Inspect Docker build diagnostics before retrying; host providers were not started.' }
  }
  # Mount without copy-up and inspect as the image's normal non-root user.
  # Existence of the named volume alone does not establish migrated data.
  $databaseCheck = 'try { const s = require("node:fs").lstatSync("/data/studio.sqlite"); process.exit(s.isFile() && !s.isSymbolicLink() && s.size > 0 ? 0 : 1); } catch { process.exit(1); }'
  $dataReady = Invoke-DockerBounded -Arguments @('run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', "type=volume,source=$volumeName,target=/data,readonly,volume-nocopy", '--entrypoint', 'node', 'frameforge-studio:local', '-e', $databaseCheck) -TimeoutSeconds 30
  if ($dataReady.ExitCode -ne 0) { throw 'Production volume does not contain a readable regular nonempty studio.sqlite, or its read-only verification failed. Refusing startup that could seed an empty library. Complete and verify snapshot import first.' }
  Write-Output 'Starting the production container and waiting for health.'
  $up = Invoke-DockerBounded -Arguments ($compose + @('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90')) -TimeoutSeconds 120
  if ($up.ExitCode -ne 0) { throw 'Compose failed or did not become healthy. Inspect docker compose -p frameforge-studio ps and logs; host providers were not started.' }
  $container = Invoke-DockerBounded -Arguments ($compose + @('ps', '-q', 'studio'))
  if ($container.ExitCode -ne 0 -or $container.Output -notmatch '^[a-f0-9]{12,64}$') { throw 'Cannot identify the production container after startup.' }
  $health = Invoke-DockerBounded -Arguments @('inspect', '--format', '{{.State.Health.Status}}', $container.Output)
  if ($health.ExitCode -ne 0 -or $health.Output -ne 'healthy') { throw 'Production container health was not confirmed; host providers were not started.' }
  & (Join-Path $PSScriptRoot 'start-local.ps1') -Services @('bridge', 'aside-inbox')
  Write-Output 'FrameForge Docker studio is healthy on 127.0.0.1:4310; host bridge and Aside inbox launch completed.'
} finally {
  [Environment]::SetEnvironmentVariable('STUDIO_PORT', $previousPort, 'Process')
}
