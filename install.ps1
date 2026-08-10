[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'lib\Guard.ps1')
. (Join-Path $root 'lib\Windows.ps1')

$instance = Get-T3CodeEnvironment 'T3CODE_INSTANCE' 'production'
Test-T3CodeInstanceName $instance
Protect-T3CodeInstance $instance 'install over'
$layout = Get-T3CodeLayout $instance

if ($instance -eq 'production') {
    $servicePort = [int](Get-T3CodeEnvironment 'T3CODE_PORT' '4123')
    $dashboardPort = [int](Get-T3CodeEnvironment 'T3CODE_DASH_PORT' '4124')
    $pairPort = [int](Get-T3CodeEnvironment 'T3CODE_PAIR_PORT' '443')
    $devServePort = [int](Get-T3CodeEnvironment 'T3CODE_DEV_SERVE_PORT' '8447')
} else {
    $servicePort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_PORT' '5123')
    $dashboardPort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_DASH_PORT' '5124')
    $pairPort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_PAIR_PORT' '8446')
    $devServePort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_DEV_SERVE_PORT' '8448')
}
$devConsolePort = $dashboardPort + 1
$dashboardHost = Get-T3CodeEnvironment 'T3CODE_DASH_HOST' '127.0.0.1'
$channel = Get-T3CodeEnvironment 'T3CODE_CHANNEL' 'nightly'
$npmPrefix = Get-T3CodeEnvironment 'T3CODE_NPM_PREFIX' $layout.NpmPrefix
if ([string]::IsNullOrWhiteSpace($npmPrefix)) {
    $npmPrefix = $layout.NpmPrefix
}
$t3HomeDefault = if ($instance -eq 'production') { Join-Path $HOME '.t3' } else { $layout.T3Home }
$t3HomeName = if ($instance -eq 'production') { 'T3CODE_HOME' } else { 'T3CODE_TEST_HOME' }
$t3Home = Get-T3CodeEnvironment $t3HomeName $t3HomeDefault
$repository = Get-T3CodeEnvironment 'T3CODE_REPO' $layout.Repository
$developmentRepository = Get-T3CodeEnvironment 'T3CODE_DEV_REPO' $layout.DevelopmentRepository
$forkUrl = Get-T3CodeEnvironment 'T3CODE_FORK_URL' 'git@github.com:mcread29/t3code.git'
$upstreamUrl = Get-T3CodeEnvironment 'T3CODE_UPSTREAM_URL' 'git@github.com:pingdotgg/t3code.git'
$branch = Get-T3CodeEnvironment 'T3CODE_BRANCH' 'deploy'
$developmentBranch = Get-T3CodeEnvironment 'T3CODE_DEV_BRANCH' 'dev'
$skipBuild = (Get-T3CodeEnvironment 'T3CODE_SKIP_BUILD' '0') -eq '1'
$settingsPath = Join-Path $layout.StateDirectory 'settings.json'

# Developer mode. A machine in this mode does the integration: it tracks
# upstream, it keeps main and a dev worktree, and its dashboard shows the dev
# section. Each other machine gets the release only. Thus it clones one branch,
# it has one remote, and it has no second worktree.
#
# The dashboard owns the setting after the first install. This script reads
# that file, so an install does not undo a choice you made in the dialog.
$devModeNamed = -not [string]::IsNullOrWhiteSpace((Get-T3CodeEnvironment 'T3CODE_DEV_MODE' ''))
if ($devModeNamed) {
    $devMode = (Get-T3CodeEnvironment 'T3CODE_DEV_MODE' '0') -eq '1'
} elseif (Test-Path -LiteralPath $settingsPath) {
    $devMode = (Get-Content -LiteralPath $settingsPath -Raw) -match '"devMode"\s*:\s*true'
} else {
    $devMode = $false
}
if ($devMode) {
    Write-Host 'Developer mode: on. This machine manages main, dev, and the promotions.'
} else {
    Write-Host "Developer mode: off. This machine gets the $branch release only."
}

$node = Get-T3CodeCommandPath @('node.exe')
$npm = Get-T3CodeCommandPath @('npm.cmd')
$pnpm = Get-T3CodeCommandPath @('pnpm.cmd')
$git = Get-T3CodeCommandPath @('git.exe')
$tailscale = Get-T3CodeCommandPath @('tailscale.exe')
$pwsh = (Get-Process -Id $PID).Path
$cargo = Get-Command cargo.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cargo) {
    Write-Host 'Note: Cargo is not available. The resource monitor is not built.'
}

$serveSite = Get-T3CodeServeSite -TailscalePath $tailscale -Port $pairPort
if ($serveSite -and $serveSite.Target -notmatch ":($dashboardPort|$servicePort)$") {
    throw "Tailscale Serve port $pairPort already proxies to $($serveSite.Target)."
}

$directories = @(
    $layout.AppDirectory,
    $layout.StateDirectory,
    $layout.ScriptDirectory,
    $layout.BinDirectory,
    $npmPrefix,
    $t3Home
)
foreach ($directory in $directories) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}

# The dashboard shows the dev section from the setting file. It serves the
# development worktree only when it has one, so a release machine gives it no
# path.
$unitDevelopmentRepository = if ($devMode) { $developmentRepository } else { '' }

# Write the mode only when the file is absent, or when you named the mode. Thus
# a plain install keeps the choice that the settings dialog made.
if ($devModeNamed -or -not (Test-Path -LiteralPath $settingsPath)) {
    $devModeJson = if ($devMode) { 'true' } else { 'false' }
    Set-Content -LiteralPath $settingsPath -Value "{`n  `"devMode`": $devModeJson`n}" -Encoding utf8
}

$buildCurrent = $false
$buildMade = $false
$buildOk = $true
if ($skipBuild) {
    Write-Host 'Skipping the source build. The dashboard is the only process that restarts.'
} else {
    if ((Get-T3CodeEnvironment 'T3CODE_SKIP_BOOTSTRAP' '0') -eq '1') {
        Write-Host "Rebuilding $repository without a bootstrap step."
    } else {
        Write-Host "Installing t3@$channel as a fallback."
        $oldCi = $env:CI
        try {
            $env:CI = '1'
            Invoke-T3CodeNative $npm install --global --prefix $npmPrefix "t3@$channel"
        } finally {
            $env:CI = $oldCi
        }

        Write-Host "Preparing the fork checkout at $repository."
        if (-not (Test-Path -LiteralPath (Join-Path $repository '.git'))) {
            if ($devMode) {
                Invoke-T3CodeNative $git clone $forkUrl $repository
            } else {
                # One branch, because a release machine builds one branch.
                Invoke-T3CodeNative $git clone --branch $branch --single-branch $forkUrl $repository
            }
        }

        if ($devMode) {
            & $git -C $repository remote get-url upstream *> $null
            if ($LASTEXITCODE -ne 0) {
                Invoke-T3CodeNative $git -C $repository remote add upstream $upstreamUrl
            }
            Invoke-T3CodeNative $git -C $repository fetch --prune --multiple origin upstream
        } else {
            # A release machine has one remote. Thus nothing on it tracks the
            # upstream project, and the dashboard reads the branch it builds.
            & $git -C $repository remote get-url upstream *> $null
            if ($LASTEXITCODE -eq 0) {
                Invoke-T3CodeNative $git -C $repository remote remove upstream
                Write-Host 'Removed the upstream remote. Developer mode is off.'
            }
            Invoke-T3CodeNative $git -C $repository fetch --prune origin
        }

        # main mirrors upstream. Developer mode reads it, and it moves it. A
        # clone makes it only when it is the default branch of the fork, so
        # make it here. Without a local main, the dashboard reads no distance
        # and each integration step says "synced" while it is not.
        if ($devMode) {
            & $git -C $repository show-ref --verify --quiet 'refs/heads/main'
            if ($LASTEXITCODE -ne 0) {
                & $git -C $repository show-ref --verify --quiet 'refs/remotes/origin/main'
                if ($LASTEXITCODE -eq 0) {
                    Invoke-T3CodeNative $git -C $repository branch main origin/main
                } else {
                    Invoke-T3CodeNative $git -C $repository branch main upstream/main
                }
                Write-Host 'Made the local main branch.'
            }
        }

        & $git -C $repository show-ref --verify --quiet "refs/heads/$branch"
        if ($LASTEXITCODE -ne 0) {
            & $git -C $repository show-ref --verify --quiet "refs/remotes/origin/$branch"
            if ($LASTEXITCODE -eq 0) {
                Invoke-T3CodeNative $git -C $repository branch $branch "origin/$branch"
            } elseif ($devMode) {
                Invoke-T3CodeNative $git -C $repository branch $branch origin/main
                Invoke-T3CodeNative $git -C $repository push -u origin $branch
            } else {
                throw "The fork has no origin/$branch branch. Make it on the machine that has developer mode on, and push it."
            }
        }
        Invoke-T3CodeNative $git -C $repository checkout $branch

        $dirty = (& $git -C $repository status --porcelain | Out-String).Trim()
        if ($dirty) {
            if ((Get-T3CodeEnvironment 'T3CODE_ALLOW_DIRTY' '0') -ne '1') {
                throw "The deployment worktree is not clean: $repository"
            }
            Write-Host "Note: $repository has uncommitted changes. The build includes them."
        }

        # Developer mode alone makes the development worktree. A release
        # machine never merges, so a second worktree there is a copy of the
        # source that nothing reads.
        if ($devMode -and -not [IO.Path]::GetFullPath($developmentRepository).Equals(
            [IO.Path]::GetFullPath($repository), [StringComparison]::OrdinalIgnoreCase)) {
            & $git -C $repository show-ref --verify --quiet "refs/heads/$developmentBranch"
            if ($LASTEXITCODE -ne 0) {
                & $git -C $repository show-ref --verify --quiet "refs/remotes/origin/$developmentBranch"
                if ($LASTEXITCODE -eq 0) {
                    Invoke-T3CodeNative $git -C $repository branch $developmentBranch "origin/$developmentBranch"
                } else {
                    Invoke-T3CodeNative $git -C $repository branch $developmentBranch $branch
                }
            }
            if (-not (Test-Path -LiteralPath (Join-Path $developmentRepository '.git'))) {
                if (Test-Path -LiteralPath $developmentRepository) {
                    throw "The development path is not a Git worktree: $developmentRepository"
                }
                Invoke-T3CodeNative $git -C $repository worktree add $developmentRepository $developmentBranch
            }
        }
    }

    $headSha = (& $git -C $repository rev-parse --short HEAD | Select-Object -First 1).Trim()
    $builtPath = Join-Path $layout.StateDirectory 'built-sha'
    $builtSha = if (Test-Path -LiteralPath $builtPath) { (Get-Content -LiteralPath $builtPath -Raw).Trim() } else { '' }
    $buildCurrent = (Get-T3CodeEnvironment 'T3CODE_FORCE_BUILD' '0') -ne '1' -and $builtSha -eq $headSha
    foreach ($asset in @('dist\bin.mjs', 'dist\service-launcher.mjs', 'dist\client\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $repository "apps\server\$asset"))) {
            $buildCurrent = $false
        }
    }

    if ($buildCurrent) {
        Write-Host "The build at $headSha is current."
    } else {
        Write-Host "Building T3 Code from $branch."
        Push-Location $repository
        try {
            Invoke-T3CodeNative $pnpm install --frozen-lockfile
            Invoke-T3CodeNative $pnpm exec vp run --filter '@t3tools/web' build
            Invoke-T3CodeNative $node 'apps\server\scripts\cli.ts' build --verbose
            if ($cargo) {
                try {
                    Invoke-T3CodeNative $pnpm run 'build:resource-monitor'
                    $monitorSource = Join-Path $repository 'native\resource-monitor\target\release\t3-resource-monitor.exe'
                    if (Test-Path -LiteralPath $monitorSource) {
                        $monitorTarget = Join-Path $repository 'apps\server\dist\resource-monitor\win32-x64'
                        [IO.Directory]::CreateDirectory($monitorTarget) | Out-Null
                        Copy-Item -LiteralPath $monitorSource -Destination $monitorTarget -Force
                    }
                } catch {
                    Write-Warning 'The resource monitor build failed. The main build continues.'
                }
            }
            $buildMade = $true
        } catch {
            $buildOk = $false
            Write-Warning 'The source build failed. The fallback package stays installed.'
            Write-Warning $_.Exception.Message
        } finally {
            Pop-Location
        }
    }

    if ($buildOk) {
        Write-Host 'Installing the source build.'
        $oldCi = $env:CI
        try {
            $env:CI = '1'
            Invoke-T3CodeNative $npm install --global --prefix $npmPrefix (Join-Path $repository 'apps\server')
        } finally {
            $env:CI = $oldCi
        }
        $headSha = (& $git -C $repository rev-parse --short HEAD | Select-Object -First 1).Trim()
        Set-Content -LiteralPath (Join-Path $layout.StateDirectory 'built-sha') -Value $headSha -NoNewline
    }
}

$t3CommandPath = Join-Path $npmPrefix 't3.cmd'
if (-not (Test-Path -LiteralPath $t3CommandPath)) {
    throw "The t3 command does not exist: $t3CommandPath"
}
if ($instance -eq 'production' -and -not $skipBuild) {
    Write-Host 'Removing the package service before the task starts.'
    & $t3CommandPath service uninstall *> $null
} elseif ($instance -ne 'production') {
    Write-Host "Installing isolated tasks for $instance."
}

$sourceDashboard = Join-Path $root 'src\t3code-dashboard.mjs'
Test-T3CodeDashboardSource -NodePath $node -SourcePath $sourceDashboard
if ((Get-T3CodeEnvironment 'T3CODE_LINK_DASHBOARD' '0') -eq '1') {
    throw 'T3CODE_LINK_DASHBOARD is not available on Windows.'
}
Copy-T3CodeWindowsDashboard -SourcePath $sourceDashboard -DestinationPath $layout.DashboardPath

$runnerFiles = @('Run-Service.ps1', 'Run-Dashboard.ps1')
foreach ($file in $runnerFiles) {
    Copy-Item -LiteralPath (Join-Path $root "windows\$file") -Destination (Join-Path $layout.ScriptDirectory $file) -Force
}

$csc = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw 'The Windows C# compiler is not available.'
}
$shimSource = Join-Path $root 'windows\CommandShim.cs'
$nativeSource = Join-Path $root 'windows\NativeCommand.ps1'
$shimVersion = (Get-FileHash -LiteralPath $shimSource -Algorithm SHA256).Hash.Substring(0, 6) +
    (Get-FileHash -LiteralPath $nativeSource -Algorithm SHA256).Hash.Substring(0, 6)
$shimDirectory = Join-Path $layout.BinDirectory $shimVersion
[IO.Directory]::CreateDirectory($shimDirectory) | Out-Null
foreach ($name in @('npm', 'pnpm', 't3')) {
    $outputPath = Join-Path $shimDirectory "$name.exe"
    if (-not (Test-Path -LiteralPath $outputPath)) {
        & $csc /nologo /target:exe "/out:$outputPath" $shimSource
        if ($LASTEXITCODE -ne 0) {
            throw "The command shim did not compile: $name.exe"
        }
    }
    Copy-Item -LiteralPath $nativeSource -Destination (Join-Path $shimDirectory "$name.ps1") -Force
}
$t3Bin = Join-Path $shimDirectory 't3.exe'
$npmBin = Join-Path $shimDirectory 'npm.exe'
$pnpmBin = Join-Path $shimDirectory 'pnpm.exe'

$pathParts = @(
    $shimDirectory,
    $npmPrefix,
    (Split-Path -Parent $node),
    (Split-Path -Parent $npm),
    (Split-Path -Parent $pnpm),
    (Split-Path -Parent $git),
    (Split-Path -Parent $tailscale),
    $env:PATH
)
$taskEnvironment = [ordered]@{
    HOME = $HOME
    PATH = ($pathParts -join ';')
    T3CODE_BIN = $t3Bin
    T3CODE_HOME = $t3Home
    NPM_BIN = $npmBin
    NPM_PREFIX = $npmPrefix
    PNPM_BIN = $pnpmBin
    T3CODE_CHANNEL = $channel
    T3CODE_DASH_HOST = $dashboardHost
    T3CODE_DASH_PORT = [string]$dashboardPort
    T3CODE_PAIR_PORT = [string]$pairPort
    T3CODE_SERVICE_MANAGER = 'scheduled-task'
    T3CODE_UNIT = "$($layout.TaskPath)$($layout.ServiceTask)"
    T3CODE_STATE_DIR = $layout.StateDirectory
    T3CODE_REPO = $repository
    T3CODE_DEV_REPO = $unitDevelopmentRepository
    T3CODE_BRANCH = $branch
    T3CODE_DEV_BRANCH = $developmentBranch
    T3CODE_HOST_REPO = $root
    T3CODE_DASH_UNIT = "$($layout.TaskPath)$($layout.DashboardTask)"
    T3CODE_INSTANCE = $instance
    T3CODE_TASK_CONFIG = $layout.ConfigPath
    T3CODE_PWSH = $pwsh
}
$config = [ordered]@{
    Instance = $instance
    AppDirectory = $layout.AppDirectory
    StateDirectory = $layout.StateDirectory
    DashboardPath = $layout.DashboardPath
    NodePath = $node
    TailscalePath = $tailscale
    T3Bin = $t3Bin
    T3CommandPath = $t3CommandPath
    NpmPath = $npm
    PnpmPath = $pnpm
    ServicePort = $servicePort
    DashboardHost = $dashboardHost
    DashboardPort = $dashboardPort
    PairPort = $pairPort
    ServiceUnit = $layout.ServiceUnit
    DashboardUnit = $layout.DashboardUnit
    ServiceTask = $layout.ServiceTask
    DashboardTask = $layout.DashboardTask
    TaskPath = $layout.TaskPath
    Environment = $taskEnvironment
}
$oldConfig = if (Test-Path -LiteralPath $layout.ConfigPath) { Get-Content -LiteralPath $layout.ConfigPath -Raw } else { '' }
$newConfig = $config | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $layout.ConfigPath -Value $newConfig -Encoding utf8 -NoNewline
$serviceDefinitionChanged = $oldConfig -ne $newConfig

$userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$serviceRunner = Join-Path $layout.ScriptDirectory 'Run-Service.ps1'
$dashboardRunner = Join-Path $layout.ScriptDirectory 'Run-Dashboard.ps1'
$serviceAction = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoLogo -NoProfile -WindowStyle Hidden -File `"$serviceRunner`" -ConfigPath `"$($layout.ConfigPath)`""
$dashboardAction = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoLogo -NoProfile -WindowStyle Hidden -File `"$dashboardRunner`" -ConfigPath `"$($layout.ConfigPath)`""
Register-ScheduledTask -TaskPath $layout.TaskPath -TaskName $layout.ServiceTask -Action $serviceAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Runs the Tailnet T3 Code service.' -Force | Out-Null
Register-ScheduledTask -TaskPath $layout.TaskPath -TaskName $layout.DashboardTask -Action $dashboardAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Runs the T3 Code dashboard.' -Force | Out-Null

if ($skipBuild -or $buildCurrent -or -not $buildMade) {
    Write-Host 'T3 Code is unchanged. Restarting the dashboard only.'
    Restart-T3CodeTask -TaskPath $layout.TaskPath -TaskName $layout.DashboardTask
    $serviceTask = Get-ScheduledTask -TaskPath $layout.TaskPath -TaskName $layout.ServiceTask
    if ($serviceTask.State -ne 'Running') {
        Start-ScheduledTask -TaskPath $layout.TaskPath -TaskName $layout.ServiceTask
    } elseif ($serviceDefinitionChanged) {
        Write-Host "Note: $($layout.ServiceTask) changed. Restart it when you can stop the sessions."
    }
} else {
    Restart-T3CodeTask -TaskPath $layout.TaskPath -TaskName $layout.ServiceTask
    Restart-T3CodeTask -TaskPath $layout.TaskPath -TaskName $layout.DashboardTask
    Copy-Item -LiteralPath (Join-Path $layout.StateDirectory 'built-sha') -Destination (Join-Path $layout.StateDirectory 'deployed-sha') -Force
}

$hostAddress = Get-T3CodeTailnetAddress -TailscalePath $tailscale
if (-not $hostAddress) {
    throw 'No Tailscale IPv4 address is available.'
}
if ((Get-T3CodeEnvironment 'T3CODE_SKIP_SERVE' '0') -eq '1') {
    Write-Host 'Skipping the Tailscale Serve mapping.'
} else {
    Invoke-T3CodeNative $tailscale serve --bg "--https=$pairPort" "http://${dashboardHost}:$dashboardPort"
    # The development console needs an HTTPS origin of its own. Only developer
    # mode has that second console, so only it takes the second port.
    if ($devMode) {
        $devSite = Get-T3CodeServeSite -TailscalePath $tailscale -Port $devServePort
        if (-not $devSite -or $devSite.Target -match ":$devConsolePort$") {
            try {
                Invoke-T3CodeNative $tailscale serve --bg "--https=$devServePort" "http://${dashboardHost}:$devConsolePort"
            } catch {
                Write-Warning "Tailscale Serve did not publish the development console on port $devServePort."
            }
        } else {
            Write-Warning "Tailscale Serve port $devServePort already proxies to $($devSite.Target)."
        }
    }
}

$publishedSite = Get-T3CodeServeSite -TailscalePath $tailscale -Port $pairPort
if ($publishedSite) {
    Write-Host "Dashboard ($instance): $($publishedSite.Url)"
    Write-Host "Dashboard address: http://${dashboardHost}:$dashboardPort"
} else {
    Write-Host "Dashboard ($instance): http://${dashboardHost}:$dashboardPort"
}
Write-Host "T3 Code ($instance): http://${hostAddress}:$servicePort"
