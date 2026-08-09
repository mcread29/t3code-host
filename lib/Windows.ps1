Set-StrictMode -Version Latest

function Get-T3CodeEnvironment {
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowEmptyString()][string]$Default = ''
    )

    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ($null -eq $value) {
        return $Default
    }
    return $value
}

function Get-T3CodeLayout {
    param([Parameter(Mandatory)][string]$Instance)

    $suffix = if ($Instance -eq 'production') { '' } else { "-$Instance" }
    $appName = "T3CodeHost$suffix"
    $appDirectory = Join-Path $env:LOCALAPPDATA $appName
    [pscustomobject]@{
        Instance = $Instance
        Suffix = $suffix
        AppName = $appName
        AppDirectory = $appDirectory
        StateDirectory = Join-Path $appDirectory 'state'
        ScriptDirectory = Join-Path $appDirectory 'scripts'
        BinDirectory = Join-Path $appDirectory 'bin'
        NpmPrefix = Join-Path $appDirectory 'npm'
        T3Home = Join-Path $appDirectory 'data'
        Repository = Join-Path $appDirectory 'src'
        DevelopmentRepository = Join-Path $appDirectory 'dev'
        ConfigPath = Join-Path $appDirectory 'task-config.json'
        DashboardPath = Join-Path $appDirectory 't3code-dashboard.mjs'
        ServiceUnit = "t3code$suffix.service"
        DashboardUnit = "t3code-dashboard$suffix.service"
        ServiceTask = "T3CodeHost-t3code$suffix"
        DashboardTask = "T3CodeHost-t3code-dashboard$suffix"
        TaskPath = '\'
    }
}

function Get-T3CodeCommandPath {
    param([Parameter(Mandatory)][string[]]$Name)

    foreach ($candidate in $Name) {
        $command = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            return $command.Source
        }
    }
    throw "Missing required command: $($Name[0])"
}

function Invoke-T3CodeNative {
    param([string]$FilePath)

    $ArgumentList = $args
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE."
    }
}

function Get-T3CodeTailnetAddress {
    param([Parameter(Mandatory)][string]$TailscalePath)

    $output = & $TailscalePath ip -4 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return @($output | Where-Object { $_ })[0]
}

function Test-T3CodeDashboardSource {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$SourcePath
    )

    Invoke-T3CodeNative $NodePath --check $SourcePath
    $browserCheck = @'
const fs = require("node:fs")
const text = fs.readFileSync(process.argv[1], "utf8")
const open = text.indexOf("<script>")
const close = text.indexOf("</" + "script>")
if (open < 0 || close < 0) throw new Error("cannot find the browser script")
const script = text.slice(open + 8, close).replaceAll("__TOKEN__", "x")
new (require("node:vm").Script)(script, { filename: "dashboard page script" })
'@
    Invoke-T3CodeNative $NodePath -e $browserCheck $SourcePath
}

function Copy-T3CodeWindowsDashboard {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$DestinationPath
    )

    $directory = Split-Path -Parent $DestinationPath
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporaryPath = "$DestinationPath.new"
    Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath -Force
    Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
}

function Get-T3CodeServeSite {
    param(
        [Parameter(Mandatory)][string]$TailscalePath,
        [Parameter(Mandatory)][int]$Port
    )

    $text = & $TailscalePath serve status --json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $text) {
        return $null
    }
    try {
        $status = $text | ConvertFrom-Json -AsHashtable
    } catch {
        return $null
    }
    if (-not $status.ContainsKey('Web')) {
        return $null
    }

    foreach ($entry in $status.Web.GetEnumerator()) {
        $sitePort = if ($entry.Key -match ':(\d+)$') { [int]$Matches[1] } else { 443 }
        if ($sitePort -ne $Port) {
            continue
        }
        foreach ($handler in $entry.Value.Handlers.Values) {
            if ($handler.Proxy) {
                return [pscustomobject]@{ Url = "https://$($entry.Key)"; Target = $handler.Proxy }
            }
        }
    }
    return $null
}

function Restart-T3CodeTask {
    param(
        [Parameter(Mandatory)][string]$TaskPath,
        [Parameter(Mandatory)][string]$TaskName
    )

    $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        Start-Sleep -Milliseconds 500
    }
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
}
