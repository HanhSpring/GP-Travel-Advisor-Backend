param(
  [string]$ApiUrl = "http://localhost:3000",
  [int]$TopK = 120,
  [string]$UserId = "5f56692b-8daa-4852-bfe7-1032a07635ff",
  [string]$TripType = "ROUND_TRIP",
  [string]$DepartureLocationId = "SGN",
  [string]$DestinationLocationId = "1aa5ed1b-16c1-51f4-a3ba-c25e0ed91ce5",
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

$debugPath = @(
  ".\logs\itinerary-plan-debug\json\latest.json",
  ".\api-service\logs\itinerary-plan-debug\json\latest.json"
) |
  Where-Object { Test-Path $_ } |
  Sort-Object { (Get-Item $_).LastWriteTimeUtc } -Descending |
  Select-Object -First 1
$debug = $null
if ($debugPath -and (Test-Path $debugPath)) {
  $debug = Get-Content $debugPath -Raw -Encoding utf8 | ConvertFrom-Json
}

$plan = $response.plan
if ($null -eq $plan -and $null -ne $response.days) {
  $plan = $response
}
$groupSize = [math]::Max(1, ($AdultCount + $ChildCount))

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
        CostPerPerson = [math]::Round(([double]$summary.total_cost / $groupSize))
        GroupCost = $summary.total_cost
        TimeFeasible = $summary.validation.is_feasible
        BudgetFeasible = ($summary.total_cost -le $Budget)
        Overall = if ($summary.validation.is_feasible) { "Check MD" } else { "Infeasible" }
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
          CostPerPerson = [math]::Round(([double]$_.day_cost / $groupSize))
          GroupCost = $_.day_cost
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
if ($null -ne $debug) {
  Write-Host "Saved backend debug:"
  Write-Host "  $debugPath"
}

Write-Host ""
Write-Host "=== TONG QUAN / GENERAL OVERVIEW ==="
if ($null -ne $debug) {
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

  if ($null -ne $debug.travelSourceCounts) {
    Write-Host "=== TRAVEL MATRIX SOURCES ==="
    $debug.travelSourceCounts.PSObject.Properties |
      Sort-Object Name |
      ForEach-Object {
        [pscustomobject]@{ Source = $_.Name; DirectedPairs = $_.Value }
      } |
      Format-Table -AutoSize
  }

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
    Write-Host "=== PRICE ESTIMATE FROM DATABASE ==="
    $cost = $debug.priceEstimate
    @(
      [pscustomobject]@{ Item = "Hotel"; CostPerPerson = [math]::Round($cost.breakdownVnd.hotel / $groupSize); GroupCost = $cost.breakdownVnd.hotel }
      [pscustomobject]@{ Item = "Restaurant"; CostPerPerson = [math]::Round($cost.breakdownVnd.restaurant / $groupSize); GroupCost = $cost.breakdownVnd.restaurant }
      [pscustomobject]@{ Item = "Cafe"; CostPerPerson = [math]::Round($cost.breakdownVnd.cafe / $groupSize); GroupCost = $cost.breakdownVnd.cafe }
      [pscustomobject]@{ Item = "Attraction"; CostPerPerson = [math]::Round($cost.breakdownVnd.attraction / $groupSize); GroupCost = $cost.breakdownVnd.attraction }
      [pscustomobject]@{ Item = "Entertainment"; CostPerPerson = [math]::Round($cost.breakdownVnd.entertainment / $groupSize); GroupCost = $cost.breakdownVnd.entertainment }
      [pscustomobject]@{ Item = "Transport"; CostPerPerson = [math]::Round($cost.breakdownVnd.transport / $groupSize); GroupCost = $cost.breakdownVnd.transport }
      [pscustomobject]@{ Item = "TOTAL"; CostPerPerson = [math]::Round($cost.totalVnd / $groupSize); GroupCost = $cost.totalVnd }
    ) | Format-Table -AutoSize
    [pscustomobject]@{
      GroupSize = $groupSize
      TotalTripBudget = $cost.userBudgetVnd
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
      Candidates = $_.candidates
      Visited = $_.visited_count
      Restaurants = $_.restaurant_count
      Travel = Format-Minutes $_.total_travel_minutes
      Visit = Format-Minutes $_.total_visit_minutes
      Wait = Format-Minutes $_.total_wait_minutes
      DistanceKm = $_.total_distance_km
      CostPerPerson = [math]::Round(([double]$_.total_day_cost / $groupSize))
      GroupCost = $_.total_day_cost
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

Write-Host ""
if ($plan.comparison -and $plan.comparison.engines) {
  Write-Host "=== ENGINE DETAIL SCHEDULES ==="
  foreach ($engineName in @("ga_v1", "scheduler_v2")) {
    $engineSummary = $plan.comparison.engines.$engineName
    if ($null -eq $engineSummary) { continue }
    Write-Host ""
    Write-Host "--- $engineName DETAIL SCHEDULE ---"
    $cDays = @($engineSummary.days)
    foreach ($day in $cDays) {
      Write-Host ""
      Write-Host "DAY $($day.day) (Candidates: $($day.candidates) | Visited: $($day.visited) | Travel: $(Format-Minutes $day.travel_minutes) | Distance: $($day.distance_km) km | Cost: $($day.day_cost) VND)"
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
            CostPerPerson = [math]::Round(([double]$_.estimated_cost / $groupSize))
            GroupCost = $_.estimated_cost
          }
        } |
        Format-Table -AutoSize -Wrap
    }
  }
} else {
  Write-Host "=== DETAIL SCHEDULE ==="
  foreach ($day in $days) {
    Write-Host ""
    $dayHdr = "DAY $($day.day) (Candidates: $($day.candidates) | Visited: $($day.visited_count) | Travel: $(Format-Minutes $day.total_travel_minutes) | Distance: $($day.total_distance_km) km | Cost: $($day.total_day_cost) VND)"
    if ($null -ne $day.target_poi_count) { $dayHdr += " | Target: $($day.target_poi_count) POI ($($day.available_minutes)min)" }
    if ($null -ne $day.extra_penalty -and $day.extra_penalty -gt 0) { $dayHdr += " | Penalty: $($day.extra_penalty)" }
    Write-Host $dayHdr
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
          CostPerPerson = [math]::Round(([double]$_.estimated_cost / $groupSize))
          GroupCost = $_.estimated_cost
        }
      } |
      Format-Table -AutoSize -Wrap
  }
}

# Generate Markdown Report
$provinceName = "Unknown"
if ($null -ne $debug -and $null -ne $debug.request.destinationName) {
  $provinceName = $debug.request.destinationName
}

$provinceSlug = ConvertTo-SafeFileName $provinceName
$intentSlug = ConvertTo-SafeFileName $TripIntent

$mdPath = Join-Path $OutDir "$timestamp-comparison-report-$provinceSlug-$intentSlug.md"
$latestMdPath = Join-Path $OutDir "latest-comparison-report.md"

$md = @()
$md += "# Itinerary Engine Comparison Report - $provinceName"
$md += ""
$md += "* **Date Run**: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$md += "* **Destination**: $provinceName"
$md += "* **Intent**: $TripIntent"
$md += "* **Dates**: $StartDate -> $EndDate"
$md += "* **Time Window**: $DailyStartTime - $DailyEndTime"
$md += "* **Budget**: $Budget VND"
if ($debug) {
  $md += "* **Input Candidates**: $($debug.counts.twoTowerCandidates) places"
} else {
  $md += "* **Input Candidates**: $($plan.input_places) places"
}
$md += ""

if ($null -ne $debug) {
  $md += "## 1. Tong quan / Execution Summary"
  $md += ""
  $md += "| Metric | Value |"
  $md += "| :--- | :--- |"
  $md += "| **Destination** | $provinceName |"
  $md += "| **Intent** | $($debug.request.tripIntent) |"
  $md += "| **Days** | $($debug.request.numDays) |"
  $md += "| **TopK Limit** | $($debug.request.topK) |"
  $md += "| **Two-Tower Candidates** | $($debug.counts.twoTowerCandidates) |"
  $md += "| **Planner Input Places** | $($debug.counts.plannerInputPlaces) |"
  $md += "| **Total Visited (Winner)** | $($debug.counts.aiTotalVisited) |"
  $md += "| **Two-Tower Model Time** | $(Format-Milliseconds $debug.timingsMs.twoTower) |"
  $md += "| **Goong Matrix API Time** | $(Format-Milliseconds $debug.timingsMs.goongMatrix) |"
  $md += "| **GA Engine Time** | $(Format-Milliseconds $debug.timingsMs.ga) |"
  $md += "| **Planner Engine** | $($debug.plannerEngine) |"
  $md += "| **Solver Engine Time** | $(Format-Milliseconds $debug.timingsMs.solver) |"
  $md += "| **Total AI Service Time** | $(Format-Milliseconds $debug.timingsMs.aiTotal) |"
  $md += "| **Total Backend Time** | $(Format-Milliseconds $debug.timingsMs.backendTotal) |"
  $md += "| **Total Client Time** | $(Format-Milliseconds $stopwatch.ElapsedMilliseconds) |"
  $md += ""

  $md += "### Travel Matrix Sources"
  $md += ""
  $md += "| Source | Directed Pairs |"
  $md += "| :--- | :--- |"
  if ($null -ne $debug.travelSourceCounts) {
    $debug.travelSourceCounts.PSObject.Properties |
      Sort-Object Name |
      ForEach-Object {
        $md += "| **$($_.Name)** | $($_.Value) |"
      }
  }
  $md += ""

  # Totals by place type table
  $md += "### Totals by Place Type (Winner)"
  $md += ""
  $md += "| Place Type | Count | Travel Time | Raw Travel Time | Stay Time | Wait Time | Distance |"
  $md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |"
  $debug.totalsByPlaceType.PSObject.Properties |
    Sort-Object Name |
    ForEach-Object {
      $value = $_.Value
      $md += "| **$($_.Name)** | $($value.count) | $(Format-Minutes $value.travelMinutes) | $(Format-Minutes $value.rawTravelMinutes) | $(Format-Minutes $value.activeDurationMinutes) | $(Format-Minutes $value.waitMinutes) | $($value.distanceKm) km |"
    }
  $md += ""

  # Price estimate table
  if ($debug.priceEstimate) {
    $cost = $debug.priceEstimate
    $md += "### Price Estimate Breakdown (Winner)"
    $md += ""
    $md += "| Item | Cost/person (VND) | Group cost (VND) |"
    $md += "| :--- | ---: | ---: |"
    $md += "| **Hotel** | $([math]::Round($cost.breakdownVnd.hotel / $groupSize)) | $($cost.breakdownVnd.hotel) |"
    $md += "| **Restaurant** | $([math]::Round($cost.breakdownVnd.restaurant / $groupSize)) | $($cost.breakdownVnd.restaurant) |"
    $md += "| **Cafe** | $([math]::Round($cost.breakdownVnd.cafe / $groupSize)) | $($cost.breakdownVnd.cafe) |"
    $md += "| **Attraction** | $([math]::Round($cost.breakdownVnd.attraction / $groupSize)) | $($cost.breakdownVnd.attraction) |"
    $md += "| **Entertainment** | $([math]::Round($cost.breakdownVnd.entertainment / $groupSize)) | $($cost.breakdownVnd.entertainment) |"
    $md += "| **Transport** | $([math]::Round($cost.breakdownVnd.transport / $groupSize)) | $($cost.breakdownVnd.transport) |"
    $md += "| **Total Cost** | **$([math]::Round($cost.totalVnd / $groupSize))** | **$($cost.totalVnd)** |"
    $md += "| **Group Size** | $($AdultCount + $ChildCount) |"
    $md += "| **Total Trip Budget** | $($cost.userBudgetVnd) |"
    $md += "| **Over Budget** | $($cost.overBudgetVnd) |"
    $md += ""
  }
}

if ($plan.comparison -and $plan.comparison.engines) {
  $md += "## 2. Overall Performance"
  $md += ""
  $md += "| Engine | Execution Time | Visited POIs | Travel | Wait | Distance | Cost/person | Group cost | Time Feasible | Budget Feasible | Overall Status |"
  $md += "| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | :--- | :--- | :--- |"
  
  $plan.comparison.engines.PSObject.Properties |
    Sort-Object Name |
    ForEach-Object {
      $summary = $_.Value
      $totalBudgetLimit = $Budget
      $budgFeas = if ($summary.total_cost -gt $totalBudgetLimit) { "No" } else { "Yes" }
      $timeFeas = if ($summary.validation.is_feasible) { "Yes" } else { "No" }
      $overall = if ($summary.validation.is_feasible -and $budgFeas -eq "Yes") { "Feasible" } elseif ($summary.validation.is_feasible) { "Soft-Feasible / Budget-Failed" } else { "Infeasible" }
      $md += "| **$($_.Name)** | $(Format-Milliseconds $summary.elapsed_ms) | $($summary.total_visited) | $(Format-Minutes $summary.total_travel_minutes) | $(Format-Minutes $summary.total_wait_minutes) | $($summary.total_distance_km) km | $([math]::Round($summary.total_cost / $groupSize)) VND | $($summary.total_cost) VND | $timeFeas | $budgFeas | $overall |"
    }
  $md += ""
  $md += "* **Winner Hint**: $($plan.comparison.winner_hint)"
  $md += ""

  $md += "## 3. Day-by-Day Comparison"
  $md += ""
  $md += "| Day | GA Cand | Sched Final | Sched Base | Sched +R | GA Visited | Sched Visited | GA Travel | Sched Travel | GA Wait | Sched Wait | GA Distance | Sched Distance |"
  $md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |"

  $gaDays = $plan.comparison.engines.ga_v1.days
  $v2Days = $plan.comparison.engines.scheduler_v2.days
  $maxDaysCount = [math]::Max(@($gaDays).Count, @($v2Days).Count)
  for ($i = 0; $i -lt $maxDaysCount; $i++) {
    $gaDay = $gaDays[$i]
    $v2Day = $v2Days[$i]
    $dayNum = $i + 1
    $gaCand  = if ($gaDay)  { $gaDay.candidates }                           else { "-" }
    $v2Final = if ($v2Day)  { $v2Day.final_candidates }                     else { "-" }
    $v2Base  = if ($v2Day)  { $v2Day.base_candidates }                      else { "-" }
    $v2InjR  = if ($v2Day)  { $v2Day.injected_restaurant_candidates }       else { "-" }
    $gaVis   = if ($gaDay)  { $gaDay.visited }                              else { "-" }
    $v2Vis   = if ($v2Day)  { $v2Day.visited }                              else { "-" }
    $gaTrv   = if ($gaDay)  { Format-Minutes $gaDay.travel_minutes }        else { "-" }
    $v2Trv   = if ($v2Day)  { Format-Minutes $v2Day.travel_minutes }        else { "-" }
    $gaWait  = if ($gaDay)  { Format-Minutes $gaDay.wait_minutes }          else { "-" }
    $v2Wait  = if ($v2Day)  { Format-Minutes $v2Day.wait_minutes }          else { "-" }
    $gaDist  = if ($gaDay)  { "$($gaDay.distance_km) km" }                  else { "-" }
    $v2Dist  = if ($v2Day)  { "$($v2Day.distance_km) km" }                  else { "-" }
    $md += "| $dayNum | $gaCand | $v2Final | $v2Base | $v2InjR | $gaVis | $v2Vis | $gaTrv | $v2Trv | $gaWait | $v2Wait | $gaDist | $v2Dist |"
  }
  $md += ""

  $md += "## 4. Detailed Schedules"
  $md += ""
  
  foreach ($engineName in @("ga_v1", "scheduler_v2")) {
    $engineSummary = $plan.comparison.engines.$engineName
    if ($null -eq $engineSummary) { continue }
    $md += "### Engine: $engineName"
    $md += ""
    $cDays = @($engineSummary.days)
    foreach ($day in $cDays) {
      if ($engineName -eq "scheduler_v2" -and $null -ne $day.base_candidates) {
        $injR       = if ($null -ne $day.injected_restaurant_candidates) { $day.injected_restaurant_candidates } else { 0 }
        $cafeFilt   = if ($null -ne $day.cafe_filtered_count -and $day.cafe_filtered_count -gt 0) { " \| -Cafe: $($day.cafe_filtered_count)" } else { "" }
        $diagLine   = "Base: $($day.base_candidates) \| +R: $injR$cafeFilt \| Final: $($day.final_candidates) \| Visited: $($day.visited)"
        $penLine    = if ($null -ne $day.extra_penalty -and $day.extra_penalty -gt 0) { " \| Penalty: $($day.extra_penalty)" } else { "" }
        $tgtLine    = if ($null -ne $day.target_poi_count) { " \| Target: $($day.target_poi_count) POI ($($day.available_minutes)min)" } else { "" }
        $clusterStr = ""
        if ($null -ne $day.day_cluster_center) {
          $rDist = if ($null -ne $day.restaurant_distance_to_cluster) { "R:$($day.restaurant_distance_to_cluster)km" } else { "" }
          $cDist = if ($null -ne $day.cafe_distance_to_cluster) { "C:$($day.cafe_distance_to_cluster)km" } else { "" }
          $foodDist = (@($rDist, $cDist) | Where-Object { $_ -ne "" }) -join "/"
          if ($foodDist) { $clusterStr = " \| food@cluster=$foodDist" }
        }
        $injReason  = if ($null -ne $day.injected_reason) { " \| inject=$($day.injected_reason)" } else { "" }
        $remoteStr  = ""
        if ($day.is_remote_day -eq $true) {
          $remoteStr = " \| **REMOTE**"
          if ($null -ne $day.remote_anchor_name) { $remoteStr += ": $($day.remote_anchor_name)" }
        }
        $sweepStr   = ""
        if ($null -ne $day.day_used_minutes) {
          $sweepStr = " \| sweep: $($day.day_used_minutes)min / $($day.day_estimated_distance)km"
        }
        $md += "#### Day $($day.day) ($diagLine$tgtLine$penLine$clusterStr$injReason$remoteStr$sweepStr \| Distance: $($day.distance_km) km \| Cost: $($day.day_cost) VND)"
      } else {
        $md += "#### Day $($day.day) (Candidates: $($day.candidates) \| Visited: $($day.visited) \| Distance: $($day.distance_km) km \| Cost: $($day.day_cost) VND)"
      }
      $md += ""
      $md += "| Time | Type | Place Name | Travel Time | Base Stay | Active Stay | Wait Time | Distance | Cost/person | Group cost |"
      $md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: |"
      
      $schedule = @($day.schedule)
      if ($schedule.Count -eq 0) {
        $md += "| - | - | No activities | - | - | - | - | - | - |"
      } else {
        $schedule | ForEach-Object {
          $type = "attraction"
          if ($_.is_return_to_hotel -eq $true) { $type = "return" }
          elseif ($_.is_restaurant -eq $true) { $type = "restaurant" }
          elseif ($_.place_type) { $type = $_.place_type }
          
          $md += "| $($_.arrival_time)-$($_.departure_time) | $type | $($_.location_name) | $(Format-Minutes $_.travel_minutes) | $(Format-Minutes $_.base_duration_minutes) | $(Format-Minutes $_.active_duration_minutes) | $(Format-Minutes $_.wait_minutes) | $($_.distance_km) km | $([math]::Round($_.estimated_cost / $groupSize)) VND | $($_.estimated_cost) VND |"
        }
      }
      $md += ""
    }
  }
} else {
  $engineName = if ($plan.planner_engine) { [string]$plan.planner_engine } else { [string]$Engine }
  $totalTravel = ($days | Measure-Object -Property total_travel_minutes -Sum).Sum
  $totalWait = ($days | Measure-Object -Property total_wait_minutes -Sum).Sum
  $totalDistance = [math]::Round(($days | Measure-Object -Property total_distance_km -Sum).Sum, 2)
  $totalCost = [math]::Round(($days | Measure-Object -Property total_day_cost -Sum).Sum)
  $totalVisited = ($days | Measure-Object -Property visited_count -Sum).Sum
  $totalBudgetLimit = $Budget
  $budgetFeasible = if ($totalCost -le $totalBudgetLimit) { "Yes" } else { "No" }
  $timeFeasible = if ($null -ne $debug -and $debug.validation.isFeasible -eq $false) { "No" } else { "Yes" }
  $overallStatus = if ($timeFeasible -eq "Yes" -and $budgetFeasible -eq "Yes") {
    "Feasible"
  } elseif ($timeFeasible -eq "Yes") {
    "Soft-Feasible / Budget-Failed"
  } else {
    "Infeasible"
  }

  $md += "## 2. Overall Performance"
  $md += ""
  $md += "| Engine | Execution Time | Visited POIs | Travel | Wait | Distance | Cost/person | Group cost | Time Feasible | Budget Feasible | Overall Status |"
  $md += "| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | :--- | :--- | :--- |"
  $md += "| **$engineName** | $(Format-Milliseconds $plan.solver_ms) | $totalVisited | $(Format-Minutes $totalTravel) | $(Format-Minutes $totalWait) | $totalDistance km | $([math]::Round($totalCost / $groupSize)) VND | $totalCost VND | $timeFeasible | $budgetFeasible | $overallStatus |"
  $md += ""

  if ($null -ne $debug) {
    $md += "### Validation"
    $md += ""
    $md += "| Metric | Value |"
    $md += "| :--- | :--- |"
    $md += "| **Feasible** | $($debug.validation.isFeasible) |"
    $md += "| **Violations** | $(@($debug.validation.violations).Count) |"
    $md += "| **Warnings** | $(@($debug.validation.warnings).Count) |"
    $md += "| **Assignment Warnings** | $(@($debug.assignment.warnings).Count) |"
    $md += ""
  }

  $md += "## 3. Day-by-Day Metrics"
  $md += ""
  $md += "| Day | Candidates | Visited | Target | Restaurants | Travel | Visit | Wait | Distance | Fitness | Cost/person | Group cost | Budget Over | Hard Violations | Stop Reason |"
  $md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | :--- | :--- | :--- |"
  foreach ($day in $days) {
    $md += "| $($day.day) | $($day.candidates) | $($day.visited_count) | $($day.target_visited_count) | $($day.restaurant_count) | $(Format-Minutes $day.total_travel_minutes) | $(Format-Minutes $day.total_visit_minutes) | $(Format-Minutes $day.total_wait_minutes) | $($day.total_distance_km) km | $($day.fitness) | $([math]::Round($day.total_day_cost / $groupSize)) VND | $($day.total_day_cost) VND | $($day.budget_overage) | $($day.total_hard_violations) | $($day.stopped_reason) |"
  }
  $md += ""

  if ($null -ne $debug -and @($debug.assignment.dayPools).Count -gt 0) {
    $md += "### Pre-allocation Diagnostics"
    $md += ""
    $md += "| Day | Assigned Candidates | Attraction | Restaurant | Cafe | Entertainment | Load Minutes | Method |"
    $md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |"
    foreach ($pool in @($debug.assignment.dayPools)) {
      $poolPlaces = @($pool.places)
      $attractions = @($poolPlaces | Where-Object { $_.role -eq "attraction" }).Count
      $restaurants = @($poolPlaces | Where-Object { $_.role -eq "restaurant" }).Count
      $cafes = @($poolPlaces | Where-Object { $_.role -eq "cafe" }).Count
      $entertainment = @($poolPlaces | Where-Object { $_.role -eq "entertainment" }).Count
      $md += "| $($pool.day) | $($poolPlaces.Count) | $attractions | $restaurants | $cafes | $entertainment | $($pool.load_minutes) | $($pool.allocation_method) |"
    }
    $md += ""
  }

  $md += "## 4. Detailed Schedules"
  $md += ""
  $md += "### Engine: $engineName"
  $md += ""
  foreach ($day in $days) {
    $md += "#### Day $($day.day) (Candidates: $($day.candidates) \| Visited: $($day.visited_count) \| Target: $($day.target_visited_count) \| Restaurant: $($day.restaurant_count) \| Travel: $(Format-Minutes $day.total_travel_minutes) \| Wait: $(Format-Minutes $day.total_wait_minutes) \| Distance: $($day.total_distance_km) km \| Fitness: $($day.fitness) \| Cost: $($day.total_day_cost) VND)"
    $md += ""
    $md += "| Time | Type | Place Name | Travel Time | Base Stay | Active Stay | Wait Time | Distance | Cost/person | Group cost |"
    $md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: |"
    
    $schedule = @($day.schedule)
    if ($schedule.Count -eq 0) {
      $md += "| - | - | No activities | - | - | - | - | - | - |"
    } else {
      $schedule | ForEach-Object {
        $type = "attraction"
        if ($_.is_return_to_hotel -eq $true) { $type = "return" }
        elseif ($_.is_restaurant -eq $true) { $type = "restaurant" }
        elseif ($_.place_type) { $type = $_.place_type }
        
        $md += "| $($_.arrival_time)-$($_.departure_time) | $type | $($_.location_name) | $(Format-Minutes $_.travel_minutes) | $(Format-Minutes $_.base_duration_minutes) | $(Format-Minutes $_.active_duration_minutes) | $(Format-Minutes $_.wait_minutes) | $($_.distance_km) km | $([math]::Round($_.estimated_cost / $groupSize)) VND | $($_.estimated_cost) VND |"
      }
    }
    $md += ""
  }
}

$md | Out-File -FilePath $mdPath -Encoding utf8
$md | Out-File -FilePath $latestMdPath -Encoding utf8

Write-Host ""
Write-Host "Generated Markdown comparison report:"
Write-Host "  $mdPath"
Write-Host "  $latestMdPath"
