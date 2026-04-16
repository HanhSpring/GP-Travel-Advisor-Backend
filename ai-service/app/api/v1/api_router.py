"""
Router tổng hợp cho API v1.
Tất cả endpoint router của các module được đăng ký tại đây,
sau đó được mount vào app chính trong main.py.
"""

from fastapi import APIRouter
from app.api.v1.endpoints.itinerary import router as itinerary_router

# Router cha chứa toàn bộ v1 API
api_router = APIRouter(prefix="/api/v1")

# Đăng ký các sub-router
api_router.include_router(itinerary_router)

# Thêm router khác tại đây khi mở rộng tính năng:
# api_router.include_router(recommendation_router)
# api_router.include_router(weather_router)
