# Prompt: Refactor GA Itinerary Planner — Kiến Trúc Phân Tầng

## Vai Trò Của Bạn

Bạn là một senior engineer được giao nhiệm vụ refactor module lập lịch trình du lịch (`planner.py` và `itinerary_service.py`) trong dự án GPTravelAdvisor. Bạn đã đọc toàn bộ context file của hệ thống và hiểu rõ pipeline hiện tại.

**Nguyên tắc tuyệt đối:**
- Không đụng vào Two-Tower (encode-query, recommend_service, Supabase RPC)
- Không thay đổi FastAPI route interface — request/response schema giữ nguyên với client
- Không thay đổi NestJS ngoại trừ những chỗ được chỉ định rõ
- Đảm bảo dữ liệu Goong được dùng đầy đủ, không fallback Haversine khi đã có Goong
- Mỗi tầng phải test được độc lập mà không cần chạy toàn bộ pipeline

---

## Bối Cảnh Vấn Đề

### Vấn đề hiện tại
Hệ thống đang gộp 3 bài toán khác nhau vào một GA duy nhất:
1. **Assignment** — POI nào đi ngày nào
2. **Routing** — Thứ tự đi trong ngày
3. **Feasibility check** — Có vừa time window, budget, giờ mở cửa không

Hậu quả: khi một tầng sai, không thể xác định tầng nào gây ra vấn đề. Triệu chứng phổ biến nhất là **ngày có ít điểm hoặc trống** — nhưng nguyên nhân có thể ở Assignment sai (pool ngày đó quá ít POI) hoặc Routing sai (GA bỏ quá nhiều POI do time không đủ).

### Kiến trúc đích
Tách thành 3 tầng độc lập, mỗi tầng có interface rõ ràng:

```
[TẦNG 1] AssignmentModule
    Input:  danh sách POI đầy đủ + travel_matrix (Goong) + config
    Output: day_pools[0..N] — mỗi ngày 1 list POI đã được phân công
    Test:   độc lập, không cần GA

[TẦNG 2] RoutingModule (GA)  
    Input:  day_pools từ Tầng 1 (pool đã fix cho từng ngày)
    Output: lịch trình có thứ tự, giờ, travel time cho từng ngày
    Test:   mock day_pools cố định, không cần Tầng 1

[TẦNG 3] FeasibilityValidator
    Input:  lịch trình từ Tầng 2
    Output: danh sách vi phạm (nếu có) + lịch trình đã validated
    Test:   mock lịch trình cố định
```

---

## Nhiệm Vụ Cụ Thể

### TẦNG 1 — Refactor AssignmentModule

**Tách `_preallocate_days()` ra thành class độc lập `AssignmentModule`.**

File mới: `ai-service/app/services/itinerary/assignment.py`

#### Interface bắt buộc:

```python
@dataclass
class AssignmentConfig:
    num_days: int
    daily_start_time: int        # phút từ nửa đêm, ví dụ 480 = 08:00
    daily_end_time: int          # ví dụ 1260 = 21:00
    trip_intent: str             # để tính quota theo intent
    hotel: Place

@dataclass  
class AssignmentResult:
    day_pools: list[list[Place]]           # day_pools[i] = list POI ngày i
    day_loads: list[int]                   # estimated load (phút) mỗi ngày
    warnings: list[str]                    # cảnh báo nếu ngày nào underloaded/overloaded

class AssignmentModule:
    def __init__(self, config: AssignmentConfig, travel_matrix: dict):
        ...
    
    def assign(self, places: list[Place]) -> AssignmentResult:
        ...
```

#### Logic assignment cần implement:

**Bước 1 — Tính available time thực tế mỗi ngày:**
```
daily_available = daily_end_time - daily_start_time
# Trừ đi thời gian ăn trưa cố định: 80 phút (travel + ăn)
# daily_effective = daily_available - 80
```

**Bước 2 — Tính load của từng POI dùng travel_matrix thật:**
```python
def _poi_load(self, poi: Place) -> int:
    hotel_travel = self.travel_matrix.get((self.config.hotel.id, poi.id), 25)
    # Hệ số 0.65 thay vì 0.35 cũ — phản ánh travel giữa các POI trong ngày
    local_allowance = min(60, max(15, round(hotel_travel * 0.65)))
    return max(30, poi.visit_duration) + local_allowance
```

**Bước 3 — Sector sweep với travel_matrix thật (không dùng Haversine):**
- Tính góc địa lý từ hotel cho mỗi POI: `atan2(lat_diff, lon_diff)`
- Chia vòng tròn thành `num_days` sector
- Sort POI trong mỗi sector theo khoảng cách Goong thật từ hotel (không Haversine)
- Assign vào day_pools theo sector

**Bước 4 — Validate và rebalance bắt buộc:**
```python
MIN_POOL_PER_DAY = 4  # tối thiểu 4 attraction mỗi ngày
MAX_LOAD_RATIO = 1.0  # tổng load không vượt daily_effective

# Sau assign, kiểm tra từng ngày:
for day_idx in range(num_days):
    pool = day_pools[day_idx]
    total_load = sum(self._poi_load(p) for p in pool if p.place_type == 'attraction')
    
    # Ngày thiếu điểm: lấy thêm từ ngày nhiều nhất
    if len(pool['attractions']) < MIN_POOL_PER_DAY:
        self._steal_from_richest_day(day_idx, by='nearest_to_hotel')
    
    # Ngày quá tải: trả bớt sang ngày thiếu
    if total_load > daily_effective * MAX_LOAD_RATIO:
        self._offload_farthest_poi(day_idx)
    
    # Log warning để debug
    if len(pool['attractions']) < MIN_POOL_PER_DAY:
        result.warnings.append(f"Day {day_idx+1}: only {len(pool['attractions'])} attractions after rebalance")
```

**Bước 5 — Restaurant assignment riêng:**
- Round-robin theo ngày như hiện tại
- Nếu `daily_end_time >= 19*60`: assign 2 restaurant/ngày (lunch + dinner)
- Đảm bảo restaurant pool đủ: nếu thiếu, log warning, không raise exception

#### Test độc lập cho AssignmentModule:
```python
# test_assignment.py
def test_no_empty_day():
    # Tạo mock 30 POI với lat/lon thật ở Đà Lạt
    # Mock travel_matrix từ file JSON cố định
    result = AssignmentModule(config, travel_matrix).assign(places)
    for day_pool in result.day_pools:
        assert len(day_pool['attractions']) >= MIN_POOL_PER_DAY

def test_load_within_bounds():
    result = AssignmentModule(config, travel_matrix).assign(places)
    for i, load in enumerate(result.day_loads):
        assert load <= daily_effective * 1.1, f"Day {i+1} overloaded: {load}m"
```

---

### TẦNG 2 — Refactor RoutingModule (GA)

**GA chỉ nhận pool đã được assign, không tự quyết định POI nào đi ngày nào.**

Thay đổi trong `TSP_TW_GA` và `MultiDayTripPlanner`:

#### 2a. Fix weekday calculation — Bug rõ ràng, sửa ngay

Trong `ItineraryPlanRequest` schema:
```python
trip_start_date: str | None = None  # "YYYY-MM-DD", None = fallback today
```

Trong `itinerary_service.py` — `_extract_time_window()` dòng ~178:
```python
# Nhận thêm param start_date, truyền từ plan_itinerary()
def _extract_time_window(self, place_input, day_idx: int, start_date: date):
    today_idx = (start_date.weekday() + day_idx) % 7
    # Không dùng datetime.date.today() nữa
```

Trong `MultiDayTripPlanner.__init__`:
```python
self.start_date = date.fromisoformat(trip_start_date) if trip_start_date else date.today()
```

Trong vòng lặp `run()`:
```python
current_day_of_week = (self.start_date.weekday() + day_idx) % 7
```

**Lưu ý: Sửa cả 2 chỗ — `planner.py` và `itinerary_service.py`. Cả hai đều có bug `datetime.date.today()`.**

#### 2b. Fix transport cost — Thêm vehicle param vào TSP_TW_GA

Thay constant đơn:
```python
# Trước
TRANSPORT_COST_PER_KM = 5_000

# Sau
TRANSPORT_COST_PER_KM = {
    "car": 15_000,
    "bike": 3_000,
    "taxi": 18_000,
    "truck": 20_000,
}
TRANSPORT_COST_DEFAULT = 10_000
```

Thêm param vào `TSP_TW_GA.__init__`:
```python
def __init__(self, ..., travel_vehicle: str = "car"):
    self.cost_per_km = TRANSPORT_COST_PER_KM.get(travel_vehicle, TRANSPORT_COST_DEFAULT)
```

Sửa trong `_objective`:
```python
total_transport_cost = total_distance * self.cost_per_km
```

Trong `MultiDayTripPlanner.run()`, truyền xuống:
```python
ga = TSP_TW_GA(..., travel_vehicle=self.travel_vehicle)
```

#### 2c. Fix restaurant deadlock — Sửa trong `_objective()`, không sửa preprocessing

Tìm đoạn dòng ~1367:
```python
# Trước
if restaurant_count >= 1 or poi.unknown_hours:
    continue

# Sau
if restaurant_count >= 1:
    continue

if poi.unknown_hours:
    # Không skip — cho vào lịch với soft penalty
    soft_penalty += 30
    wait = max(wait, LUNCH_START - arrival)
    # Không check LUNCH_END khi unknown_hours
else:
    wait = max(wait, LUNCH_START - arrival)
    if arrival + wait > LUNCH_END:
        continue
```

#### 2d. Fix skip tracking — Chỉ đếm greedy skip, không đếm các continue khác

```python
# Chỉ tại block greedy_fit check (~dòng 1383):
if greedy_fit and dep_est > config.end_time:
    skipped_count += 1   # ← Chỉ đây, không đếm chỗ khác
    continue
```

Thêm vào fitness:
```python
SKIP_PENALTY = 25
fitness += SKIP_PENALTY * skipped_count
```

Thêm `skipped_count: int = 0` vào `GAResult` dataclass.

#### 2e. Tune constants — Thay đổi tối thiểu, không thay đổi công thức

```python
# Budget penalty — tăng sensitivity
BUDGET_OVERAGE_UNIT_VND = 1_000    # từ 10_000
BUDGET_PENALTY_WEIGHT = 3.0         # từ 1.2

# Utility scale — cân bằng với travel penalty
UTILITY_SCALE = 200                 # từ 100

# Load factor trong sector sweep
# Sửa tại _estimated_place_load() dòng ~1850:
local_travel_allowance = min(60, max(15, round(hotel_travel * 0.65)))  # từ 0.35, cap từ 45→60
```

#### Test độc lập cho RoutingModule:
```python
# test_routing.py
def test_no_hard_violation_with_clean_pool():
    # Mock pool cố định: 6 attraction + 1 restaurant, giờ mở cửa đầy đủ
    # Mock travel_matrix từ file JSON cố định
    ga = TSP_TW_GA(pois=mock_pool, ...)
    result = ga.run()
    assert result.total_hard_violations == 0
    assert result.restaurant_count >= 1
    assert result.visited_count >= 4

def test_skipped_count_only_greedy():
    # Pool có POI không thể vừa time window
    result = ga.run()
    # skipped_count chỉ phản ánh greedy skip, không phải require_goong hay restaurant limit
    assert result.skipped_count >= 0
```

---

### TẦNG 3 — FeasibilityValidator

File mới: `ai-service/app/services/itinerary/validator.py`

Tầng này **không thay đổi lịch trình**, chỉ detect và report vi phạm sau khi GA xong.

```python
@dataclass
class Violation:
    day: int
    location_id: str
    location_name: str
    violation_type: str   # "closed", "budget_exceeded", "late_arrival", "missing_lunch"
    detail: str

@dataclass
class ValidationResult:
    is_feasible: bool
    violations: list[Violation]
    warnings: list[str]   # Không nghiêm trọng nhưng cần note

class FeasibilityValidator:
    def validate(self, schedule: MultiDayResult, places_map: dict[str, Place]) -> ValidationResult:
        violations = []
        
        for day_result in schedule.days:
            for entry in day_result.ga_result.schedule:
                place = places_map[entry.location_id]
                
                # Check giờ mở cửa thật
                arrival_min = time_str_to_minutes(entry.arrival_time)
                if not place.unknown_hours:
                    if arrival_min < place.open_time or arrival_min > place.close_time:
                        violations.append(Violation(
                            day=day_result.day,
                            location_id=entry.location_id,
                            location_name=entry.location_name,
                            violation_type="closed",
                            detail=f"Arrive {entry.arrival_time}, open {minutes_to_str(place.open_time)}–{minutes_to_str(place.close_time)}"
                        ))
                
                # Check budget
                # Check missing lunch
                # ...
        
        return ValidationResult(
            is_feasible=len([v for v in violations if v.violation_type in HARD_VIOLATIONS]) == 0,
            violations=violations,
            warnings=warnings
        )
```

Tích hợp vào `itinerary_service.plan_itinerary()` ở cuối, trước khi serialize response:
```python
validation = FeasibilityValidator().validate(multi_day_result, places_map)
if not validation.is_feasible:
    logger.warning(f"Schedule has {len(validation.violations)} hard violations")
# Violations được đưa vào response để NestJS có thể log/debug
```

---

### Kết Nối Các Tầng Trong `itinerary_service.py`

Sửa `plan_itinerary()` để dùng 3 tầng rõ ràng:

```python
async def plan_itinerary(req: ItineraryPlanRequest) -> ItineraryPlanResponse:
    # Parse places → Place dataclass (giữ nguyên)
    places = [_to_planner_place(p) for p in req.places]
    
    # Build travel matrix (giữ nguyên — Goong đã xử lý đúng)
    travel_matrix = await build_travel_matrix(...)
    
    # === TẦNG 1: Assignment ===
    assignment_config = AssignmentConfig(
        num_days=req.num_days,
        daily_start_time=parse_time(req.daily_start_time),
        daily_end_time=parse_time(req.daily_end_time),
        trip_intent=req.trip_intent or "Khám phá tổng hợp",
        hotel=hotel_place,
    )
    assignment_result = AssignmentModule(assignment_config, travel_matrix).assign(places)
    
    if assignment_result.warnings:
        logger.warning(f"Assignment warnings: {assignment_result.warnings}")
    
    # === TẦNG 2: Routing (GA) ===
    planner = MultiDayTripPlanner(
        day_pools=assignment_result.day_pools,  # Nhận pool đã assign
        hotel=hotel_place,
        travel_matrix=travel_matrix,
        config=tour_config,
        trip_start_date=req.trip_start_date,
        travel_vehicle=req.travel_vehicle,
        ...
    )
    multi_day_result = planner.run()
    
    # === TẦNG 3: Validation ===
    validation = FeasibilityValidator().validate(multi_day_result, places_map)
    if not validation.is_feasible:
        logger.warning(f"Hard violations: {[v.detail for v in validation.violations]}")
    
    # Serialize response (giữ nguyên format)
    return _serialize_response(multi_day_result, validation)
```

---

## Thứ Tự Thực Hiện

Làm theo thứ tự này, **không làm song song**, test sau mỗi bước:

```
Bước 1 — Fix weekday bug (cả 2 file)
  File: planner.py + itinerary_service.py
  Test: chạy với trip_start_date="2025-08-15" (thứ 6), verify giờ mở cửa đúng weekday

Bước 2 — Fix restaurant deadlock
  File: planner.py _objective()
  Test: mock pool chỉ có 1 restaurant với unknown_hours=True, verify không FEASIBILITY_PENALTY

Bước 3 — Fix transport cost + propagate travel_vehicle
  File: planner.py constants + TSP_TW_GA.__init__ + MultiDayTripPlanner.run()
  Test: verify total_transport_cost thay đổi theo vehicle

Bước 4 — Tune constants (sector sweep, budget, utility)
  File: planner.py constants
  Test: so sánh visited_count và fitness trước/sau

Bước 5 — Tách AssignmentModule thành file riêng
  File: assignment.py (mới) + planner.py (bỏ _preallocate_days)
  Test: test_assignment.py — assert no empty day, load within bounds

Bước 6 — Fix skip tracking + SKIP_PENALTY
  File: planner.py _objective() + GAResult dataclass
  Test: verify skipped_count chỉ đếm greedy skip

Bước 7 — Thêm FeasibilityValidator
  File: validator.py (mới) + itinerary_service.py
  Test: mock lịch trình có violation rõ ràng, verify detect đúng

Bước 8 — Tích hợp AssignmentModule vào itinerary_service.py
  File: itinerary_service.py
  Test: full pipeline với JSON debug log, so sánh visited_count trước/sau

Bước 9 — Truyền trip_start_date từ NestJS
  File: recommendation.service.ts
  Thêm: trip_start_date: dto.startDate vào payload gửi FastAPI
```

---

## Định Nghĩa "Đạt" Cho Từng Bước

Sau khi hoàn thành toàn bộ, chạy test case chuẩn (Đà Lạt, 3 ngày, 30 POI, 08:00–21:00) và verify:

| Metric | Ngưỡng đạt |
|---|---|
| Mỗi ngày `visited_count` | ≥ 4 |
| `restaurant_count` mỗi ngày | ≥ 1 |
| `total_hard_violations` | = 0 |
| `FeasibilityValidator.is_feasible` | = True |
| `stopped_reason` generation | ≥ 20 (không dừng quá sớm) |
| Không ngày nào `skipped_count` > 3 | ← nếu > 3 tức assignment overload |
| `AssignmentResult.warnings` | rỗng hoặc chỉ có info warnings |

Nếu bất kỳ metric nào không đạt, đọc JSON debug log để xác định tầng nào gây ra vấn đề trước khi tiếp tục.

---

## Không Được Làm

- Không thay đổi `ItineraryPlanRequest` / `ItineraryPlanResponse` schema ngoài việc thêm `trip_start_date` (optional)
- Không thay đổi cách Goong được gọi trong `build_travel_matrix`
- Không thay đổi Two-Tower, Supabase RPC, NestJS candidate retrieval
- Không refactor GA crossover/mutation operator — chỉ sửa fitness và constants
- Không thêm dependency mới (không dùng scipy, sklearn cho clustering — sector sweep đã đủ)