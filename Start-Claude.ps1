param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$command = Get-Command claude -ErrorAction SilentlyContinue
$claudePath = if ($command) { $command.Source } else { Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
if (-not $claudePath -or -not (Test-Path -LiteralPath $claudePath -PathType Leaf)) {
    throw 'Install Claude Code first: https://code.claude.com/docs/en/setup'
}
Push-Location -LiteralPath $projectRoot
try {
    if ($CheckOnly) {
        & $claudePath --version
        if ($LASTEXITCODE -ne 0) { throw 'Claude Code version check failed' }
        Write-Output "Project: $projectRoot"
        Write-Output 'Instructions: CLAUDE.md'
    } else {
        & $claudePath
        if ($LASTEXITCODE -ne 0) { throw "Claude Code exit code: $LASTEXITCODE" }
    }
} finally { Pop-Location }
