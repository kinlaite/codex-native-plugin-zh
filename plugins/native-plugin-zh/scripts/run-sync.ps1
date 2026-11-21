$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$BaseDir = Split-Path -Parent $PSScriptRoot
$DataDir = Split-Path -Parent $BaseDir
$LogFile = Join-Path $DataDir "sync.log"

function Add-Log([string]$Message) {
  try {
    $line = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  } catch {}
}

function Find-Node {
  $settingsFile = Join-Path $DataDir "settings.json"
  if (Test-Path -LiteralPath $settingsFile) {
    try {
      $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
      if ($settings.nodeBin -and (Test-Path -LiteralPath $settings.nodeBin)) {
        return $settings.nodeBin
      }
    } catch {}
  }

  if ($env:CODEX_MCP_NODE_PATH -and (Test-Path -LiteralPath $env:CODEX_MCP_NODE_PATH)) {
    return $env:CODEX_MCP_NODE_PATH
  }

  $command = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and (Test-Path -LiteralPath $command.Source)) {
    return $command.Source
  }

  $appx = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($appx -and $appx.InstallLocation) {
    $candidate = Join-Path $appx.InstallLocation "app\resources\cua_node\bin\node.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $primary = Get-AppxPackage -Name "OpenAI.CodexPrimaryRuntime*" -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($primary -and $primary.InstallLocation) {
    $dependencyRoot = Join-Path $primary.InstallLocation "dependencies"
    if (Test-Path -LiteralPath $dependencyRoot) {
      $candidate = Get-ChildItem -LiteralPath $dependencyRoot -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($candidate) { return $candidate.FullName }
    }
  }

  $candidates = @(
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
    "C:\Users\Admin\Documents\tools\node\node.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }

  if ($env:LOCALAPPDATA) {
    $runtimeRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes\cua_node"
    if (Test-Path -LiteralPath $runtimeRoot) {
      $candidate = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($candidate) { return $candidate.FullName }
    }
  }

  return $null
}

function Read-AutoTranslate {
  $settingsFile = Join-Path $DataDir "settings.json"
  if (-not (Test-Path -LiteralPath $settingsFile)) { return $true }
  try {
    $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
    return $settings.autoTranslate -ne $false
  } catch {
    return $true
  }
}

try {
  $Node = Find-Node
  if (-not $Node) { throw "Node runtime not found" }
  $Cli = Join-Path $BaseDir "scripts\cli.mjs"
  if (-not (Test-Path -LiteralPath $Cli)) { throw "Sync CLI not found: $Cli" }
  $translate = Read-AutoTranslate
  Add-Log "task-start node=$Node translate=$translate"
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  if ($translate) {
    $output = & $Node $Cli sync --translate 2>&1
  } else {
    $output = & $Node $Cli sync 2>&1
  }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  foreach ($line in @($output)) {
    Add-Log ("sync: " + [string]$line)
  }
  Add-Log "task-exit code=$code"
  exit $code
} catch {
  Add-Log "task-error $($_.Exception.Message)"
  exit 1
}
