# Đăng ký Windows Task Scheduler chạy retrain pipeline 02:00 mỗi ngày.
# Chạy PowerShell với quyền Administrator:
#   powershell -ExecutionPolicy Bypass -File register_task.ps1
# Tùy chọn:
#   -Time "03:30"          giờ chạy khác
#   -PythonExe "C:\...\python.exe"   python cụ thể (mặc định: python trong PATH)
#   -Unregister            gỡ task

param(
    [string]$Time = "02:00",
    [string]$PythonExe = "",
    [switch]$Unregister
)

$TaskName = "GPTravel-Recommender-Retrain"
$RetrainDir = $PSScriptRoot

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Đã gỡ task '$TaskName'."
    exit 0
}

if (-not $PythonExe) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Error "Không tìm thấy python trong PATH — truyền -PythonExe."; exit 1 }
    $PythonExe = $cmd.Source
}

$Action = New-ScheduledTaskAction `
    -Execute $PythonExe `
    -Argument "retrain_pipeline.py" `
    -WorkingDirectory $RetrainDir

$Trigger = New-ScheduledTaskTrigger -Daily -At $Time

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Retrain hybrid recommender khi có địa điểm/review mới (GP Travel Advisor)" `
    -Force

Write-Host "Đã đăng ký task '$TaskName' chạy $Time hàng ngày."
Write-Host "Python : $PythonExe"
Write-Host "Thư mục: $RetrainDir"
Write-Host "Log    : $RetrainDir\logs\"
