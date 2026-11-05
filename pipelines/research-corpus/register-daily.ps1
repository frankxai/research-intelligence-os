# Staged, not registered. Crons stay off until Frank runs this script himself.
# Registers one daily Windows task that refreshes the research corpus and the session brief.
#   pwsh -File register-daily.ps1            register (07:15 local)
#   pwsh -File register-daily.ps1 -Remove    unregister
param([switch]$Remove, [string]$At = '07:15')

$name = 'StarlightResearchCorpus'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "removed $name"; return }

$cli = Join-Path $PSScriptRoot 'corpus.mjs'
$log = Join-Path $HOME '.starlight/research/daily.log'
# brief runs before push because it writes _platform/latest-models.md into the corpus, which push
# then uploads; ';' keeps every step running after an earlier failure, so a Drive outage still
# refreshes the model list. The script block sends every step's output to the log, not only the last.
$script = "& { node '$cli' list; node '$cli' classify; node '$cli' export; node '$cli' brief; node '$cli' push } *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'pwsh' -Argument "-NoProfile -Command `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Drive research -> R2 + AI Search; session brief' | Out-Null
"registered $name daily at $At; heartbeat: ~/.starlight/brief/heartbeat.json"
