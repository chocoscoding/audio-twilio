# Creates placeholder speech for every spoken line in script.json using an
# installed Windows voice, so the demo runs before real recordings exist.
# Files in ..\recordings\ always take priority over these placeholders.
#
#   npm run demo:placeholders
#   powershell -File apps/telephony-demo/scripts/make-placeholders.ps1 -Voice "Microsoft David Desktop"

param([string]$Voice = 'Microsoft Zira Desktop')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$appDir = Split-Path -Parent $PSScriptRoot
$script = Get-Content -Raw -Encoding UTF8 (Join-Path $appDir 'script.json') | ConvertFrom-Json
$outDir = Join-Path $appDir 'placeholders'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$names = @{ 'en-US' = 'English'; 'es-US' = 'Spanish' }
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($line in $script.lines) {
  if ($line.gate -and $line.gate.status -eq 'FAIL') { continue } # blocked lines are never spoken

  $target = if ($line.speaker -eq 'clinician') { $script.patientLanguageId } else { $script.clinicianLanguageId }
  if ($target -like 'en-*') {
    $text = $line.translation
  } else {
    $language = if ($names.ContainsKey($target)) { $names[$target] } else { $target }
    $text = "Placeholder for the $language recording. It says: $($line.says)"
  }

  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $synth.SelectVoice($Voice)
    $synth.SetOutputToWaveFile((Join-Path $outDir "$($line.id).wav"), $format)
    $synth.Speak($text)
  } finally {
    $synth.Dispose()
  }
  Write-Output "placeholder  $($line.id).wav"
}
