param(
  [string]$ApiUrl = "http://localhost:3000",
  [int]$TopK = 120,
  [string]$UserId = "5f56692b-8daa-4852-bfe7-1032a07635ff",
  [string]$TripType = "ROUND_TRIP",
  [string]$DepartureLocationId = "SGN",
  [string]$DestinationLocationId = "3b9a22b3-293b-5313-97c5-d9b71c30756f",
  [string]$TransportMode = "ROAD",
  [string]$StartDate = "2026-06-10",
  [string]$EndDate = "2026-06-15",
  [string]$DailyStartTime = "07:00",
  [string]$DailyEndTime = "22:00",
  [string]$TripIntent = "Van hoa & Lich su",
  [int]$AdultCount = 2,
  [int]$ChildCount = 0,
  [int]$Budget = 5000000,
  [string]$OutDir = ".\tmp-run-logs"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function ConvertTo-SafeFileName([string]$Value) {
  $normalized = $Value.Normalize([Text.NormalizationForm]::FormD)
  $withoutMarks = [Text.RegularExpressions.Regex]::Replace($normalized, "\p{Mn}", "")
  $safe = [Text.RegularExpressions.Regex]::Replace($withoutMarks, "[^a-zA-Z0-9]+", "-")
  $safe = $safe.Trim("-").ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($safe)) { return "unknown" }
  return $safe
}

function Format-Minutes([object]$Value) {
  if ($null -eq $Value) { return "-" }
  $minutes = [int][double]$Value
  $hours = [math]::Floor($minutes / 60)
  $remain = $minutes % 60
  if ($hours -gt 0) { return "${hours}h${remain}m" }
  return "${remain}m"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$bodyObject = [ordered]@{
  userId = $UserId
  tripType = $TripType
  departureLocationId = $DepartureLocationId
  destinationLocationId = $DestinationLocationId
  transportMode = $TransportMode
  startDate = $StartDate
  endDate = $EndDate
  dailyStartTime = $DailyStartTime
  dailyEndTime = $DailyEndTime
  tripIntent = $TripIntent
  adultCount = $AdultCount
  childCount = $ChildCount
  budget = $Budget
  foodPreferences = @()
  customFoodPreferences = @()
}

$body = $bodyObject | ConvertTo-Json -Depth 10
$uri = "$ApiUrl/itinerary/plan/preview?top_k=$TopK"

Write-Host ""
Write-Host "Running itinerary preview..."
Write-Host "POST $uri"
Write-Host "Intent: $TripIntent | Dates: $StartDate -> $EndDate | Time: $DailyStartTime-$DailyEndTime"

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$response = Invoke-RestMethod `
  -Method Post `
  -Uri $uri `
  -ContentType "application/json; charset=utf-8" `
  -Body $body
$stopwatch.Stop()

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$intentSlug = ConvertTo-SafeFileName $TripIntent
$fullResponsePath = Join-Path $OutDir "$timestamp-preview-response-$intentSlug.json"
$response | ConvertTo-Json -Depth 30 | Set-Content $fullResponsePath -Encoding utf8

$debugPath = ".\api-service\logs\itinerary-plan-debug\latest.json"
$debug = $null
if (Test-Path $debugPath) {
  $debug = Get-Content $debugPath -Raw -Encoding utf8 | ConvertFrom-Json
}

$plan = $response.plan
if ($null -eq $plan -and $null -ne $response.days) {
  $plan = $response
}

Write-Host ""
Write-Host "Saved full response:"
Write-Host "  $fullResponsePath"
if ($debug) {
  Write-Host "Saved backend debug:"
  Write-Host "  $debugPath"
}

Write-Host ""
Write-Host "=== RUN METRICS ==="
if ($debug) {
  [pscustomobject]@{
    Destination = $debug.request.destinationName
    Intent = $debug.request.tripIntent
    Days = $debug.request.numDays
    TopK = $debug.request.topK
    TwoTowerCandidates = $debug.counts.twoTowerCandidates
    PlannerInput = $debug.counts.plannerInputPlaces
    Visited = $debug.counts.aiTotalVisited
    TwoTower = Format-Minutes $debug.timingsMs.twoTower
    GoongMatrix = Format-Minutes $debug.timingsMs.goongMatrix
    GA = Format-Minutes $debug.timingsMs.ga
    AI = Format-Minutes $debug.timingsMs.aiTotal
    Backend = Format-Minutes $debug.timingsMs.backendTotal
    Client = Format-Minutes $stopwatch.Elapsed.TotalMinutes
  } | Format-List

  Write-Host "=== TWO-TOWER CATEGORY COUNT ==="
  $debug.counts.twoTowerByCategory.PSObject.Properties |
    Sort-Object Name |
    ForEach-Object { [pscustomobject]@{ Category = $_.Name; Count = $_.Value } } |
    Format-Table -AutoSize

  Write-Host "=== PLANNER PLACE TYPE COUNT ==="
  $debug.counts.plannerByPlaceType.PSObject.Properties |
    Sort-Object Name |
    ForEach-Object { [pscustomobject]@{ Type = $_.Name; Count = $_.Value } } |
    Format-Table -AutoSize
} else {
  [pscustomobject]@{
    TopK = $TopK
    Visited = $plan.total_visited
    InputPlaces = $plan.input_places
    TotalMs = $response.executionTimeMs
    ClientMs = [int]$stopwatch.ElapsedMilliseconds
  } | Format-List
}

Write-Host "=== HOTEL ==="
[pscustomobject]@{
  HotelId = $plan.hotel_id
  HotelName = $plan.hotel_name
} | Format-List

Write-Host "=== DAY SUMMARY ==="
$days = @($plan.days)
$days |
  ForEach-Object {
    [pscustomobject]@{
      Day = $_.day
      Visited = $_.visited_count
      Restaurants = $_.restaurant_count
      Travel = Format-Minutes $_.total_travel_minutes
      Visit = Format-Minutes $_.total_visit_minutes
      Wait = Format-Minutes $_.total_wait_minutes
      DistanceKm = $_.total_distance_km
      Fitness = $_.fitness
      Stop = $_.stopped_reason
    }
  } |
  Format-Table -AutoSize

Write-Host "=== DETAIL SCHEDULE ==="
foreach ($day in $days) {
  Write-Host ""
  Write-Host "DAY $($day.day)"
  $schedule = @($day.schedule)
  if ($schedule.Count -eq 0) {
    Write-Host "  No activities"
    continue
  }

  $schedule |
    ForEach-Object {
      $type = "attraction"
      if ($_.is_return_to_hotel -eq $true) { $type = "return" }
      elseif ($_.is_restaurant -eq $true) { $type = "restaurant" }
      elseif ($_.place_type) { $type = $_.place_type }

      [pscustomobject]@{
        Time = "$($_.arrival_time)-$($_.departure_time)"
        Type = $type
        Place = $_.location_name
        From = $_.travel_from_name
        Move = Format-Minutes $_.travel_minutes
        Stay = Format-Minutes $_.active_duration_minutes
        Wait = Format-Minutes $_.wait_minutes
        Km = $_.distance_km
      }
    } |
    Format-Table -AutoSize -Wrap
}
