[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments)][string[]]$DevArgument)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'lib\Guard.ps1')
. (Join-Path $root 'lib\Windows.ps1')

$arguments = [Collections.Generic.List[string]]::new()
$mock = Get-T3CodeEnvironment 'T3CODE_MOCK' ''
foreach ($argument in $DevArgument) {
    if ($argument -eq '--dash-only') { continue }
    if ($argument -eq '--mock') { $mock = '1'; continue }
    $arguments.Add($argument)
}
$commandName = if ($arguments.Count -gt 0) { $arguments[0] } else { 'serve' }
$instance = Get-T3CodeEnvironment 'T3CODE_INSTANCE' 'dev'
Test-T3CodeInstanceName $instance
$productionLayout = Get-T3CodeLayout 'production'
$repository = Get-T3CodeEnvironment 'T3CODE_REPO' $productionLayout.DevelopmentRepository
$branch = Get-T3CodeEnvironment 'T3CODE_BRANCH' 'dev'
$developmentRepository = Get-T3CodeEnvironment 'T3CODE_DEV_REPO' ''
$developmentBranch = Get-T3CodeEnvironment 'T3CODE_DEV_BRANCH' 'dev'
$dashboardPort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_DASH_PORT' '5124')
Protect-T3CodeDevelopment -Instance $instance -Port @($dashboardPort) -Repository $repository

switch ($commandName) {
    'check' {
        $env:T3CODE_INSTANCE = $instance
        $env:T3CODE_REPO = $repository
        & (Join-Path $root 'check.ps1')
        exit $LASTEXITCODE
    }
    'down' {
        $env:T3CODE_INSTANCE = $instance
        & (Join-Path $root 'uninstall.ps1')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $prefix = (Get-T3CodeLayout $instance).NpmPrefix
        if (Test-Path -LiteralPath $prefix) {
            Write-Host "Removing the isolated npm prefix at $prefix."
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }
        exit 0
    }
    'serve' {
        $node = Get-T3CodeCommandPath @('node.exe')
        $tailscale = Get-T3CodeCommandPath @('tailscale.exe')
        $dashboardSource = Join-Path $root 'src\t3code-dashboard.mjs'
        $stubSource = Join-Path $root 'src\dev-stub-t3.mjs'
        Test-T3CodeDashboardSource -NodePath $node -SourcePath $dashboardSource
        Invoke-T3CodeNative $node --check $stubSource
        $hostAddress = Get-T3CodeTailnetAddress -TailscalePath $tailscale
        if (-not $hostAddress) {
            throw 'No Tailscale IPv4 address is available.'
        }

        $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "t3code-dev-$([guid]::NewGuid().ToString('N'))"
        [IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
        $stubHome = Join-Path $temporaryRoot 'stub-home'
        $stubLog = Join-Path $temporaryRoot 'stub.log'
        $stubError = Join-Path $temporaryRoot 'stub-error.log'
        $dashboardCopy = Join-Path $temporaryRoot 't3code-dashboard.mjs'
        [IO.Directory]::CreateDirectory($stubHome) | Out-Null
        Copy-T3CodeWindowsDashboard -SourcePath $dashboardSource -DestinationPath $dashboardCopy

        $stubProcess = $null
        $dashboardProcess = $null
        $savedEnvironment = @{}
        $environmentNames = @(
            'T3CODE_STUB_HOME', 'T3CODE_DASH_PORT', 'T3CODE_PROXY_ORIGIN', 'T3CODE_HOME',
            'T3CODE_STATE_DIR', 'T3CODE_UNIT', 'T3CODE_MOCK', 'T3CODE_HOST_REPO',
            'T3CODE_REPO', 'T3CODE_DEV_REPO', 'T3CODE_BRANCH', 'T3CODE_DEV_BRANCH'
        )
        foreach ($name in $environmentNames) {
            $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        }
        try {
            $env:T3CODE_STUB_HOME = $stubHome
            $stubProcess = Start-Process -FilePath $node -ArgumentList @($stubSource) -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $stubLog -RedirectStandardError $stubError

            $webPort = $null
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                if (Test-Path -LiteralPath $stubLog) {
                    $stubOutput = Get-Content -LiteralPath $stubLog -Raw
                    if ($stubOutput) {
                        $match = [regex]::Match($stubOutput, 'webPort=(\d+)')
                        if ($match.Success) {
                            $webPort = [int]$match.Groups[1].Value
                            break
                        }
                    }
                }
                if ($stubProcess.HasExited) {
                    $detail = if (Test-Path -LiteralPath $stubError) { Get-Content -LiteralPath $stubError -Tail 20 | Out-String } else { '' }
                    throw "The stub exited before it reported a port. $detail"
                }
                Start-Sleep -Seconds 1
            }
            if (-not $webPort) {
                throw 'The stub did not report a port in 30 seconds.'
            }

            $env:T3CODE_DASH_PORT = [string]$dashboardPort
            $env:T3CODE_PROXY_ORIGIN = "http://localhost:$webPort"
            $env:T3CODE_HOME = $stubHome
            $env:T3CODE_STATE_DIR = Join-Path $stubHome 'dashboard-state'
            $env:T3CODE_UNIT = ''
            $env:T3CODE_MOCK = $mock
            $env:T3CODE_HOST_REPO = $root
            $env:T3CODE_REPO = $repository
            $env:T3CODE_DEV_REPO = $developmentRepository
            $env:T3CODE_BRANCH = $branch
            $env:T3CODE_DEV_BRANCH = $developmentBranch
            $dashboardProcess = Start-Process -FilePath $node -ArgumentList @('--watch', $dashboardCopy) -WorkingDirectory $root -PassThru -NoNewWindow

            Write-Host ''
            Write-Host "  dashboard   http://${hostAddress}:$dashboardPort/dashboard"
            Write-Host "  T3 Code     http://localhost:$webPort/"
            Write-Host ''
            Write-Host 'The dashboard reloads after a save. Press Ctrl+C to stop it.'

            $sourceWriteTime = (Get-Item -LiteralPath $dashboardSource).LastWriteTimeUtc
            while (-not $dashboardProcess.HasExited) {
                Start-Sleep -Milliseconds 500
                $currentWriteTime = (Get-Item -LiteralPath $dashboardSource).LastWriteTimeUtc
                if ($currentWriteTime -gt $sourceWriteTime) {
                    Test-T3CodeDashboardSource -NodePath $node -SourcePath $dashboardSource
                    Copy-T3CodeWindowsDashboard -SourcePath $dashboardSource -DestinationPath $dashboardCopy
                    $sourceWriteTime = $currentWriteTime
                }
            }
            exit $dashboardProcess.ExitCode
        } finally {
            foreach ($process in @($dashboardProcess, $stubProcess)) {
                if ($process -and -not $process.HasExited) {
                    & taskkill.exe /PID $process.Id /T /F *> $null
                }
            }
            foreach ($name in $environmentNames) {
                [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
            }
            if (Test-Path -LiteralPath $temporaryRoot) {
                Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    default {
        Write-Host 'Use dev.ps1, dev.ps1 --mock, dev.ps1 check, or dev.ps1 down.'
        exit 1
    }
}
