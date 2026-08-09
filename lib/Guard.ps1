Set-StrictMode -Version Latest

function Test-T3CodeInstanceName {
    param([Parameter(Mandatory)][string]$Instance)

    if ($Instance -notmatch '^[a-z0-9][a-z0-9-]*$') {
        throw 'T3CODE_INSTANCE must contain only lowercase letters, numbers, and hyphens.'
    }
}

function Protect-T3CodeInstance {
    param(
        [Parameter(Mandatory)][string]$Instance,
        [Parameter(Mandatory)][string]$Action
    )

    if ($Instance -ne 'production') {
        return
    }

    $namedInstance = [Environment]::GetEnvironmentVariable('T3CODE_INSTANCE', 'Process')
    if ([string]::IsNullOrEmpty($namedInstance)) {
        throw "Refusing to $Action production. Set T3CODE_INSTANCE to production first."
    }

    if ($env:T3CODE_YES -eq '1') {
        return
    }

    if ([Console]::IsInputRedirected) {
        throw "Refusing to $Action production without a console. Set T3CODE_YES to 1 for automation."
    }

    $reply = Read-Host "This action will $Action PRODUCTION. Type production to continue"
    if ($reply -ne 'production') {
        throw 'Aborted.'
    }
}

function Protect-T3CodeDevelopment {
    param(
        [Parameter(Mandatory)][string]$Instance,
        [Parameter(Mandatory)][int[]]$Port,
        [string]$Repository
    )

    if ($Instance -eq 'production') {
        throw 'This command is for development instances. It does not act on production.'
    }

    $productionPorts = @(
        [int]$(if ($env:T3CODE_PORT) { $env:T3CODE_PORT } else { 4123 }),
        [int]$(if ($env:T3CODE_DASH_PORT) { $env:T3CODE_DASH_PORT } else { 4124 })
    )
    foreach ($value in $Port) {
        if ($productionPorts -contains $value) {
            throw "Port $value belongs to production. Select a different port."
        }
    }

    if ($Repository) {
        $productionRoot = Join-Path $env:LOCALAPPDATA 'T3CodeHost'
        $fullRepository = [IO.Path]::GetFullPath($Repository).TrimEnd('\')
        $productionRepository = Join-Path $productionRoot 'src'
        $fullProduction = [IO.Path]::GetFullPath($productionRepository).TrimEnd('\')
        if ($fullRepository.Equals($fullProduction, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The repository belongs to production. Select a different worktree.'
        }
    }
}
