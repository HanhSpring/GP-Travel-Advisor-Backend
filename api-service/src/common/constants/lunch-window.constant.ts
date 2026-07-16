/**
 * Khung giờ ăn trưa dùng chung trong api-service.
 * Phải khớp với `LUNCH_START` / `LUNCH_END` trong
 * ai-service/app/services/itinerary/planner.py (nguồn giá trị gốc).
 */
export const LUNCH_START_MIN = 10 * 60 + 30; // 10:30
export const LUNCH_END_MIN = 14 * 60; // 14:00
