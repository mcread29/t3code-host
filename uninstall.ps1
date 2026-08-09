[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'lib\Guard.ps1')
. (Join-Path $root 'lib\Windows.ps1')

$instance = Get-T3CodeEnvironment 'T3CODE_INSTANCE' 'production'
Test-T3CodeInstanceName $instance
Protect-T3CodeInstance $instance 'remove'
$layout = Get-T3CodeLayout $instance

foreach ($taskName in @($layout.RefreshTask, $layout.DashboardTask, $layout.ServiceTask)) {
    $task = Get-ScheduledTask -TaskPath $layout.TaskPath -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskPath $layout.TaskPath -TaskName $taskName
        }
        Unregister-ScheduledTask -TaskPath $layout.TaskPath -TaskName $taskName -Confirm:$false
    }
}

foreach ($path in @($layout.DashboardPath, $layout.ConfigPath, $layout.ScriptDirectory, $layout.BinDirectory)) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

$repository = Get-T3CodeEnvironment 'T3CODE_REPO' $layout.Repository
Write-Host "Removed the $instance dashboard and T3 Code tasks."
Write-Host 'The npm package and the Tailscale Serve mappings stay installed.'
Write-Host "The fork checkout stays at $repository."
Write-Host 'Remove the checkout only after you save its local commits.'
