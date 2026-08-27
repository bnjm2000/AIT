$ErrorActionPreference = 'Stop'

$appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $appDirectory '.venv\Scripts\python.exe'
$supervisor = Join-Path $appDirectory 'server_supervisor.py'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Virtual-environment Python was not found at $python"
}
if (-not (Test-Path -LiteralPath $supervisor)) {
    throw "Server supervisor was not found at $supervisor"
}

& $python $supervisor
