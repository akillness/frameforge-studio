param([ValidateSet('voices','synthesize')][string]$Action = 'voices', [string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($speaker.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {
    @{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name }
  })
  if ($Action -eq 'voices') { ConvertTo-Json -InputObject $voices -Compress; exit 0 }
  $payload = [IO.File]::ReadAllText($InputPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if (-not ($voices | Where-Object { $_.id -ceq $payload.voice })) { throw 'Selected voice is not installed' }
  if ($payload.text -isnot [string] -or $payload.text.Length -gt 4000 -or [string]::IsNullOrWhiteSpace($payload.text)) { throw 'Invalid speech text' }
  if ($payload.rate -lt -10 -or $payload.rate -gt 10) { throw 'Invalid speech rate' }
  $speaker.SelectVoice($payload.voice)
  $speaker.Rate = [int]$payload.rate
  $speaker.SetOutputToWaveFile($OutputPath)
  $speaker.Speak($payload.text)
  $speaker.SetOutputToNull()
} finally { $speaker.Dispose() }
