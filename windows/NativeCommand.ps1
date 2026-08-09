[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments)][string[]]$NativeArgument)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$configPath = [Environment]::GetEnvironmentVariable('T3CODE_TASK_CONFIG', 'Process')
if (-not $configPath -or -not (Test-Path -LiteralPath $configPath)) {
    Write-Error 'T3CODE_TASK_CONFIG does not name a task configuration.'
    exit 1
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$commandName = [IO.Path]::GetFileNameWithoutExtension($MyInvocation.MyCommand.Path)
switch ($commandName) {
    'npm' { $commandPath = $config.NpmPath }
    'pnpm' { $commandPath = $config.PnpmPath }
    't3' { $commandPath = $config.T3CommandPath }
    default {
        Write-Error "The native command is not supported: $commandName"
        exit 1
    }
}
& $commandPath @NativeArgument
exit $LASTEXITCODE
