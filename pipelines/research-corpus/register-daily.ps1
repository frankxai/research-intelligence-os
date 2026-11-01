# Staged, not registered. Crons stay off until Frank runs this script himself.
# Registers one daily Windows task that refreshes the research corpus and the session brief.
#   pwsh -File register-daily.ps1            register (07:15 local)
#   pwsh -File register-daily.ps1 -Remove    unregister
param([switch]$Remove, [string]$At = '07:15')

$name = 'StarlightResearchCorpus'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "removed $name"; return }

$cli = Join-Path $PSScriptRoot 'corpus.mjs'
$log = Join-Path $HOME '.starlight/research/daily.log'
# brief runs last and always, so a Drive or R2 failure still leaves agents a fresh model list.
$script = "node '$cli' list; node '$cli' classify; node '$cli' export; node '$cli' push; node '$cli' brief *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'pwsh' -Argument "-NoProfile -Command `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Drive research -> R2 + AI Search; session brief' | Out-Null
"registered $name daily at $At; heartbeat: ~/.starlight/brief/heartbeat.json"
