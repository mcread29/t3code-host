[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'lib\Guard.ps1')
. (Join-Path $root 'lib\Windows.ps1')

$instance = Get-T3CodeEnvironment 'T3CODE_INSTANCE' 'production'
Test-T3CodeInstanceName $instance
Protect-T3CodeInstance $instance 'update'
$layout = Get-T3CodeLayout $instance
$repository = Get-T3CodeEnvironment 'T3CODE_REPO' $layout.Repository
$developmentRepository = Get-T3CodeEnvironment 'T3CODE_DEV_REPO' $layout.DevelopmentRepository
$branch = Get-T3CodeEnvironment 'T3CODE_BRANCH' 'deploy'
$developmentBranch = Get-T3CodeEnvironment 'T3CODE_DEV_BRANCH' 'dev'
$git = Get-T3CodeCommandPath @('git.exe')

if (-not (Test-Path -LiteralPath (Join-Path $repository '.git'))) {
    throw "No managed deployment checkout exists at $repository. Run install.ps1 first."
}
$checkedOut = (& $git -C $repository rev-parse --abbrev-ref HEAD | Select-Object -First 1).Trim()
if ($checkedOut -ne $branch) {
    throw "The deployment worktree must use $branch. It uses $checkedOut."
}
$dirty = (& $git -C $repository status --porcelain | Out-String).Trim()
if ($dirty) {
    throw "The deployment worktree is not clean: $repository"
}

Write-Host 'Fetching the fork and upstream.'
Invoke-T3CodeNative $git -C $repository fetch --prune --multiple origin upstream
& $git -C $repository merge-base --is-ancestor main upstream/main
if ($LASTEXITCODE -ne 0) {
    throw 'Local main cannot move forward to upstream main. Inspect it manually.'
}
& $git -C $repository merge-tree --write-tree $branch upstream/main *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Upstream conflicts with $branch. Merge it manually in $developmentRepository."
}

Write-Host 'Updating main from upstream.'
Invoke-T3CodeNative $git -C $repository branch -f main upstream/main
Invoke-T3CodeNative $git -C $repository push origin main

Write-Host "Merging main into $branch."
& $git -C $repository merge --no-ff --no-edit main
if ($LASTEXITCODE -ne 0) {
    & $git -C $repository merge --abort *> $null
    throw 'The merge changed while it ran. Git aborted the merge.'
}

Write-Host "Rebuilding and restarting $instance."
$oldYes = $env:T3CODE_YES
try {
    $env:T3CODE_YES = '1'
    $env:T3CODE_INSTANCE = $instance
    $env:T3CODE_REPO = $repository
    $env:T3CODE_DEV_REPO = $developmentRepository
    $env:T3CODE_BRANCH = $branch
    $env:T3CODE_DEV_BRANCH = $developmentBranch
    & (Join-Path $root 'install.ps1')
    if ($LASTEXITCODE -ne 0) {
        throw 'The install command failed.'
    }
} finally {
    $env:T3CODE_YES = $oldYes
}

$expectedSha = (& $git -C $repository rev-parse --short HEAD | Select-Object -First 1).Trim()
$builtPath = Join-Path $layout.StateDirectory 'built-sha'
$builtSha = if (Test-Path -LiteralPath $builtPath) { (Get-Content -LiteralPath $builtPath -Raw).Trim() } else { '' }
if ($builtSha -ne $expectedSha) {
    throw "The source build did not deploy $expectedSha. The branch is not pushed."
}
Invoke-T3CodeNative $git -C $repository push origin $branch
Write-Host "Updated, rebuilt, and restarted $instance at $expectedSha."
