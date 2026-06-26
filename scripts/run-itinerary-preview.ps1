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
  [string]$TripIntent = "Kham pha tong hop",
  [int]$AdultCount = 2,
  [int]$ChildCount = 0,
  [int]$Budget = 5000000,
  [string]$OutDir = ".\tmp-run-logs",
  [int]$CandidatePreviewLimit = 20,
  [ValidateSet("ga_v1", "scheduler_v2", "compare")]
  [string]$Engine = "ga_v1",
  [switch]$ShowDetails
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

function Format-Milliseconds([object]$Value) {
  if ($null -eq $Value) { return "-" }
  $ms = [double]$Value
  if ($ms -ge 1000) { return "$([math]::Round($ms / 1000, 2))s" }
  return "$([int]$ms)ms"
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
$uri = "$ApiUrl/itinerary/plan/preview?top_k=$TopK&engine=$Engine"

Write-Host ""
Write-Host "Running itinerary preview..."
Write-Host "POST $uri"
Write-Host "Intent: $TripIntent | Dates: $StartDate -> $EndDate | Time: $DailyStartTime-$DailyEndTime | Engine: $Engine"

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

$debugPath = ".\api-service\logs\itinerary-plan-debug\json\latest.json"
$debug = $null
if (Test-Path $debugPath) {
  $debug = Get-Content $debugPath -Raw -Encoding utf8 | ConvertFrom-Json
}

$plan = $response.plan
if ($null -eq $plan -and $null -ne $response.days) {
  $plan = $response
}

if ($plan.comparison -and $plan.comparison.engines) {
  Write-Host ""
  Write-Host "=== ENGINE COMPARISON ==="
  $plan.comparison.engines.PSObject.Properties |
    Sort-Object Name |
    ForEach-Object {
      $summary = $_.Value
      [pscustomobject]@{
        Engine = $_.Name
        Time = Format-Milliseconds $summary.elapsed_ms
        Visited = $summary.total_visited
        Travel = Format-Minutes $summary.total_travel_minutes
        Wait = Format-Minutes $summary.total_wait_minutes
        Km = $summary.total_distance_km
        Cost = $summary.total_cost
        Feasible = $summary.validation.is_feasible
      }
    } |
    Format-Table -AutoSize
  Write-Host "Winner hint: $($plan.comparison.winner_hint)"

  foreach ($engineName in @("ga_v1", "scheduler_v2")) {
    $engineSummary = $plan.comparison.engines.$engineName
    if ($null -eq $engineSummary) { continue }
    Write-Host ""
    Write-Host "=== $engineName DAY COMPARISON ==="
    @($engineSummary.days) |
      ForEach-Object {
        [pscustomobject]@{
          Day = $_.day
          Candidates = $_.candidates
          Visited = $_.visited
          Restaurant = $_.restaurants
          Travel = Format-Minutes $_.travel_minutes
          Visit = Format-Minutes $_.visit_minutes
          Wait = Format-Minutes $_.wait_minutes
          Idle = Format-Minutes $_.idle_minutes
          Km = $_.distance_km
          Cost = $_.day_cost
          Fitness = $_.fitness
          Stop = $_.stopped_reason
        }
      } |
      Format-Table -AutoSize
  }
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
    TwoTower = Format-Milliseconds $debug.timingsMs.twoTower
    GoongMatrix = Format-Milliseconds $debug.timingsMs.goongMatrix
    GA = Format-Milliseconds $debug.timingsMs.ga
    AI = Format-Milliseconds $debug.timingsMs.aiTotal
    Backend = Format-Milliseconds $debug.timingsMs.backendTotal
    Client = Format-Milliseconds $stopwatch.ElapsedMilliseconds
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

  if ($debug.candidateBuilder) {
    Write-Host "=== CANDIDATE BUILDER ==="
    [pscustomobject]@{
      Available = Format-Minutes $debug.candidateBuilder.availableMinutes
      DailyQuota = ($debug.candidateBuilder.dailyQuota.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
      FetchPlan = (@($debug.candidateBuilder.fetchPlan) | ForEach-Object { "$($_.slotType):$($_.limit)" }) -join ", "
    } | Format-List
  }

  $candidateRows = @($debug.twoTowerCandidates)
  $candidatePreview = if ($ShowDetails) { $candidateRows } else { $candidateRows | Select-Object -First $CandidatePreviewLimit }
  Write-Host "=== TWO-TOWER CANDIDATES ==="
  if (-not $ShowDetails -and $candidateRows.Count -gt $CandidatePreviewLimit) {
    Write-Host "Showing top $CandidatePreviewLimit of $($candidateRows.Count). Use -ShowDetails to print all; full data is in JSON/CSV."
  }
  $candidatePreview |
    ForEach-Object {
      [pscustomobject]@{
        Rank = $_.rank
        Type = $_.category
        Score = if ($null -ne $_.cosineScore) { [math]::Round([double]$_.cosineScore, 4) } else { $null }
        Place = $_.placeName
      }
    } |
    Format-Table -AutoSize -Wrap

  Write-Host "=== TOTALS BY PLACE TYPE ==="
  $debug.totalsByPlaceType.PSObject.Properties |
    Sort-Object Name |
    ForEach-Object {
      $value = $_.Value
      [pscustomobject]@{
        Type = $_.Name
        Count = $value.count
        Travel = Format-Minutes $value.travelMinutes
        RawTravel = Format-Minutes $value.rawTravelMinutes
        Stay = Format-Minutes $value.activeDurationMinutes
        Wait = Format-Minutes $value.waitMinutes
        Km = $value.distanceKm
      }
    } |
    Format-Table -AutoSize

  if ($debug.priceEstimate) {
    Write-Host "=== PRICE ESTIMATE FROM CSV ==="
    $cost = $debug.priceEstimate
    [pscustomobject]@{
      Hotel = $cost.breakdownVnd.hotel
      Restaurant = $cost.breakdownVnd.restaurant
      Cafe = $cost.breakdownVnd.cafe
      Attraction = $cost.breakdownVnd.attraction
      Entertainment = $cost.breakdownVnd.entertainment
      Transport = $cost.breakdownVnd.transport
      Total = $cost.totalVnd
      BudgetPerPerson = $cost.userBudgetPerPersonVnd
      TotalBudget = $cost.userBudgetVnd
      OverBudget = $cost.overBudgetVnd
      Observed = $cost.confidence.observed
      Inferred = $cost.confidence.inferred
      Missing = $cost.confidence.missing
    } | Format-List
  }
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
      Cost = $_.total_day_cost
      Budget = $_.budget_limit
      Over = $_.budget_overage
      Fitness = $_.fitness
      Stop = $_.stopped_reason
    }
  } |
  Format-Table -AutoSize

if ($debug) {
  Write-Host "Detailed JSON/CSV reports are in:"
  Write-Host "  .\api-service\logs\itinerary-plan-debug\json"
  Write-Host "  .\api-service\logs\itinerary-plan-debug\schedule-csv"
  Write-Host "  .\api-service\logs\itinerary-plan-debug\planner-input-csv"
}

if ($ShowDetails) {
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
          Move = Format-Minutes $_.travel_minutes
          Base = Format-Minutes $_.base_duration_minutes
          Stay = Format-Minutes $_.active_duration_minutes
          Wait = Format-Minutes $_.wait_minutes
          Km = $_.distance_km
          Cost = $_.estimated_cost
        }
      } |
      Format-Table -AutoSize -Wrap
  }
}
