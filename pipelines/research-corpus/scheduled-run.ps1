#Requires -Version 7
# Staged, not registered. One unattended refresh: Drive list -> classify -> export -> doctor.
# The owner registers it (register-daily.ps1); nothing here launches Gemini, pushes to R2 or writes to Drive
# (the rclone remote is drive.readonly).
#   pwsh -NoProfile -File scheduled-run.ps1             run once now
#   pwsh -NoProfile -File scheduled-run.ps1 -DryRun     print the plan, run nothing
# Every run writes RESEARCH_HOME/runs/last-run.json; `node corpus.mjs doctor` flags a failed, skipped or missing run.
param(
  [switch]$DryRun,
  [int]$StepTimeoutMinutes = 15,
  [int]$StaleLockMinutes = 120
)
$ErrorActionPreference = 'Stop'

# UserProfile, not $HOME: some agent shells on this machine do not set HOME.
$researchHome = if ($env:RESEARCH_HOME) { $env:RESEARCH_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.starlight/research' }
$runs = Join-Path $researchHome 'runs'
$cli = Join-Path $PSScriptRoot 'corpus.mjs'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
$log = Join-Path $runs "$stamp.log"
$lock = Join-Path $runs 'scheduled-run.lock'
$lastRun = Join-Path $runs 'last-run.json'
# doctor skips its own last-run check here: that file still describes the previous run.
$steps = @(
  @{ name = 'list'; args = @('list') },
  @{ name = 'classify'; args = @('classify') },
  @{ name = 'export'; args = @('export') },
  @{ name = 'doctor'; args = @('doctor', '--skip', 'last-run') }
)

if ($DryRun) {
  "research home: $researchHome"
  "log:          $log"
  foreach ($s in $steps) { "would run:    node `"$cli`" $($s.args -join ' ')  (timeout ${StepTimeoutMinutes}m)" }
  return
}

New-Item -ItemType Directory -Force -Path $runs | Out-Null
function Write-Record([string]$status, $done) {
  $record = [ordered]@{ ts = (Get-Date).ToUniversalTime().ToString('o'); status = $status; steps = $done; log = $log }
  $tmp = "$lastRun.tmp"
  $record | ConvertTo-Json -Depth 4 | Set-Content -Path $tmp -Encoding utf8
  Move-Item -Force -Path $tmp -Destination $lastRun
}

# One run at a time: the lock is created atomically. A lock older than StaleLockMinutes belongs to
# a run that died; it is taken over.
try {
  $fs = [IO.File]::Open($lock, [IO.FileMode]::CreateNew)
  $fs.Dispose()
} catch [IO.IOException] {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalMinutes -lt $StaleLockMinutes) {
    Add-Content -Path $log -Value "skipped: lock held for $([int]$age.TotalMinutes) min"
    Write-Record 'skipped-locked' @()
    exit 0
  }
  Add-Content -Path $log -Value "taking over a stale lock ($([int]$age.TotalMinutes) min old)"
}
Set-Content -Path $lock -Value $PID
# Written first, so a run the scheduler kills cannot leave the previous run's "ok" behind.
Write-Record 'running' @()

$done = @()
$status = 'ok'
try {
  foreach ($s in $steps) {
    $out = Join-Path $runs "$stamp.$($s.name).out"
    $err = Join-Path $runs "$stamp.$($s.name).err"
    $started = Get-Date
    Add-Content -Path $log -Value "== $($s.name) $($started.ToUniversalTime().ToString('o'))"
    $argList = @("`"$cli`"") + $s.args
    $p = Start-Process -FilePath 'node' -ArgumentList $argList -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle  # caching the handle keeps ExitCode readable after the process exits
    if (-not $p.WaitForExit($StepTimeoutMinutes * 60 * 1000)) {
      $p.Kill($true)
      $p.WaitForExit()  # Kill returns before the process is gone; its output files are still open
      $code = 'timeout'
    } else {
      $code = $p.ExitCode
    }
    foreach ($f in @($out, $err)) { if (Test-Path $f) { Get-Content -Path $f | Add-Content -Path $log; Remove-Item -Path $f } }
    $done += [ordered]@{ step = $s.name; exit = "$code"; seconds = [int]((Get-Date) - $started).TotalSeconds }
    if ("$code" -ne '0') {
      $status = if ($s.name -eq 'doctor') { 'doctor-fail' } else { "failed:$($s.name):$code" }
      break
    }
  }
} catch {
  Add-Content -Path $log -Value "error: $($_.Exception.Message)"
  $status = 'error'
} finally {
  Write-Record $status $done
  Remove-Item -Path $lock -ErrorAction SilentlyContinue
}
Add-Content -Path $log -Value "== end $status"
"$status -> $lastRun"
if ($status -ne 'ok') { exit 1 }
