"""
Pydantic v2 schemas cho tính năng tối ưu lịch trình.

Luồng dữ liệu:
  NestJS → POST /api/v1/itinerary/optimize → OptimizeRequest
  FastAPI → OptimizeResponse → NestJS → cập nhật DB → Flutter
"""

from pydantic import BaseModel, Field, field_validator
from typing import Optional
import re


# ─────────────────────────────────────────────────────────────────
# SCHEMAS CHO REQUEST TỐI ƯU LỊCH TRÌNH
# ─────────────────────────────────────────────────────────────────

class ActivityInput(BaseModel):
    """
    Thông tin một hoạt động đầu vào để tối ưu.
    Tương ứng với một bản ghi trong bảng travel.itinerary_details.
    """
    id: str = Field(..., description="ID bản ghi itinerary_details")
    place_id: str = Field(..., description="ID địa điểm trong travel.places")

    # Thời gian
    duration_minutes: int = Field(
        default=60,
        ge=15,
        le=480,
        description="Thời gian tham quan (phút)"
    )

    # Ràng buộc ghim giờ (Hard Constraint)
    is_locked: bool = Field(
        default=False,
        description="True = giờ đã ghim, optimizer phải giữ nguyên"
    )
    locked_arrive_time: Optional[str] = Field(
        default=None,
        description="Giờ ghim định dạng HH:mm (chỉ dùng khi is_locked=True)"
    )

    # Tọa độ địa lý (để tính khoảng cách)
    lat: Optional[float] = Field(default=None, description="Vĩ độ")
    lng: Optional[float] = Field(default=None, description="Kinh độ")

    # Giờ mở/đóng cửa (Time Window Constraint)
    open_time: str = Field(default="07:00", description="Giờ mở cửa HH:mm")
    close_time: str = Field(default="22:00", description="Giờ đóng cửa HH:mm")

    # Thông tin mới phục vụ CP-SAT constraints
    category: Optional[str] = Field(default=None, description="Danh mục địa điểm (vd: 'chợ đêm', 'nhà thờ')")
    is_restaurant: bool = Field(default=False, description="True nếu địa điểm là nhà hàng/quán ăn")
    original_arrival_time: Optional[str] = Field(default=None, description="Giờ đến gốc (nếu đã có)")
    is_new: bool = Field(default=False, description="True nếu đây là địa điểm vừa được thêm vào cần chèn")

    # Chi phí
    estimated_cost: float = Field(default=0.0, description="Chi phí ước tính (VNĐ)")

    @field_validator("locked_arrive_time", "open_time", "close_time", "original_arrival_time", mode="before")
    @classmethod
    def validate_time_format(cls, v: Optional[str]) -> Optional[str]:
        """Kiểm tra định dạng HH:mm"""
        if v is None:
            return v
        if not re.match(r"^\d{2}:\d{2}$", v):
            raise ValueError(f"Thời gian phải đúng định dạng HH:mm, nhận được: {v}")
        h, m = map(int, v.split(":"))
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError(f"Giờ hoặc phút không hợp lệ: {v}")
        return v


class OptimizeRequest(BaseModel):
    """
    Request body gửi từ NestJS sang FastAPI để tối ưu một ngày trong lịch trình.
    """
    itinerary_id: str = Field(..., description="ID lịch trình")
    visit_date: str = Field(
        ...,
        description="Ngày tối ưu định dạng YYYY-MM-DD",
        examples=["2026-06-15"]
    )

    # Danh sách hoạt động trong ngày cần tối ưu
    activities: list[ActivityInput] = Field(
        ...,
        min_length=1,
        description="Danh sách hoạt động cần sắp xếp (ít nhất 1)"
    )

    # Khung giờ hoạt động trong ngày
    day_start_time: str = Field(
        default="07:00",
        description="Giờ bắt đầu ngày HH:mm"
    )
    day_end_time: str = Field(
        default="22:00",
        description="Giờ kết thúc ngày HH:mm"
    )

    allow_reduce_time: bool = Field(
        default=False,
        description="Cho phép AI tự động giảm bớt duration_minutes của các điểm khác nếu lịch quá kín"
    )

    # Đồng bộ nguồn dữ liệu thời gian di chuyển với luồng TẠO lịch trình:
    # ưu tiên Goong Distance Matrix API (cache DB/local) trước, chỉ fallback
    # sang Haversine khi thiếu key hoặc gọi Goong thất bại.
    use_goong: bool = Field(
        default=True,
        description="True = ưu tiên dùng Goong Distance Matrix API (có cache) cho thời gian di chuyển thực tế, giống luồng tạo lịch trình. False = chỉ dùng Haversine."
    )
    travel_vehicle: str = Field(
        default="bike",
        description="Phương tiện di chuyển: 'bike' (xe máy) hoặc 'car' (ô tô) — quyết định travel_mode khi gọi Goong"
    )

    @field_validator("day_start_time", "day_end_time", mode="before")
    @classmethod
    def validate_day_times(cls, v: str) -> str:
        """Kiểm tra định dạng HH:mm cho khung giờ ngày"""
        if not re.match(r"^\d{2}:\d{2}$", v):
            raise ValueError(f"Thời gian phải đúng định dạng HH:mm: {v}")
        return v


# ─────────────────────────────────────────────────────────────────
# SCHEMAS CHO RESPONSE TỐI ƯU LỊCH TRÌNH
# ─────────────────────────────────────────────────────────────────

class OptimizedActivity(BaseModel):
    """
    Kết quả tối ưu cho một hoạt động.
    NestJS sẽ dùng thông tin này để cập nhật lại DB.
    """
    id: str = Field(..., description="ID bản ghi itinerary_details (giữ nguyên để map ngược)")
    place_id: str = Field(..., description="ID địa điểm")
    sequence_order: int = Field(..., description="Thứ tự mới trong ngày (bắt đầu từ 1)")
    arrival_time: str = Field(..., description="Giờ đến HH:mm")
    departure_time: str = Field(..., description="Giờ rời đi HH:mm")
    duration_minutes: int = Field(..., description="Thời gian tham quan (phút)")
    is_locked: bool = Field(..., description="Có đang ghim giờ không")

    # Thông tin di chuyển đến địa điểm tiếp theo (để hiển thị trên UI)
    transport_to_next: Optional[str] = Field(
        default=None,
        description="Ước tính thời gian di chuyển đến điểm tiếp theo. VD: '15 phút đi xe máy'"
    )


class OptimizeResponse(BaseModel):
    """
    Response trả về từ FastAPI sau khi tối ưu xong.
    """
    success: bool = Field(default=True)
    itinerary_id: str
    visit_date: str

    # Lịch tối ưu — đã sắp xếp theo sequence_order tăng dần
    optimized_activities: list[OptimizedActivity]

    # Ghi chú về các thay đổi (để hiển thị thông báo cho user)
    reorder_notes: list[str] = Field(
        default_factory=list,
        description="Mô tả các thay đổi thứ tự. VD: 'Dời Bảo tàng từ 10:00 → 11:30'"
    )

    # Tổng chi phí và tổng thời gian di chuyển trong ngày
    total_cost: float = Field(default=0.0, description="Tổng chi phí ước tính trong ngày (VNĐ)")
    total_transit_minutes: int = Field(
        default=0,
        description="Tổng thời gian di chuyển trong ngày (phút)"
    )


# ─────────────────────────────────────────────────────────────────
# SCHEMAS CHO VALIDATE (KIỂM TRA XUNG ĐỘT GIỜ GHIM)
# ─────────────────────────────────────────────────────────────────

class ValidateRequest(BaseModel):
    """
    Kiểm tra xem một giờ ghim mới có gây xung đột với các giờ ghim khác không.
    Dùng trước khi lưu DB để cảnh báo user sớm.
    """
    itinerary_id: str
    visit_date: str
    activity_id: str = Field(..., description="ID hoạt động muốn ghim giờ mới")
    new_arrive_time: str = Field(..., description="Giờ muốn ghim HH:mm")
    duration_minutes: int = Field(default=60, ge=15)

    # Danh sách các hoạt động đã ghim trong ngày (để kiểm tra xung đột)
    locked_activities: list[ActivityInput] = Field(
        default_factory=list,
        description="Các hoạt động đã ghim giờ trong cùng ngày"
    )


class ValidateResponse(BaseModel):
    """
    Kết quả kiểm tra xung đột giờ ghim.
    """
    is_valid: bool = Field(..., description="True = không có xung đột")
    conflicts: list[str] = Field(
        default_factory=list,
        description="Danh sách mô tả xung đột (rỗng nếu is_valid=True)"
    )
    suggestion: Optional[str] = Field(
        default=None,
        description="Gợi ý giờ thay thế nếu có xung đột. VD: '10:30 là khe trống gần nhất'"
    )
