"""
Dịch vụ tối ưu lịch trình du lịch.

Thuật toán: Greedy TSPTW (Traveling Salesman with Time Windows)
─────────────────────────────────────────────────────────────────
Ý tưởng cốt lõi:
  1. Tách danh sách thành 2 nhóm:
     - Nhóm GHIM (is_locked=True): Ràng buộc cứng — phải giữ nguyên giờ
     - Nhóm TỰ DO (is_locked=False): Ràng buộc mềm — optimizer tự sắp xếp

  2. Xác nhận các giờ ghim không xung đột với nhau

  3. Lấp đầy các khoảng trống giữa các điểm ghim bằng greedy:
     Với mỗi khoảng trống [T_start, T_end], chọn địa điểm tự do
     gần nhất về mặt địa lý (tham lam theo khoảng cách)

  4. Tính arrival_time và departure_time cho từng địa điểm

Độ phức tạp: O(n² × k) với n = số địa điểm, k = số khoảng trống
Phù hợp: n ≤ 20 địa điểm/ngày — đủ cho một ngày du lịch thông thường
"""

import math
import logging
from typing import Optional
from app.schemas.optimize import ActivityInput, OptimizedActivity, OptimizeResponse

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# HÀM TIỆN ÍCH XỬ LÝ THỜI GIAN
# ─────────────────────────────────────────────────────────────────

def time_to_minutes(time_str: str) -> int:
    """
    Chuyển đổi chuỗi "HH:mm" thành số phút kể từ 00:00.

    Ví dụ: "09:30" → 570 (phút)
    """
    h, m = map(int, time_str.split(":"))
    return h * 60 + m


def minutes_to_time(minutes: int) -> str:
    """
    Chuyển đổi số phút kể từ 00:00 thành chuỗi "HH:mm".

    Ví dụ: 570 → "09:30"
    Xử lý overflow: nếu > 1440 phút (24h), giới hạn tại "23:59".
    """
    minutes = max(0, min(minutes, 23 * 60 + 59))  # Clamp trong phạm vi 24h
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# ─────────────────────────────────────────────────────────────────
# HÀM TÍNH KHOẢNG CÁCH (HAVERSINE)
# ─────────────────────────────────────────────────────────────────

def haversine_km(lat1: Optional[float], lng1: Optional[float],
                 lat2: Optional[float], lng2: Optional[float]) -> float:
    """
    Tính khoảng cách km giữa 2 điểm theo công thức Haversine.

    Trả về float("inf") nếu thiếu tọa độ — điểm không xác định
    sẽ được xếp cuối danh sách ưu tiên.
    """
    if None in (lat1, lng1, lat2, lng2):
        return float("inf")

    R = 6371.0  # Bán kính Trái Đất (km)
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
    """
    Ước tính thời gian di chuyển từ khoảng cách.

    Giả định vận tốc trung bình xe máy trong thành phố: 25 km/h.
    Thêm buffer 5 phút cho tìm chỗ đỗ xe, đi bộ vào cổng.
    Tối thiểu 5 phút ngay cả khi rất gần.
    """
    if dist_km == float("inf"):
        return 15  # Mặc định 15 phút nếu không biết vị trí

    drive_minutes = (dist_km / 25.0) * 60  # 25 km/h
    buffer = 5  # phút buffer cố định
    return max(5, round(drive_minutes + buffer))


def format_transit_label(dist_km: float) -> str:
    """Tạo chuỗi mô tả di chuyển. VD: '~8 phút đi xe máy (2.3km)'"""
    if dist_km == float("inf"):
        return "~15 phút di chuyển"
    mins = estimate_transit_minutes(dist_km)
    if dist_km < 0.5:
        return f"~{mins} phút đi bộ"
    return f"~{mins} phút đi xe máy ({dist_km:.1f}km)"


# ─────────────────────────────────────────────────────────────────
# KIỂM TRA XUNG ĐỘT GIỮA CÁC ĐIỂM ĐÃ GHIM
# ─────────────────────────────────────────────────────────────────

def check_locked_conflicts(
    locked_activities: list[ActivityInput],
) -> list[str]:
    """
    Kiểm tra xem các điểm đã ghim giờ có gây xung đột thời gian nhau không.

    Xung đột xảy ra khi:
      Điểm A kết thúc lúc 11:00, nhưng Điểm B ghim bắt đầu lúc 10:30
      → Không đủ thời gian để di chuyển từ A sang B

    Trả về: List các mô tả xung đột (rỗng = không có xung đột)
    """
    conflicts: list[str] = []

    # Sắp xếp theo giờ ghim tăng dần
    sorted_locked = sorted(
        locked_activities,
        key=lambda a: time_to_minutes(a.locked_arrive_time or "00:00"),
    )

    for i in range(len(sorted_locked) - 1):
        current = sorted_locked[i]
        next_act = sorted_locked[i + 1]

        # Tính giờ rời đi của điểm hiện tại
        current_arrive = time_to_minutes(current.locked_arrive_time or "00:00")
        current_depart = current_arrive + current.duration_minutes

        # Tính thời gian cần thiết để di chuyển sang điểm tiếp theo
        dist = haversine_km(current.lat, current.lng, next_act.lat, next_act.lng)
        transit = estimate_transit_minutes(dist)

        # Giờ sớm nhất có thể đến điểm tiếp theo
        earliest_next_arrive = current_depart + transit

        # Giờ đã ghim của điểm tiếp theo
        next_locked_arrive = time_to_minutes(next_act.locked_arrive_time or "00:00")

        if earliest_next_arrive > next_locked_arrive:
            conflicts.append(
                f"Xung đột: Điểm {current.id} kết thúc {minutes_to_time(current_depart)} "
                f"+ {transit} phút di chuyển = {minutes_to_time(earliest_next_arrive)}, "
                f"nhưng điểm {next_act.id} ghim lúc {next_act.locked_arrive_time}."
            )

    return conflicts


# ─────────────────────────────────────────────────────────────────
# THUẬT TOÁN GREEDY TSPTW CHÍNH
# ─────────────────────────────────────────────────────────────────

def optimize_day_schedule(
    activities: list[ActivityInput],
    day_start_time: str = "08:00",
    day_end_time: str = "21:00",
) -> tuple[list[OptimizedActivity], list[str], int]:
    """
    Tối ưu lịch một ngày theo thuật toán Greedy TSPTW.

    Trả về:
      - list[OptimizedActivity]: Lịch đã sắp xếp (theo sequence_order)
      - list[str]: Ghi chú về các thay đổi thứ tự
      - int: Tổng thời gian di chuyển (phút)

    Thuật toán:
    ─────────────────────────────────────────────────────────────
    BƯỚC 1: Phân loại hoạt động
      - Nhóm GHIM: is_locked=True và có locked_arrive_time
      - Nhóm TỰ DO: còn lại

    BƯỚC 2: Kiểm tra xung đột giữa các điểm ghim
      - Nếu có xung đột nghiêm trọng → log cảnh báo (vẫn tiếp tục)

    BƯỚC 3: Xây dựng "xương sống" từ các điểm ghim
      - Sắp xếp điểm ghim theo giờ tăng dần
      - Tạo các khoảng trống [T_gap_start, T_gap_end] giữa chúng

    BƯỚC 4: Lấp đầy khoảng trống bằng greedy nearest-neighbor
      - Với mỗi khoảng trống, lần lượt nhét địa điểm tự do:
        + Chọn điểm gần nhất với điểm hiện tại (còn trong giờ mở cửa)
        + Kiểm tra đủ thời gian trong khoảng trống không
        + Nếu đủ → thêm vào lịch, cập nhật vị trí và thời gian hiện tại

    BƯỚC 5: Gắn thông tin di chuyển (transport_to_next) cho từng điểm
    ─────────────────────────────────────────────────────────────
    """
    reorder_notes: list[str] = []
    total_transit_minutes: int = 0

    # Xử lý trường hợp không có hoạt động
    if not activities:
        return [], [], 0

    day_start = time_to_minutes(day_start_time)
    day_end = time_to_minutes(day_end_time)

    # ── BƯỚC 1: Phân loại ────────────────────────────────────────
    locked: list[ActivityInput] = []
    free: list[ActivityInput] = []

    for act in activities:
        if act.is_locked and act.locked_arrive_time:
            locked.append(act)
        else:
            free.append(act)

    logger.info(
        f"[Optimizer] Tối ưu ngày: {len(locked)} điểm ghim, {len(free)} điểm tự do"
    )

    # ── BƯỚC 2: Kiểm tra xung đột điểm ghim ─────────────────────
    conflicts = check_locked_conflicts(locked)
    if conflicts:
        logger.warning(f"[Optimizer] Phát hiện xung đột giờ ghim: {conflicts}")
        # Vẫn tiếp tục tối ưu — không throw lỗi để không block user

    # Sắp xếp điểm ghim theo giờ
    locked.sort(key=lambda a: time_to_minutes(a.locked_arrive_time or "00:00"))

    # ── BƯỚC 3: Xây dựng danh sách khoảng trống ──────────────────
    # Mỗi khoảng trống: (t_start, t_end, last_lat, last_lng)
    # Đại diện cho thời gian trống và vị trí xuất phát
    gaps: list[tuple[int, int, Optional[float], Optional[float]]] = []

    prev_end = day_start
    prev_lat: Optional[float] = None
    prev_lng: Optional[float] = None

    # Tạo khoảng trống trước điểm ghim đầu tiên và giữa các điểm ghim
    for lk in locked:
        lk_arrive = time_to_minutes(lk.locked_arrive_time)
        # Tính thời gian di chuyển cần thiết để đến điểm ghim này
        transit = estimate_transit_minutes(
            haversine_km(prev_lat, prev_lng, lk.lat, lk.lng)
        )
        # Khoảng trống khả dụng: từ prev_end đến (lk_arrive - transit)
        gap_end = lk_arrive - transit
        if gap_end > prev_end:
            gaps.append((prev_end, gap_end, prev_lat, prev_lng))

        # Cập nhật vị trí và thời gian sau điểm ghim này
        prev_end = time_to_minutes(lk.locked_arrive_time) + lk.duration_minutes
        prev_lat = lk.lat
        prev_lng = lk.lng

    # Khoảng trống sau điểm ghim cuối cùng (hoặc toàn bộ ngày nếu không có điểm ghim)
    if prev_end < day_end:
        gaps.append((prev_end, day_end, prev_lat, prev_lng))

    # ── BƯỚC 4: Greedy — lấp đầy khoảng trống ───────────────────
    free_remaining = list(free)  # Sao chép để có thể xóa dần
    scheduled_free: list[tuple[int, ActivityInput]] = []  # (arrive_minutes, activity)

    for gap_start, gap_end, gap_start_lat, gap_start_lng in gaps:
        current_time = gap_start
        current_lat = gap_start_lat
        current_lng = gap_start_lng

        # Tiếp tục nhét địa điểm vào khoảng trống này cho đến khi hết chỗ
        while free_remaining:
            best_idx: Optional[int] = None
            best_dist = float("inf")
            best_arrive: int = 0
            best_transit: int = 0

            # Tìm địa điểm tự do gần nhất có thể nhét vào khoảng trống
            for idx, candidate in enumerate(free_remaining):
                # Tính thời gian di chuyển đến điểm này
                dist = haversine_km(current_lat, current_lng, candidate.lat, candidate.lng)
                transit = estimate_transit_minutes(dist)
                arrive = current_time + transit
                depart = arrive + candidate.duration_minutes

                # Kiểm tra Time Window: đến trong giờ mở cửa
                open_m = time_to_minutes(candidate.open_time)
                close_m = time_to_minutes(candidate.close_time)
                arrive = max(arrive, open_m)  # Chờ đến khi mở cửa nếu đến sớm
                depart = arrive + candidate.duration_minutes

                # Điều kiện nhét được vào khoảng trống:
                # 1. Kết thúc trước khi khoảng trống kết thúc
                # 2. Kết thúc trước khi địa điểm đóng cửa
                # 3. Đến trước hoặc khi địa điểm đóng cửa (trừ duration)
                if (
                    depart <= gap_end
                    and depart <= close_m
                    and arrive < close_m
                    and dist < best_dist
                ):
                    best_idx = idx
                    best_dist = dist
                    best_arrive = arrive
                    best_transit = transit

            # Không tìm được điểm nào phù hợp → dừng lấp khoảng trống này
            if best_idx is None:
                break

            # Nhét điểm tốt nhất vào lịch
            chosen = free_remaining.pop(best_idx)
            scheduled_free.append((best_arrive, chosen))
            total_transit_minutes += best_transit

            # Cập nhật vị trí và thời gian hiện tại
            current_time = best_arrive + chosen.duration_minutes
            current_lat = chosen.lat
            current_lng = chosen.lng

    # Ghi chú nếu có điểm không thể nhét vào lịch
    for leftover in free_remaining:
        reorder_notes.append(
            f"Địa điểm '{leftover.id}' không có khoảng trống phù hợp trong ngày — bị bỏ qua."
        )
        logger.warning(f"[Optimizer] Không thể xếp địa điểm {leftover.id} vào lịch")

    # ── BƯỚC 5: Gộp điểm ghim + điểm tự do, sắp xếp theo giờ ───
    all_scheduled: list[tuple[int, ActivityInput]] = []

    # Thêm điểm ghim với giờ cố định
    for lk in locked:
        all_scheduled.append((time_to_minutes(lk.locked_arrive_time), lk))

    # Thêm điểm tự do đã được xếp giờ
    all_scheduled.extend(scheduled_free)

    # Sắp xếp theo giờ đến tăng dần
    all_scheduled.sort(key=lambda x: x[0])

    # ── BƯỚC 6: Xây dựng kết quả OptimizedActivity ───────────────
    results: list[OptimizedActivity] = []

    for seq, (arrive_min, act) in enumerate(all_scheduled, start=1):
        depart_min = arrive_min + act.duration_minutes

        # Tính transport_to_next (nếu không phải điểm cuối)
        transport_label: Optional[str] = None
        if seq < len(all_scheduled):
            next_arrive_min, next_act = all_scheduled[seq]  # seq = index của phần tử tiếp theo
            transit_dist = haversine_km(act.lat, act.lng, next_act.lat, next_act.lng)
            transport_label = format_transit_label(transit_dist)
            total_transit_minutes += estimate_transit_minutes(transit_dist)

        results.append(
            OptimizedActivity(
                id=act.id,
                place_id=act.place_id,
                sequence_order=seq,
                arrival_time=minutes_to_time(arrive_min),
                departure_time=minutes_to_time(depart_min),
                duration_minutes=act.duration_minutes,
                is_locked=act.is_locked,
                transport_to_next=transport_label,
            )
        )

    # Ghi chú thay đổi thứ tự (so sánh thứ tự cũ vs mới)
    original_ids = [a.id for a in activities]
    new_ids = [r.id for r in results]
    if original_ids != new_ids:
        reorder_notes.append(
            f"Lịch trình đã được sắp xếp lại tối ưu theo tọa độ và time window."
        )

    logger.info(
        f"[Optimizer] Hoàn thành: {len(results)} điểm, "
        f"{total_transit_minutes} phút di chuyển, "
        f"{len(reorder_notes)} ghi chú thay đổi"
    )

    return results, reorder_notes, total_transit_minutes


# ─────────────────────────────────────────────────────────────────
# HÀM VALIDATE XEM GIỜ GHIM MỚI CÓ HỢP LỆ KHÔNG
# ─────────────────────────────────────────────────────────────────

def validate_new_lock_time(
    new_arrive_time: str,
    duration_minutes: int,
    activity_id: str,
    existing_locked: list[ActivityInput],
) -> tuple[bool, list[str], Optional[str]]:
    """
    Kiểm tra xem một giờ ghim mới có gây xung đột không.

    Trả về: (is_valid, conflicts, suggestion)
    - is_valid: True nếu không có xung đột
    - conflicts: Danh sách mô tả xung đột
    - suggestion: Gợi ý giờ thay thế nếu có xung đột
    """
    new_arrive = time_to_minutes(new_arrive_time)
    new_depart = new_arrive + duration_minutes

    conflicts: list[str] = []

    for lk in existing_locked:
        if lk.id == activity_id:
            continue  # Bỏ qua chính nó (trường hợp chỉnh sửa)

        lk_arrive = time_to_minutes(lk.locked_arrive_time or "00:00")
        lk_depart = lk_arrive + lk.duration_minutes

        # Kiểm tra overlap: hai khoảng thời gian chồng nhau
        # [new_arrive, new_depart] ∩ [lk_arrive, lk_depart] ≠ ∅
        if new_arrive < lk_depart and new_depart > lk_arrive:
            conflicts.append(
                f"Trùng với địa điểm {lk.id}: "
                f"{lk.locked_arrive_time} – {minutes_to_time(lk_depart)}"
            )

    if conflicts:
        # Gợi ý: Khe trống ngay sau điểm ghim cuối trước thời điểm muốn ghim
        last_before = max(
            (time_to_minutes(lk.locked_arrive_time or "00:00") + lk.duration_minutes
             for lk in existing_locked
             if time_to_minutes(lk.locked_arrive_time or "00:00") < new_arrive),
            default=time_to_minutes("08:00"),
        )
        # Thêm 10 phút buffer
        suggestion = minutes_to_time(last_before + 10)
        return False, conflicts, f"Gợi ý: {suggestion} là khe trống gần nhất"

    return True, [], None
