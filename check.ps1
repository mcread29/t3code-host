[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'lib\Guard.ps1')
. (Join-Path $root 'lib\Windows.ps1')

$instance = Get-T3CodeEnvironment 'T3CODE_INSTANCE' 'production'
Test-T3CodeInstanceName $instance
$layout = Get-T3CodeLayout $instance
if ($instance -eq 'production') {
    $servicePort = [int](Get-T3CodeEnvironment 'T3CODE_PORT' '4123')
    $dashboardPort = [int](Get-T3CodeEnvironment 'T3CODE_DASH_PORT' '4124')
    $pairPort = [int](Get-T3CodeEnvironment 'T3CODE_PAIR_PORT' '443')
} else {
    $servicePort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_PORT' '5123')
    $dashboardPort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_DASH_PORT' '5124')
    $pairPort = [int](Get-T3CodeEnvironment 'T3CODE_TEST_PAIR_PORT' '8446')
}
$tailscale = Get-T3CodeCommandPath @('tailscale.exe')
$git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$hostAddress = Get-T3CodeTailnetAddress -TailscalePath $tailscale
if (-not $hostAddress) {
    throw 'No Tailscale IPv4 address is available.'
}
$dashboardHost = Get-T3CodeEnvironment 'T3CODE_DASH_HOST' ''
if (-not $dashboardHost -and (Test-Path -LiteralPath $layout.ConfigPath)) {
    $savedConfig = Get-Content -LiteralPath $layout.ConfigPath -Raw | ConvertFrom-Json
    $dashboardHost = $savedConfig.Environment.T3CODE_DASH_HOST
}
if (-not $dashboardHost) {
    $dashboardHost = $hostAddress
}
$baseUrl = "http://${dashboardHost}:$dashboardPort"

$script:passed = 0
$script:failed = 0
$script:skipped = 0
function Add-Pass([string]$Text) { Write-Host "  ok    $Text"; $script:passed++ }
function Add-Failure([string]$Text) { Write-Host "  FAIL  $Text"; $script:failed++ }
function Add-Skip([string]$Text) { Write-Host "  --    $Text"; $script:skipped++ }
function Add-Section([string]$Text) { Write-Host "`n$Text" }
function Test-Expected([string]$Name, $Value, $Expected) {
    if ($Value -eq $Expected) { Add-Pass "$Name ($Value)" } else { Add-Failure "$Name returned '$Value'. Expected '$Expected'." }
}

$handler = [Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(10)
function Get-WebResult {
    param([Parameter(Mandatory)][string]$Url, [hashtable]$Header = @{})
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Url)
    foreach ($item in $Header.GetEnumerator()) {
        $request.Headers.TryAddWithoutValidation($item.Key, [string]$item.Value) | Out-Null
    }
    try {
        $response = $client.Send($request)
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $body }
    } catch {
        return [pscustomobject]@{ Status = 0; Body = '' }
    } finally {
        $request.Dispose()
    }
}

Write-Host "Checking $instance at $baseUrl"
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ((Get-WebResult "$baseUrl/").Status -ne 0) { break }
    Start-Sleep -Seconds 1
}
$statusResult = Get-WebResult "$baseUrl/_dash/status"
$managed = $true
if ($statusResult.Body -match '"managed"\s*:\s*false') {
    $managed = $false
    Write-Host '  The development servers do not use tasks or an installed build.'
}
if ($managed) {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ((Get-WebResult "http://${hostAddress}:$servicePort/").Status -ne 0) { break }
        Start-Sleep -Seconds 1
    }
}

Add-Section 'services'
if (-not $managed) {
    Add-Skip 'The development servers do not use scheduled tasks.'
} else {
    foreach ($name in @($layout.ServiceTask, $layout.DashboardTask)) {
        $task = Get-ScheduledTask -TaskPath $layout.TaskPath -TaskName $name -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq 'Running') { Add-Pass "$name is running" } else { Add-Failure "$name is not running" }
        if ($task -and $task.Principal.RunLevel -eq 'Limited' -and $task.Principal.LogonType -in @('Interactive', 'InteractiveToken')) {
            Add-Pass "$name uses a limited interactive token"
        } else {
            Add-Failure "$name does not use a limited interactive token"
        }
        $restartCount = if ($task) { $task.Settings.RestartCount } else { 0 }
        if ($restartCount -gt 0) { Add-Pass "$name restarts after a failure" } else { Add-Failure "$name does not restart after a failure" }
    }
}

Add-Section 'bindings'
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
$targets = @([pscustomobject]@{ Name = 'dashboard'; Address = $dashboardHost; Port = $dashboardPort })
if ($managed) {
    $targets = @([pscustomobject]@{ Name = 'T3 Code'; Address = $hostAddress; Port = $servicePort }) + $targets
}
foreach ($target in $targets) {
    $matches = @($listeners | Where-Object { $_.LocalPort -eq $target.Port })
    if ($matches.LocalAddress -contains $target.Address) {
        Add-Pass "$($target.Name) listens on $($target.Address):$($target.Port)"
    } else {
        Add-Failure "$($target.Name) does not listen on $($target.Address):$($target.Port)."
    }
}

Add-Section 'dashboard'
$legacy = $statusResult.Status -ne 200 -and (Get-WebResult "$baseUrl/api/status").Status -eq 200
if ($legacy) {
    Add-Failure 'The old dashboard is running. Reinstall this instance.'
    Add-Skip 'The routing checks do not apply to the old dashboard.'
} else {
    $page = Get-WebResult "$baseUrl/" @{ 'Sec-Fetch-Dest' = 'document' }
    if ($page.Body -match 'class="app"') { Add-Pass 'A document request serves the dashboard.' } else { Add-Failure 'A document request does not serve the dashboard.' }
    $framed = Get-WebResult "$baseUrl/" @{ 'Sec-Fetch-Dest' = 'iframe' }
    if ($framed.Body -match '<html lang="en"|name="t3code-stub"') { Add-Pass 'A frame request serves T3 Code.' } else { Add-Failure 'A frame request does not serve T3 Code.' }
    $embedded = Get-WebResult "$baseUrl/?embed=1"
    if ($embedded.Body -match '<html lang="en"|name="t3code-stub"') { Add-Pass 'The embed query serves T3 Code.' } else { Add-Failure 'The embed query does not serve T3 Code.' }
    $dashboard = Get-WebResult "$baseUrl/dashboard"
    if ($dashboard.Body -match 'class="app"') { Add-Pass 'The dashboard path serves the dashboard.' } else { Add-Failure 'The dashboard path does not serve the dashboard.' }
    $plain = Get-WebResult "$baseUrl/"
    if ($plain.Body -match '<html lang="en"|name="t3code-stub"') { Add-Pass 'An API request serves T3 Code.' } else { Add-Failure 'An API request does not serve T3 Code.' }
    if ($statusResult.Status -eq 200 -and $statusResult.Body -match '"unit"') { Add-Pass 'The status route returns the service state.' } else { Add-Failure 'The status route does not return the service state.' }
}

Add-Section 'T3 proxy'
if ($managed) {
    Test-Expected "T3 Code direct on $servicePort" (Get-WebResult "http://${hostAddress}:$servicePort/").Status 200
} else {
    $probe = Get-WebResult "$baseUrl/" @{ 'Sec-Fetch-Dest' = 'iframe' }
    if ($probe.Body -match '@vite/client') { Add-Pass 'The proxy uses the development server.' }
    elseif ($probe.Body -match 'name="t3code-stub"') { Add-Pass 'The proxy uses the T3 Code stub.' }
    else { Add-Failure 'The proxy does not use the development server or the stub.' }
}
if (-not $legacy) {
    $webSocket = Get-WebResult "$baseUrl/ws"
    if ($webSocket.Status -in @(200, 400)) { Add-Pass "The WebSocket route is authorized. HTTP $($webSocket.Status)." }
    elseif ($webSocket.Status -eq 401) { Add-Failure 'The WebSocket route has no authorized session.' }
    else { Add-Failure "The WebSocket route returned HTTP $($webSocket.Status)." }
}

Add-Section 'Tailscale Serve'
$serveSite = Get-T3CodeServeSite -TailscalePath $tailscale -Port $pairPort
if (-not $serveSite) {
    Add-Skip "No mapping uses HTTPS port $pairPort."
} elseif ($serveSite.Target -eq "http://${dashboardHost}:$dashboardPort") {
    Add-Pass "$($serveSite.Url) proxies the dashboard"
    Test-Expected 'The published URL answers' (Get-WebResult "$($serveSite.Url)/").Status 200
} elseif ($serveSite.Target -eq "http://${hostAddress}:$servicePort") {
    Add-Failure 'Tailscale Serve still proxies T3 Code directly.'
} else {
    Add-Failure "Tailscale Serve proxies an unrelated target: $($serveSite.Target)"
}

Add-Section 'isolation'
if ($instance -eq 'production') {
    Add-Skip 'The isolation checks apply only to secondary instances.'
} elseif (-not $managed) {
    Add-Skip 'The development servers do not have a task environment.'
} elseif (-not (Test-Path -LiteralPath $layout.ConfigPath)) {
    Add-Failure 'The task configuration does not exist.'
} else {
    $config = Get-Content -LiteralPath $layout.ConfigPath -Raw | ConvertFrom-Json
    $productionHome = (Get-T3CodeLayout 'production').T3Home
    if ($config.Environment.T3CODE_HOME -eq $productionHome) { Add-Failure 'This instance shares the production data directory.' }
    else { Add-Pass 'This instance has a separate data directory.' }
    if ($serveSite) { Add-Failure 'This instance uses the shared MagicDNS host. Disable its Serve mapping.' }
    else { Add-Pass 'This instance does not use the shared MagicDNS host.' }
}

Add-Section 'freshness'
if (-not $managed) {
    Add-Skip 'The development servers reload after a save.'
} else {
    if (Test-Path -LiteralPath $layout.DashboardPath) { Add-Pass "The dashboard exists at $($layout.DashboardPath)." }
    else { Add-Failure "No dashboard exists at $($layout.DashboardPath)." }
    $taskInfo = Get-ScheduledTaskInfo -TaskPath $layout.TaskPath -TaskName $layout.DashboardTask -ErrorAction SilentlyContinue
    if ($taskInfo -and (Test-Path -LiteralPath $layout.DashboardPath)) {
        $sourceTime = (Get-Item -LiteralPath $layout.DashboardPath).LastWriteTime
        if ($sourceTime -gt $taskInfo.LastRunTime) { Add-Failure 'The dashboard file is newer than the running task.' }
        else { Add-Pass 'The running dashboard uses the current file.' }
    } else {
        Add-Skip 'The dashboard file time cannot be compared.'
    }

    $repository = Get-T3CodeEnvironment 'T3CODE_REPO' $layout.Repository
    if ($git -and (Test-Path -LiteralPath (Join-Path $repository '.git'))) {
        $headSha = (& $git.Source -C $repository rev-parse --short HEAD | Select-Object -First 1).Trim()
        $builtPath = Join-Path $layout.StateDirectory 'built-sha'
        $builtSha = if (Test-Path -LiteralPath $builtPath) { (Get-Content -LiteralPath $builtPath -Raw).Trim() } else { '' }
        if (-not $builtSha) { Add-Skip 'No build revision is recorded.' }
        elseif ($headSha -eq $builtSha) { Add-Pass "The deployed build matches $headSha." }
        else { Add-Failure "The build is $builtSha. The worktree is $headSha." }
    } else {
        Add-Skip "No source checkout exists at $repository."
    }
}

$client.Dispose()
$handler.Dispose()
Write-Host "`n$script:passed passed, $script:failed failed, $script:skipped skipped"
if ($script:failed -gt 0) { exit 1 }
