[CmdletBinding()]
param(
  [string] $Repo = ".",
  [string] $ApplicationId = "grantex",
  [string] $RepoName = "grantex",
  [string] $Workspace = ".tmp\vvaharness-runs",
  [string] $Venv = (Join-Path ([System.IO.Path]::GetTempPath()) "grantex-vvaharness-venv"),
  [string] $HarnessSpec = "git+https://github.com/visa/visa-vulnerability-agentic-harness.git@b19901585ddb94efb23917ef252847a568bba315",
  [switch] $Install,
  [switch] $Resume,
  [switch] $SkipPreflight,
  [switch] $FullPipeline,
  [ValidateSet("clone", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11")]
  [string] $StopAfter = "s9"
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venv = $Venv
$python = Join-Path $venv "Scripts\python.exe"
$vvaharness = Join-Path $venv "Scripts\vvaharness.exe"
$step1Config = Join-Path $root "security\vvaharness-step1.yaml"
$workspacePath = Join-Path $root $Workspace
$repoPath = (Resolve-Path (Join-Path $root $Repo)).Path

if ($FullPipeline -and $PSBoundParameters.ContainsKey("StopAfter")) {
  throw "Use either -FullPipeline or -StopAfter, not both."
}

if ($Install -or -not (Test-Path $vvaharness)) {
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3.10+ is required to install vvaharness."
  }

  if (-not (Test-Path $venv)) {
    python -m venv $venv
  }

  & $python -m pip install $HarnessSpec
}

if (-not (Test-Path $vvaharness)) {
  throw "vvaharness is not installed. Re-run with -Install."
}

New-Item -ItemType Directory -Force -Path $workspacePath | Out-Null

$args = @(
  "scan",
  "--repo", $repoPath,
  "--repo-name", $RepoName,
  "--application-id", $ApplicationId,
  "--workspace", $workspacePath,
  "--step1-config", $step1Config
)

if ($Resume) {
  $args += "--resume"
}

if ($SkipPreflight) {
  $args += "--skip-preflight"
}

if (-not $FullPipeline -and $StopAfter) {
  $args += @("--stop-after", $StopAfter)
}

& $vvaharness @args
