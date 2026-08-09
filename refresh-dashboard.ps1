[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'lib\Guard.ps1')
. (Join-Path $root 'lib\Windows.ps1')

$instance = Get-T3CodeEnvironment 'T3CODE_INSTANCE' 'production'
Test-T3CodeInstanceName $instance
Protect-T3CodeInstance $instance 'refresh the dashboard of'
$layout = Get-T3CodeLayout $instance

$task = Get-ScheduledTask -TaskPath $layout.TaskPath -TaskName $layout.DashboardTask -ErrorAction SilentlyContinue
if (-not $task) {
    throw "No dashboard task is installed for $instance. Run install.ps1 first."
}

$node = Get-T3CodeCommandPath @('node.exe')
$sourcePath = Join-Path $root 'src\t3code-dashboard.mjs'
Test-T3CodeDashboardSource -NodePath $node -SourcePath $sourcePath

if (Test-Path -LiteralPath $layout.DashboardPath) {
    $target = Get-Item -LiteralPath $layout.DashboardPath -Force
    if ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'A dashboard source link is not supported on Windows.'
    }
}
Copy-T3CodeWindowsDashboard -SourcePath $sourcePath -DestinationPath $layout.DashboardPath
Write-Host "Installed $sourcePath to $($layout.DashboardPath)."

Restart-T3CodeTask -TaskPath $layout.TaskPath -TaskName $layout.DashboardTask
Write-Host "Restarted $($layout.DashboardTask)."

$env:T3CODE_INSTANCE = $instance
& (Join-Path $root 'check.ps1')
exit $LASTEXITCODE
