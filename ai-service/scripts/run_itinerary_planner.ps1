$ErrorActionPreference = "Stop"

$serviceRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $serviceRoot "app\services\itinerary\planner.py"

$candidates = @(
    (Join-Path $projectRoot ".venv\Scripts\python.exe"),
    "python",
    "py",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\VC\SecurityIssueAnalysis\python\python.exe"
)

$python = $null
foreach ($candidate in $candidates) {
    if ($candidate -eq "python" -or $candidate -eq "py") {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) {
            $python = $cmd.Source
            break
        }
    } elseif (Test-Path $candidate) {
        $python = $candidate
        break
    }
}

if (-not $python) {
    throw "Python not found. Install Python from python.org and enable 'Add python.exe to PATH'."
}

& $python -X utf8 $scriptPath @args
exit $LASTEXITCODE
