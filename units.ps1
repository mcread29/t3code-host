[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:T3CODE_SKIP_BUILD = '1'
& (Join-Path $PSScriptRoot 'install.ps1')
exit $LASTEXITCODE
