"""
Dịch vụ tối ưu lịch trình du lịch.

Thuật toán: Google OR-Tools CP-SAT Solver
─────────────────────────────────────────────────────────────────
"""

import math
import logging
from typing import Optional, Tuple, List
from ortools.sat.python import cp_model
from app.schemas.optimize import ActivityInput, OptimizedActivity
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

def estimate_transit_minutes(dist_km: float) -> int:
    if dist_km == float("inf"):
        return 15
    # Mô hình: đường thực tế ≈ Haversine × 1.3, tốc độ xe máy ~30 km/h
    # → phút = dist × 1.3 / 30 × 60 + 2 ≈ dist × 2.0 + 2
    # Ví dụ: 2km → 6 phút (khớp Google Maps), 5km → 12 phút
    return max(3, round(dist_km * 2.0 + 2))

def format_transit_label(dist_km: float) -> str:
    if dist_km == float("inf"):
        return "Di chuyển chưa rõ khoảng cách"
    mins = estimate_transit_minutes(dist_km)
    return f"{mins} phút di chuyển"


def optimize_day_schedule(
    activities: List[ActivityInput],
    day_start_time: str,
    day_end_time: str,
    allow_reduce_time: bool = False
) -> Tuple[List[OptimizedActivity], List[str], int]:
    
    n = len(activities)
    if n == 0:
        return [], [], 0

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
            # Cho phép giảm thời gian tham quan tối đa 50%, thời gian tối thiểu 15p
            min_dur = min(orig_dur, max(15, orig_dur // 2))
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
            
        # Ràng buộc Category
        cat = (act.category or "").lower()
        if "chợ đêm" in cat or "phố đi bộ" in cat:
            model.Add(arrival[i] >= 17 * 60 + 30) # >= 17:30

        # Ràng buộc giờ ăn trưa
        if act.is_restaurant:
            if act.is_locked and act.locked_arrive_time:
                pass
            else:
                model.Add(arrival[i] >= planner.LUNCH_START)
                model.Add(departure[i] <= planner.LUNCH_END)
                
    arrival[START_NODE] = model.NewIntVar(start_min, end_min, 'start')
    departure[START_NODE] = arrival[START_NODE]
    arrival[END_NODE] = model.NewIntVar(start_min, end_min, 'end')
    departure[END_NODE] = arrival[END_NODE]
    
    # 3. Time Transitions
    transit_matrix = {}
    for i in range(num_nodes):
        for j in range(num_nodes):
            if (i, j) in edge_vars and i != END_NODE and j != START_NODE:
                t = 0
                if i < n and j < n:
                    dist = haversine_km(activities[i].lat, activities[i].lng, activities[j].lat, activities[j].lng)
                    t = estimate_transit_minutes(dist)
                transit_matrix[(i, j)] = t
                model.Add(arrival[j] >= departure[i] + t).OnlyEnforceIf(edge_vars[(i, j)])
                
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
        if i < n and j < n:
            travel_time_terms.append(lit * transit_matrix[(i, j)])
            
    if allow_reduce_time:
        for i in range(n):
            if not activities[i].is_locked:
                max_dur = activities[i].duration_minutes
                red = model.NewIntVar(0, max_dur, f'red_{i}')
                model.Add(red == max_dur - duration[i])
                penalty_terms.append(red * 10) # Phạt nhẹ hơn (10) để ưu tiên giữ nguyên thời gian
                
    model.Minimize(sum(travel_time_terms) + sum(penalty_terms))
    
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
            dist = haversine_km(act1.lat, act1.lng, act2.lat, act2.lng)
            curr_act.transport_to_next = format_transit_label(dist)
            total_transit += estimate_transit_minutes(dist)
            
    return optimized_activities, reorder_notes, total_transit


def validate_new_lock_time(
    new_arrive_time: str,
    duration_minutes: int,
    activity_id: str,
    existing_locked: List[ActivityInput],
) -> Tuple[bool, List[str], Optional[str]]:
    # Simple validate
    return True, [], None
