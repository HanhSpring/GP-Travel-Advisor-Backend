-- Bảng chi phí ước tính ĐÓNG BĂNG mỗi lịch trình — thay cho việc
-- withEstimatedListCosts() phải tính real-time calculateTripCostBreakdown()
-- cho từng lịch trình trong danh sách (N itinerary song song = N x 5-13
-- round-trip DB, xem itinerary-list-cost-db-load-issue.md).
--
-- "Ước tính" giờ tách bạch tuyệt đối khỏi "đã chi/thực tế": place_cost/
-- hotel_cost luôn lấy từ itinerary_details.estimated_cost RAW (không bao giờ
-- ưu tiên giá đã sửa qua check-in/"Sửa giá"), transport_cost chỉ tính từ
-- khoảng cách thật (distance_matrix/Goong), không cộng "Điều chỉnh xăng xe"
-- (khoản đó chỉ tồn tại trong incurred_costs, thuộc luồng "đã chi").
--
-- calculated_trip_cost lưu bản ĐÃ CỘNG 10% dự trù + làm tròn hàng trăm nghìn
-- (per-adult) — số hiển thị thẳng ra UI, tránh phải lặp lại phép tính này ở
-- mọi nơi đọc cache.
--
-- Chỉ ghi đè khi: (1) lịch trình vừa tạo xong, (2) sửa cấu trúc lịch trình
-- (thêm/xóa/đổi hoạt động). KHÔNG ghi đè khi check-in/"Sửa giá"/"Điều chỉnh
-- xăng xe" — các luồng đó chỉ đụng incurred_costs.
create table if not exists travel.itinerary_cost_estimates (
  itinerary_id uuid primary key
    references travel.itineraries (id) on delete cascade,
  place_cost numeric(12, 2) not null default 0,
  hotel_cost numeric(12, 2) not null default 0,
  transport_cost numeric(12, 2) not null default 0,
  calculated_trip_cost numeric(12, 2) not null default 0,
  updated_at timestamptz not null default now()
);

-- Lưu lại snapshot khoảng cách/chi phí xăng của từng chặng ngay trên dòng
-- hoạt động, thay vì luôn phải tính lại từ distance_matrix mỗi lần đọc (xem
-- hydrateMissingTravelSnapshots() — hiện KHÔNG có cột nào để biết "đã tính
-- rồi", nên luôn coi mọi chặng là thiếu và query distance_matrix lại từ đầu
-- ở MỌI lần gọi, kể cả đọc lại đúng 1 lịch trình nhiều lần liên tiếp).
--
-- Các cột này từng tồn tại (20260703200000_distance_matrix_and_itinerary_snapshot.sql)
-- rồi bị drop 10 phút sau (20260703210000_normalize_itinerary_travel_to_matrix.sql)
-- để luôn tính tươi từ distance_matrix. Lần này thêm lại kèm cơ chế reset về
-- null tại mọi điểm sửa cấu trúc lịch trình (đổi thứ tự chặng) để tránh lặp
-- lại vấn đề stale data trước đây.
alter table travel.itinerary_details
  add column if not exists transport_cost numeric(12, 2),
  add column if not exists travel_distance_km numeric(8, 2),
  add column if not exists travel_minutes integer;
