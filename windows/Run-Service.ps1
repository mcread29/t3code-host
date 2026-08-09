[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

foreach ($property in $config.Environment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}

$hostAddress = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $hostAddress = @(& $config.TailscalePath ip -4 2>$null | Where-Object { $_ })[0]
    if ($hostAddress) {
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $hostAddress) {
    Write-Error 'No Tailscale IPv4 address is available after 60 seconds.'
    exit 1
}

[IO.Directory]::CreateDirectory($config.StateDirectory) | Out-Null
$logPath = Join-Path $config.StateDirectory 't3code.log'
while ($true) {
    & $config.T3Bin serve --mode web --host $hostAddress --port $config.ServicePort *>> $logPath
    Add-Content -LiteralPath $logPath -Value "T3 Code exited with code $LASTEXITCODE. It restarts in 5 seconds."
    Start-Sleep -Seconds 5
}
