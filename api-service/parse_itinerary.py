import json
import sys

def parse_itinerary():
    file_path = 'logs/itinerary-plan-debug/json/2026-07-11T08-47-02-679Z_hue_kham-pha-tong-hop_8days_top160.json'
    out_path = 'output.md'
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"Error loading JSON: {e}")
        return

    places = {}
    for p in data.get('plannerInputPlaces', []):
        places[p['placeId']] = p

    req = data.get('request', {})
    price_est = data.get('priceEstimate', {})
    days = data.get('days', [])
    timings = data.get('timingsMs', {})

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write("### 1. Thông tin đầu vào (Input & Budget)\n")
        f.write(f"- **Thời gian chạy (Solver Time):** {timings.get('solver', 0) / 1000} giây (Tổng Backend: {timings.get('backendTotal', 0) / 1000} giây)\n")
        f.write(f"- **Mục đích chuyến đi:** {req.get('tripIntent')}\n")
        f.write(f"- **Thời gian:** {req.get('startDate')} đến {req.get('endDate')} ({req.get('numDays')} ngày)\n")
        f.write(f"- **Số lượng khách:** {price_est.get('travelers', {}).get('adults', 0)} người lớn, {price_est.get('travelers', {}).get('children', 0)} trẻ em\n")
        f.write(f"- **Ngân sách giới hạn (User Budget Limit):** {price_est.get('userBudgetVnd', 0):,} VND\n")
        f.write(f"- **Chi phí ước tính toàn bộ (Estimated Cost):** {price_est.get('totalVnd', 0):,} VND\n\n")

        f.write("### 2. Chi tiết Lịch trình từng ngày\n")
        
        for d in days:
            day_index = d.get('day')
            f.write(f"#### Ngày {day_index}\n")
            f.write(f"- **Tổng số địa điểm (Visited Count):** {d.get('visitedCount')} / {d.get('targetVisitedCount')}\n")
            f.write(f"- **Số nhà hàng (Restaurant Count):** {d.get('restaurantCount')}\n")
            f.write(f"- **Tổng chi phí ngày (Total Day Cost):** {d.get('totalDayCost', 0):,} VND\n")
            f.write(f"- **Thời gian hoạt động (Visit/Travel):** {d.get('totalVisitMinutes')} phút tham quan, {d.get('totalTravelMinutes')} phút di chuyển, {d.get('totalDistanceKm')} km\n")
            f.write(f"- **Vi phạm (Violations):** {d.get('totalHardViolations')} Hard Violations, {d.get('mealViolations')} Meal Violations\n\n")

            f.write("| Thời gian | Sự kiện | Loại hình | Chi phí ước tính (VND) | Khung giờ tốt nhất | Giờ mở/đóng |\n")
            f.write("|---|---|---|---|---|---|\n")
            
            schedule = d.get('schedule', [])
            
            prev_departure = None
            
            for idx, item in enumerate(schedule):
                arr_time = item.get('arrivalTime')
                start_time = item.get('serviceStartTime')
                dep_time = item.get('departureTime')
                loc_id = item.get('locationId')
                loc_name = item.get('locationName')
                type_name = item.get('type')
                est_cost = item.get('estimatedCost', 0)
                
                place_info = places.get(loc_id, {})
                best_time = place_info.get('bestTime', '')
                open_hour = place_info.get('openHourCompressed', '')
                
                if prev_departure and arr_time and prev_departure != arr_time:
                    f.write(f"| {prev_departure} - {arr_time} | Di chuyển | travel | 0 | - | - |\n")
                
                if start_time and dep_time:
                    cost_str = f"{est_cost:,}" if est_cost else "0"
                    f.write(f"| {start_time} - {dep_time} | {loc_name} | {type_name} | {cost_str} | {best_time} | {open_hour} |\n")
                    
                    prev_departure = dep_time
                    
            f.write("\n")

if __name__ == '__main__':
    parse_itinerary()
