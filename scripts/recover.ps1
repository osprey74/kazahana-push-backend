<#
.SYNOPSIS
    PowerShell wrapper for recover.sh.

.DESCRIPTION
    Thin wrapper so the recovery script can be invoked from PowerShell
    on Windows. The real logic lives in scripts/recover.sh; this script
    locates a usable bash and forwards all arguments + exit code.

    Git Bash (Git\bin\bash.exe, the launcher that sets up the MSYS PATH)
    is preferred so coreutils like awk/grep are available. Falls back
    to whatever 'bash' is in PATH.

    See recover.sh --help for the recovery procedure and incident notes.

.EXAMPLE
    .\recover.ps1
    .\recover.ps1 --dry-run
    .\recover.ps1 --yes
    .\recover.ps1 --help
#>

$ErrorActionPreference = 'Stop'

$gitBashCandidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe',
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
)

$bashExe = $gitBashCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $bashExe) {
    $cmd = Get-Command bash -ErrorAction SilentlyContinue
    if ($cmd) { $bashExe = $cmd.Source }
}

if (-not $bashExe) {
    Write-Error "bash not found. Install Git for Windows, or put a bash on PATH."
    exit 1
}

$script = Join-Path $PSScriptRoot 'recover.sh'
if (-not (Test-Path $script)) {
    Write-Error "recover.sh not found at: $script"
    exit 1
}

& $bashExe $script @args
exit $LASTEXITCODE
