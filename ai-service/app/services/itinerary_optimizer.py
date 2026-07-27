"""
Dịch vụ tối ưu lịch trình du lịch.

Thuật toán: Google OR-Tools CP-SAT Solver
─────────────────────────────────────────────────────────────────
"""

import math
import logging
from typing import Dict, Optional, Tuple, List
from ortools.sat.python import cp_model
from app.core.config import settings
from app.schemas.optimize import ActivityInput, OptimizedActivity, RouteAnchor
from app.services.itinerary import planner

logger = logging.getLogger(__name__)

def time_to_minutes(time_str: str) -> int:
    h, m = map(int, time_str.split(":"))
    return h * 60 + m

def minutes_to_time(minutes: int) -> str:
    minutes = max(0, min(minutes, 23 * 60 + 59))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"

def haversine_km(lat1: Optional[float], lng1: Optional[float],
                 lat2: Optional[float], lng2: Optional[float]) -> float:
    if None in (lat1, lng1, lat2, lng2):
        return float("inf")
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlng / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def round_travel_minutes(minutes) -> int:
    """Làm tròn lên bội số 5 phút. Phải khớp hệt scheduler_v2._round_travel_minutes()
    (dùng ở luồng TẠO lịch trình) — nếu không, cùng 1 quãng đường sẽ hiển thị
    2 con số phút khác nhau tuỳ lịch trình được tạo mới hay re-optimize sau
    khi thêm/sửa/thay địa điểm."""
    value = max(0, math.ceil(float(minutes)))
    return int(math.ceil(value / 5.0) * 5) if value > 0 else 0

def estimate_transit_minutes(dist_km: float) -> int:
    if dist_km == float("inf"):
        return 15
    # Đồng bộ với công thức Haversine fallback dùng lúc TẠO lịch trình
    # (planner.py: build_travel_times_haversine, speed_kmh=30 mặc định)
    # → phút = km / 30 × 60 = km × 2.0
    return round_travel_minutes(max(1.0, dist_km * 2.0))

def format_transit_label(dist_km: float) -> str:
    if dist_km == float("inf"):
        return "Di chuyển chưa rõ khoảng cách"
    mins = estimate_transit_minutes(dist_km)
    return f"{mins} phút di chuyển • {dist_km:.1f} km"


def format_duration(minutes: int) -> str:
    """Format duration exactly like itinerary.service.ts."""
    hours, remaining = divmod(max(0, int(minutes)), 60)
    if hours and remaining:
        return f"{hours} giờ {remaining} phút"
    if hours:
        return f"{hours} giờ"
    return f"{remaining} phút"


def format_distance(distance_km: float) -> str:
    """Keep one decimal at most, matching Number(distance.toFixed(1))."""
    return f"{distance_km:.1f}".rstrip("0").rstrip(".")


def build_real_travel_matrix(
    activities: List[ActivityInput | RouteAnchor],
    use_goong: bool = True,
    vehicle: str = "bike",
) -> Tuple[Dict[Tuple[str, str], int], Dict[Tuple[str, str], float]]:
    """
    Lấy thời gian/khoảng cách di chuyển thực tế cho các cặp địa điểm, dùng
    đúng nguồn dữ liệu như luồng TẠO lịch trình (planner.build_travel_matrix):
    ưu tiên cache DB (travel.distance_matrix) → cache file local → gọi Goong
    Distance Matrix API cho cặp còn thiếu → fallback Haversine nếu không có
    Goong key hoặc gọi API thất bại.

    Trả về 2 dict rỗng nếu có lỗi bất kỳ — gọi nơi dùng phải tự fallback
    sang Haversine cho từng cặp (không để một lỗi Goong làm hỏng cả lần
    tối ưu).
    """
    coords: Dict[str, Tuple[float, float]] = {}
    for act in activities:
        if act.lat is not None and act.lng is not None:
            coords[act.place_id] = (act.lng, act.lat)

    if len(coords) < 2:
        return {}, {}

    goong_key = settings.goong_api_key if use_goong else ""

    try:
        times, distances, _sources, _reliability = planner.build_travel_matrix(
            coords,
            api_key=goong_key,
            vehicle=vehicle,
            cache_path=planner.TRAVEL_CACHE_PATH,
            speed_kmh=30.0,
        )
        return times, distances
    except Exception as exc:
        logger.warning("[Optimizer] build_real_travel_matrix failed, dùng Haversine thuần: %s", exc)
        return {}, {}


def _transit_for_pair(
    act_i: ActivityInput | RouteAnchor,
    act_j: ActivityInput | RouteAnchor,
    real_times: Dict[Tuple[str, str], int],
    real_distances: Dict[Tuple[str, str], float],
) -> Tuple[int, float]:
    """Thời gian (phút) và khoảng cách (km) giữa 2 hoạt động — ưu tiên dữ
    liệu thật (Goong/cache) đã build sẵn, fallback Haversine nếu thiếu."""
    if act_i.place_id == act_j.place_id:
        return 0, 0.0

    pair = (act_i.place_id, act_j.place_id)
    if pair in real_times and pair in real_distances:
        return round_travel_minutes(real_times[pair]), real_distances[pair]

    dist = haversine_km(act_i.lat, act_i.lng, act_j.lat, act_j.lng)
    return estimate_transit_minutes(dist), (dist if dist != float("inf") else 0.0)


def optimize_day_schedule(
    activities: List[ActivityInput],
    day_start_time: str,
    day_end_time: str,
    allow_reduce_time: bool = False,
    use_goong: bool = True,
    travel_vehicle: str = "bike",
    preserve_order: bool = False,
    start_location: Optional[RouteAnchor] = None,
) -> Tuple[List[OptimizedActivity], List[str], int]:

    n = len(activities)
    if n == 0:
        return [], [], 0

    # Validate locked lunch edits before any Supabase/Goong matrix I/O. A lunch
    # activity keeps its meal role even when the user moves it outside the
    # window, so this must fail immediately instead of spending up to the HTTP
    # timeout building a matrix for a schedule that cannot be accepted.
    for act in activities:
        if not (act.is_restaurant and act.is_locked and act.locked_arrive_time):
            continue
        locked_minute = time_to_minutes(act.locked_arrive_time)
        if not planner.LUNCH_START <= locked_minute <= planner.LUNCH_END:
            raise ValueError("LUNCH_CONFLICT")

    real_times, real_distances = build_real_travel_matrix(
        [*activities, *([start_location] if start_location else [])],
        use_goong=use_goong,
        vehicle=travel_vehicle,
    )

    model = cp_model.CpModel()
    
    num_nodes = n + 2
    START_NODE = n
    END_NODE = n + 1
    
    # 1. Routing edges
    arcs = []
    edge_vars = {}
    for i in range(num_nodes):
        for j in range(num_nodes):
            if i == j: continue
            if i == END_NODE: continue
            if j == START_NODE: continue
            if i == START_NODE and j == END_NODE:
                if n > 0: continue
            
            lit = model.NewBoolVar(f'edge_{i}_{j}')
            edge_vars[(i, j)] = lit
            arcs.append([i, j, lit])
            
    lit_end_start = model.NewBoolVar('edge_end_start')
    edge_vars[(END_NODE, START_NODE)] = lit_end_start
    arcs.append([END_NODE, START_NODE, lit_end_start])
    
    model.AddCircuit(arcs)
    
    # 2. Time Variables
    start_min = time_to_minutes(day_start_time)
    end_min = time_to_minutes(day_end_time)
    
    arrival = {}
    departure = {}
    duration = {}
    
    for i in range(n):
        act = activities[i]
        arrival[i] = model.NewIntVar(start_min, end_min, f'arrival_{i}')
        departure[i] = model.NewIntVar(start_min, end_min + 1440, f'departure_{i}')
        
        orig_dur = act.duration_minutes
        if allow_reduce_time and not act.is_locked:
            # Giữ nguyên tuyệt đối activity người dùng đã chỉnh (is_locked).
            # Các activity còn lại có thể được rút sâu hơn 50% khi đó là cách
            # duy nhất để giữ bữa trưa trong khung giờ. Objective ở dưới phạt
            # từng phút bị giảm nên solver vẫn chỉ giảm đúng mức cần thiết.
            # Bữa ăn cần tối thiểu 30 phút; các điểm khác tối thiểu 15 phút.
            minimum_service_minutes = 30 if act.is_restaurant else 15
            min_dur = min(orig_dur, minimum_service_minutes)
            duration[i] = model.NewIntVar(min_dur, orig_dur, f'duration_{i}')
        else:
            duration[i] = model.NewIntVar(orig_dur, orig_dur, f'duration_{i}')
            
        model.Add(departure[i] == arrival[i] + duration[i])
        
        # Ràng buộc giờ mở cửa
        op = max(start_min, time_to_minutes(act.open_time))
        cl = min(end_min, time_to_minutes(act.close_time))
        model.Add(arrival[i] >= op)
        model.Add(departure[i] <= cl)
        
        # Ràng buộc ghim giờ
        if act.is_locked and act.locked_arrive_time:
            l_time = time_to_minutes(act.locked_arrive_time)
            model.Add(arrival[i] == l_time)
            
        # Ràng buộc Category — khung giờ theo loại địa điểm (buổi sáng/trưa/
        # chiều/tối), KHÔNG áp dụng nếu hoạt động đã bị user tự ghim giờ cụ
        # thể (giờ ghim của user luôn được ưu tiên tuyệt đối, không bị ép
        # theo khung category nữa).
        cat = (act.category or "").lower()
        if not (act.is_locked and act.locked_arrive_time):
            if "chợ đêm" in cat or "phố đi bộ" in cat:
                model.Add(arrival[i] >= 17 * 60 + 30)  # buổi tối: từ 17:30
            elif "chùa" in cat or "đền" in cat or "nhà thờ" in cat:
                model.Add(arrival[i] <= planner.LUNCH_END)  # buổi sáng/trưa: trước 14:00
            elif "bãi biển" in cat or "bãi tắm" in cat:
                model.Add(arrival[i] >= planner.LUNCH_END)  # buổi chiều: 14:00–17:30
                model.Add(arrival[i] <= 17 * 60 + 30)
            elif "khu du lịch sinh thái" in cat:
                model.Add(arrival[i] <= planner.LUNCH_START)  # buổi sáng: trước 10:30

        # Ràng buộc giờ ăn trưa
        if act.is_restaurant:
            if act.is_locked and act.locked_arrive_time:
                pass
            else:
                model.Add(arrival[i] >= planner.LUNCH_START)
                model.Add(arrival[i] <= planner.LUNCH_END)
                
    arrival[START_NODE] = model.NewIntVar(start_min, end_min, 'start')
    departure[START_NODE] = arrival[START_NODE]
    model.Add(arrival[START_NODE] == start_min)
    arrival[END_NODE] = model.NewIntVar(start_min, end_min, 'end')
    departure[END_NODE] = arrival[END_NODE]
    
    # 3. Time Transitions
    transit_matrix = {}
    waiting_time_terms = []
    for i in range(num_nodes):
        for j in range(num_nodes):
            if (i, j) in edge_vars and i != END_NODE and j != START_NODE:
                t = 0
                if i < n and j < n:
                    t, _ = _transit_for_pair(activities[i], activities[j], real_times, real_distances)
                elif i == START_NODE and j < n and start_location is not None:
                    t, _ = _transit_for_pair(start_location, activities[j], real_times, real_distances)
                transit_matrix[(i, j)] = t
                edge = edge_vars[(i, j)]
                model.Add(arrival[j] >= departure[i] + t).OnlyEnforceIf(edge)

                # Nếu không phạt khoảng chờ, mọi giờ đến từ mốc sớm nhất tới
                # giờ đóng cửa đều có giá trị như nhau với solver. Vì vậy một
                # điểm có thể bị đặt 21:00 dù điểm trước kết thúc 18:00 và chỉ
                # mất 40 phút di chuyển. Chỉ phạt phần chờ dư thừa để vẫn cho
                # phép đợi khi địa điểm tiếp theo chưa mở cửa.
                wait = model.NewIntVar(
                    0,
                    max(0, end_min - start_min),
                    f'wait_{i}_{j}',
                )
                model.Add(wait == arrival[j] - departure[i] - t).OnlyEnforceIf(edge)
                model.Add(wait == 0).OnlyEnforceIf(edge.Not())
                waiting_time_terms.append(wait)
                
    # 4. Giữ nguyên thứ tự tương đối cho các điểm cũ
    def _is_morning_constrained(act: ActivityInput) -> bool:
        cl = time_to_minutes(act.close_time)
        if cl <= 18 * 60 + 30: # Nếu đóng cửa sớm (<= 18:30) thì bắt buộc đi ban ngày
            return True
        cat = (act.category or "").lower()
        return any(c in cat for c in ["chùa", "đền", "nhà thờ"])

    has_new_morning_activity = any(
        act.is_new and _is_morning_constrained(act) for act in activities
    )

    penalty_terms = []
    
    existing_indices = [i for i, act in enumerate(activities) if not act.is_new]
    lunch_indices = [i for i, act in enumerate(activities) if act.is_restaurant]
    lunch_idx = lunch_indices[0] if lunch_indices else None

    if preserve_order:
        for index in range(n - 1):
            model.Add(edge_vars[(index, index + 1)] == 1)

    # Ràng buộc thứ tự tương đối của tất cả các điểm KHÔNG phải ăn trưa
    non_lunch_existing = [i for i in existing_indices if i != lunch_idx]
    for idx in range(len(non_lunch_existing) - 1):
        idx1 = non_lunch_existing[idx]
        idx2 = non_lunch_existing[idx + 1]
        act2 = activities[idx2]

        # Nếu đang thêm một điểm buổi sáng mới và act2 là điểm linh hoạt
        if has_new_morning_activity and not act2.is_locked and not _is_morning_constrained(act2):
            continue

        model.Add(arrival[idx1] < arrival[idx2])
        
    is_pushed_after_lunch_vars = {}
    if lunch_idx is not None and lunch_idx in existing_indices:
        morning_existing = [i for i in existing_indices if i < lunch_idx]
        afternoon_existing = [i for i in existing_indices if i > lunch_idx]
        
        for i in afternoon_existing:
            model.Add(arrival[i] > arrival[lunch_idx])
            
        for i in morning_existing:
            b_after = model.NewBoolVar(f'pushed_after_{i}')
            is_pushed_after_lunch_vars[i] = b_after
            
            # Lưu ý: Các điểm vẫn phải tuân thủ giờ mở cửa (đã xử lý ở phần 2. Time Variables)
            model.Add(arrival[i] >= departure[lunch_idx]).OnlyEnforceIf(b_after)
            model.Add(arrival[i] < arrival[lunch_idx]).OnlyEnforceIf(b_after.Not())
            
            penalty_terms.append(b_after * 5000)
            
    # 5. Objective
    travel_time_terms = []
    for (i, j), lit in edge_vars.items():
        if (i < n and j < n) or (i == START_NODE and j < n):
            travel_time_terms.append(lit * transit_matrix[(i, j)])
            
    if allow_reduce_time:
        for i in range(n):
            if not activities[i].is_locked:
                max_dur = activities[i].duration_minutes
                red = model.NewIntVar(0, max_dur, f'red_{i}')
                model.Add(red == max_dur - duration[i])
                penalty_terms.append(red * 10) # Phạt nhẹ hơn (10) để ưu tiên giữ nguyên thời gian
                
    compact_time_terms = list(arrival.values()) if preserve_order else []
    model.Minimize(
        sum(travel_time_terms)
        + sum(waiting_time_terms)
        + sum(penalty_terms)
        + sum(compact_time_terms)
    )
    
    # Solve
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 5.0
    status = solver.Solve(model)
    
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise ValueError("SCHEDULE_FULL")
        
    # Lấy kết quả
    optimized_activities = []
    reorder_notes = []
    total_transit = 0
    
    # Trace the path from START_NODE
    current = START_NODE
    seq_order = 1
    
    lunch_arrival_val = None
    if lunch_idx is not None:
        lunch_arrival_val = solver.Value(arrival[lunch_idx])
    
    while True:
        next_node = None
        for j in range(num_nodes):
            if (current, j) in edge_vars and solver.Value(edge_vars[(current, j)]):
                next_node = j
                break
        
        if next_node is None or next_node == END_NODE:
            break
            
        i = next_node
        act = activities[i]
        if current == START_NODE and start_location is not None:
            first_leg_minutes, _ = _transit_for_pair(
                start_location, act, real_times, real_distances
            )
            total_transit += first_leg_minutes
        arr_val = solver.Value(arrival[i])
        dur_val = solver.Value(duration[i])
        dep_val = solver.Value(departure[i])
        
        if dur_val < act.duration_minutes:
            if lunch_arrival_val is not None and arr_val < lunch_arrival_val:
                reorder_notes.append(f"Giảm thời gian tham quan tại '{act.place_id}' từ {act.duration_minutes} xuống {dur_val} phút để kịp lịch trình ăn trưa.")
            else:
                reorder_notes.append(f"Giảm thời gian tham quan tại '{act.place_id}' từ {act.duration_minutes} xuống {dur_val} phút.")
                
        if i in is_pushed_after_lunch_vars:
            if solver.Value(is_pushed_after_lunch_vars[i]):
                reorder_notes.append(f"Dời '{act.place_id}' xuống sau giờ ăn trưa do lịch trình buổi sáng quá chật.")
            
        optimized_activities.append(OptimizedActivity(
            id=act.id,
            place_id=act.place_id,
            sequence_order=seq_order,
            arrival_time=minutes_to_time(arr_val),
            departure_time=minutes_to_time(dep_val),
            duration_minutes=dur_val,
            is_locked=act.is_locked,
            transport_to_next=None
        ))
        seq_order += 1
        current = next_node
        
    # Tính transport_to_next
    for idx in range(len(optimized_activities) - 1):
        curr_act = optimized_activities[idx]
        next_act = optimized_activities[idx + 1]
        
        act1 = next((a for a in activities if a.id == curr_act.id), None)
        act2 = next((a for a in activities if a.id == next_act.id), None)

        if act1 and act2:
            mins, dist = _transit_for_pair(act1, act2, real_times, real_distances)
            curr_act.transport_to_next = (
                f"{format_duration(mins)} di chuyển • {format_distance(dist)} km"
            )
            curr_act.transport_duration_minutes = mins
            curr_act.transport_distance_km = dist
            total_transit += mins
            
    return optimized_activities, reorder_notes, total_transit


def validate_new_lock_time(
    new_arrive_time: str,
    duration_minutes: int,
    activity_id: str,
    existing_locked: List[ActivityInput],
) -> Tuple[bool, List[str], Optional[str]]:
    # Simple validate
    return True, [], None
