param(
  [ValidateRange(1, 24)]
  [int]$Epochs = 12,

  [ValidateRange(1, 300)]
  [int]$SoakSeconds = 300,

  [string]$ComposeProject = 'grantex_endurance_20260901',

  [string]$OutputDirectory = '',

  [switch]$AllowThresholdFailures
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$authContainer = "$ComposeProject-auth-service-1"
$nodeImage = 'node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3'
$started = (Get-Date).ToUniversalTime()

if (-not $OutputDirectory) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutputDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "grantex-endurance-$stamp"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path $OutputDirectory).Path

$running = docker inspect $authContainer --format '{{.State.Running}}' 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
  throw "Auth-service container is not running: $authContainer"
}

$summaries = [System.Collections.Generic.List[object]]::new()
Write-Output "[endurance] artifacts=$OutputDirectory"
Write-Output "[endurance] start=$($started.ToString('o')) epochs=$Epochs soak_seconds=$SoakSeconds generator=docker-network-namespace"

for ($epoch = 1; $epoch -le $Epochs; $epoch += 1) {
  $epochStarted = (Get-Date).ToUniversalTime()
  $fileName = 'epoch-{0:d2}.json' -f $epoch
  $hostReport = Join-Path $OutputDirectory $fileName
  $containerReport = "/reports/$fileName"
  $dockerArgs = @(
    'run', '--rm',
    '--network', "container:$authContainer",
    '--mount', "type=bind,source=$repo,target=/work,readonly",
    '--mount', "type=bind,source=$OutputDirectory,target=/reports",
    '-w', '/work',
    $nodeImage,
    'node', 'scripts/docker-stress-test.mjs',
    '--base-url=http://127.0.0.1:3001',
    '--api-key=dev-api-key-local',
    '--metrics-key=local-metrics-api-key',
    "--soak-seconds=$SoakSeconds",
    "--report=$containerReport"
  )
  if ($AllowThresholdFailures) {
    $dockerArgs += '--allow-threshold-fail'
  }

  & docker @dockerArgs | Out-Null
  $childExit = $LASTEXITCODE
  $epochEnded = (Get-Date).ToUniversalTime()
  if (-not (Test-Path -LiteralPath $hostReport)) {
    throw "Epoch $epoch did not produce $hostReport (exit $childExit)"
  }

  $report = Get-Content -Raw -LiteralPath $hostReport | ConvertFrom-Json
  $soak = $report.scenarios | Where-Object name -eq 'jwks_sustained_soak'
  $recovery = $report.scenarios | Where-Object name -eq 'post_pressure_recovery'
  $failed = @($report.scenarios | Where-Object passed -eq $false | ForEach-Object name)
  $totalRequests = ($report.scenarios | Measure-Object requests -Sum).Sum
  $serverErrors = ($report.scenarios | Measure-Object server_errors -Sum).Sum
  $disallowedNetworkErrors = (
    $report.scenarios
    | Where-Object allowed_network_errors -eq $false
    | Measure-Object network_errors -Sum
  ).Sum
  $stats = docker stats --no-stream --format '{{json .}}' $authContainer | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) {
    throw "Could not sample Docker resources for $authContainer"
  }

  $summary = [pscustomobject]@{
    epoch = $epoch
    started_utc = $epochStarted.ToString('o')
    ended_utc = $epochEnded.ToString('o')
    duration_minutes = [math]::Round(($epochEnded - $epochStarted).TotalMinutes, 2)
    child_exit_code = $childExit
    passed = [bool]$report.passed
    failed_scenarios = $failed
    total_requests = $totalRequests
    soak_requests_per_second = $soak.requests_per_second
    soak_p95_ms = $soak.p95_ms
    soak_p99_ms = $soak.p99_ms
    recovery_p95_ms = $recovery.p95_ms
    server_errors = $serverErrors
    disallowed_network_errors = $disallowedNetworkErrors
    cardinality_delta = $report.cardinality.series_delta
    auth_memory_after = $stats.MemUsage
    auth_cpu_after = $stats.CPUPerc
    auth_pids = $stats.PIDs
  }
  $summaries.Add($summary)
  $summaries | Export-Csv -LiteralPath (Join-Path $OutputDirectory 'epochs.csv') -NoTypeInformation

  $message = (
    '[endurance] epoch={0}/{1} passed={2} failed={3} requests={4} soak_rps={5} ' +
    'soak_p95={6} recovery_p95={7} errors={8}/{9} cardinality_delta={10} memory={11}'
  ) -f @(
    $epoch, $Epochs, $report.passed, ($failed -join ','), $totalRequests,
    $soak.requests_per_second, $soak.p95_ms, $recovery.p95_ms,
    $serverErrors, $disallowedNetworkErrors, $report.cardinality.series_delta,
    $stats.MemUsage
  )
  Write-Output $message

  if ($childExit -ne 0 -and -not $AllowThresholdFailures) {
    throw "Epoch $epoch failed one or more thresholds"
  }
}

$ended = (Get-Date).ToUniversalTime()
$result = [ordered]@{
  schema_version = 1
  generated_at = $ended.ToString('o')
  local_only = $true
  generator = 'docker-network-namespace'
  auth_container = $authContainer
  started_utc = $started.ToString('o')
  ended_utc = $ended.ToString('o')
  duration_minutes = [math]::Round(($ended - $started).TotalMinutes, 2)
  epochs_requested = $Epochs
  epochs_completed = $summaries.Count
  soak_seconds_per_epoch = $SoakSeconds
  total_requests = ($summaries | Measure-Object total_requests -Sum).Sum
  total_server_errors = ($summaries | Measure-Object server_errors -Sum).Sum
  total_disallowed_network_errors = ($summaries | Measure-Object disallowed_network_errors -Sum).Sum
  all_thresholds_passed = @($summaries | Where-Object passed -eq $false).Count -eq 0
  epochs = $summaries
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'summary.json') -Encoding utf8
Write-Output "[endurance] complete=$($ended.ToString('o')) artifacts=$OutputDirectory"
