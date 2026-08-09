[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

foreach ($property in $config.Environment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}

[IO.Directory]::CreateDirectory($config.StateDirectory) | Out-Null
$logPath = Join-Path $config.StateDirectory 'dashboard.log'
while ($true) {
    & $config.NodePath $config.DashboardPath *>> $logPath
    Add-Content -LiteralPath $logPath -Value "The dashboard exited with code $LASTEXITCODE. It restarts in 5 seconds."
    Start-Sleep -Seconds 5
}
