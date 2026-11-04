# Staged, not registered. Crons stay off until Frank runs this script himself.
# Registers one daily Windows task that refreshes the research corpus and the session brief.
#   pwsh -File register-daily.ps1            register (07:15 local)
#   pwsh -File register-daily.ps1 -Remove    unregister
param([switch]$Remove, [string]$At = '07:15')

$name = 'StarlightResearchCorpus'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "removed $name"; return }

$cli = Join-Path $PSScriptRoot 'corpus.mjs'
$run = Join-Path $PSScriptRoot 'scheduled-run.ps1'
$log = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.starlight/research/daily.log'
# scheduled-run.ps1 stops at the first failed step, logs every step and writes runs/last-run.json.
# brief runs last and always, so a Drive failure still leaves agents a fresh model list.
# push is left out until a Worker token is provisioned on this machine (owner's decision).
# The refresh's exit code is kept across the brief, so Task Scheduler records a failed refresh as failed.
$script = "try { & '$run'; `$refresh = `$LASTEXITCODE } catch { `$refresh = 1 }; node '$cli' brief *>> '$log'; if (`$refresh) { exit `$refresh }; exit `$LASTEXITCODE"
$action = New-ScheduledTaskAction -Execute 'pwsh' -Argument "-NoProfile -Command `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# 75 min covers four 15-minute steps plus the brief; doctor treats a "running" record older than that as killed.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 75)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Drive research -> R2 + AI Search; session brief' | Out-Null
"registered $name daily at $At; heartbeat: ~/.starlight/brief/heartbeat.json"
