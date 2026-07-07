$ErrorActionPreference = 'Stop'

$appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDirectory = Join-Path $appDirectory 'logs'
$logFile = Join-Path $logDirectory 'showbase_startup.log'
$python = Join-Path $appDirectory '.venv\Scripts\python.exe'

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $python)) {
    throw "Virtual-environment Python was not found at $python"
}

$env:APP_ENV = if ($env:APP_ENV) { $env:APP_ENV } else { 'production' }
$env:ENABLE_HTTPS = if ($env:ENABLE_HTTPS) { $env:ENABLE_HTTPS } else { '0' }
$env:PORT = if ($env:PORT) { $env:PORT } else { '5055' }
$env:SERVER_BACKEND = if ($env:SERVER_BACKEND) { $env:SERVER_BACKEND } else { 'waitress' }

Add-Content -LiteralPath $logFile -Value ('=' * 40)
Add-Content -LiteralPath $logFile -Value "Starting Showbase: $(Get-Date -Format o)"

& $python (Join-Path $appDirectory 'main.py') *>> $logFile
