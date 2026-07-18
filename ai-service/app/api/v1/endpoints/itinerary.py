"""
FastAPI router cho tính năng tối ưu lịch trình.

Endpoints:
  POST /api/v1/itinerary/optimize  — Tối ưu sắp xếp thứ tự và thời gian một ngày
  POST /api/v1/itinerary/validate  — Kiểm tra xung đột giờ ghim trước khi lưu DB
"""

import logging
from fastapi import APIRouter, HTTPException

from app.schemas.optimize import (
    OptimizeRequest,
    OptimizeResponse,
    ValidateRequest,
    ValidateResponse,
)
from app.services.itinerary_optimizer import (
    optimize_day_schedule,
    validate_new_lock_time,
)

# Khởi tạo logger để debug trên server
logger = logging.getLogger(__name__)

# Tạo router với prefix và tag (sẽ được mount vào app chính trong main.py)
router = APIRouter(prefix="/itinerary", tags=["Itinerary Optimizer"])


@router.post(
    "/optimize",
    response_model=OptimizeResponse,
    summary="Tối ưu lịch trình một ngày",
    description=(
        "Nhận danh sách hoạt động trong một ngày (bao gồm điểm ghim giờ và điểm tự do). "
        "Trả về lịch đã sắp xếp tối ưu theo thuật toán Greedy TSPTW.\n\n"
        "**Ràng buộc cứng (Hard Constraints):**\n"
        "- Điểm `is_locked=True` → giữ nguyên giờ đến\n"
        "- Điểm phải trong giờ mở cửa (`open_time` → `close_time`)\n\n"
        "**Ràng buộc mềm (Soft Constraints):**\n"
        "- Thứ tự điểm tự do được tối ưu theo khoảng cách gần nhất\n"
        "- Ưu tiên nhét vào khoảng trống phù hợp nhất"
    ),
)
async def optimize_itinerary(request: OptimizeRequest) -> OptimizeResponse:
    """
    Tối ưu sắp xếp thứ tự và thời gian các hoạt động trong một ngày.

    Luồng xử lý:
    1. Nhận OptimizeRequest từ NestJS
    2. Gọi optimizer.optimize_day_schedule()
    3. Trả về OptimizeResponse với lịch đã sắp xếp
    NestJS nhận kết quả và cập nhật vào bảng itinerary_details trên Supabase.
    """
    logger.info(
        f"[/optimize] Bắt đầu tối ưu: itinerary_id={request.itinerary_id}, "
        f"visit_date={request.visit_date}, "
        f"số hoạt động={len(request.activities)}"
    )

    from starlette.concurrency import run_in_threadpool

    try:
        optimized_activities, reorder_notes, total_transit = await run_in_threadpool(
            optimize_day_schedule,
            activities=request.activities,
            day_start_time=request.day_start_time,
            day_end_time=request.day_end_time,
            allow_reduce_time=request.allow_reduce_time,
            use_goong=request.use_goong,
            travel_vehicle=request.travel_vehicle,
        )

        # Tính tổng chi phí trong ngày
        total_cost = sum(a.estimated_cost for a in request.activities)

        logger.info(
            f"[/optimize] Hoàn thành: {len(optimized_activities)} điểm, "
            f"{total_transit} phút di chuyển"
        )

        return OptimizeResponse(
            success=True,
            itinerary_id=request.itinerary_id,
            visit_date=request.visit_date,
            optimized_activities=optimized_activities,
            reorder_notes=reorder_notes,
            total_cost=total_cost,
            total_transit_minutes=total_transit,
        )

    except ValueError as e:
        # Lỗi validation dữ liệu đầu vào (VD: giờ không hợp lệ)
        logger.warning(f"[/optimize] Lỗi dữ liệu đầu vào: {e}")
        raise HTTPException(status_code=422, detail=str(e))

    except Exception as e:
        # Lỗi không mong muốn — log chi tiết để debug
        logger.error(f"[/optimize] Lỗi không mong muốn: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi khi tối ưu lịch trình: {str(e)}"
        )


@router.post(
    "/validate",
    response_model=ValidateResponse,
    summary="Kiểm tra xung đột giờ ghim",
    description=(
        "Kiểm tra xem một giờ ghim mới có gây xung đột với các điểm ghim khác trong ngày không.\n\n"
        "Endpoint này nên được gọi **trước khi lưu DB** để cảnh báo user sớm, "
        "tránh tình huống user bấm 'Lưu' mà sau đó nhận được lịch lộn xộn."
    ),
)
async def validate_lock_time(request: ValidateRequest) -> ValidateResponse:
    """
    Kiểm tra một giờ ghim mới có xung đột với các điểm đã ghim không.

    Trả về:
    - is_valid=True → Không xung đột, an toàn để lưu
    - is_valid=False → Có xung đột, kèm suggestion giờ thay thế
    """
    logger.info(
        f"[/validate] Kiểm tra giờ ghim: activity_id={request.activity_id}, "
        f"new_arrive_time={request.new_arrive_time}"
    )

    try:
        is_valid, conflicts, suggestion = validate_new_lock_time(
            new_arrive_time=request.new_arrive_time,
            duration_minutes=request.duration_minutes,
            activity_id=request.activity_id,
            existing_locked=request.locked_activities,
        )

        return ValidateResponse(
            is_valid=is_valid,
            conflicts=conflicts,
            suggestion=suggestion,
        )

    except ValueError as e:
        logger.warning(f"[/validate] Lỗi dữ liệu: {e}")
        raise HTTPException(status_code=422, detail=str(e))

    except Exception as e:
        logger.error(f"[/validate] Lỗi không mong muốn: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi khi kiểm tra xung đột: {str(e)}"
        )
