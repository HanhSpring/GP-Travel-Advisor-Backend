$ErrorActionPreference = "Stop"

$Port = 8050
$BackendRoot = Split-Path -Parent $PSScriptRoot
$AiServiceDir = Join-Path $BackendRoot "ai-service"
$LogPath = "E:\DATN\ai-service-restart.log"

Write-Host "Restarting AI service on port $Port..."

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$pids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)

foreach ($pidToStop in $pids) {
    if ($pidToStop -and $pidToStop -ne 0) {
        Write-Host "Stopping process $pidToStop on port $Port..."
        Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 2

$command = "Set-Location '$AiServiceDir'; python -m uvicorn app.main:app --host 127.0.0.1 --port $Port *> '$LogPath'"
$process = Start-Process -FilePath powershell.exe `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -WindowStyle Hidden `
    -PassThru

Write-Host "AI service start command launched. Wrapper PID: $($process.Id)"
Write-Host "Log: $LogPath"
Write-Host "Health check after startup: http://127.0.0.1:$Port/health"
