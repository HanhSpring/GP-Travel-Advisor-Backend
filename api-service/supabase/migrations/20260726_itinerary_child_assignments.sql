-- Cho phép chủ lịch trình gán "phụ trách N trẻ em" cho từng thành viên cụ
-- thể, thay vì mặc định cứng toàn bộ chi phí trẻ em luôn thuộc về chủ lịch
-- trình (xem distributeCosts()'s childrenAssignedTo trước đây). Chỉ lưu SỐ
-- LƯỢNG trẻ mỗi thành viên phụ trách — không cần danh tính riêng cho từng
-- trẻ (không có "Trẻ 1", "Trẻ 2"...), vì itineraries không có bảng trẻ em
-- nào để tham chiếu tới, chỉ có children_count là 1 con số.
--
-- Không bắt buộc phải có đủ dòng cho mọi lịch trình có trẻ em — nếu bảng
-- này trống (hoặc tổng child_count < children_count), phần CÒN LẠI mặc
-- định vẫn thuộc về chủ lịch trình, giữ đúng hành vi cũ cho lịch trình
-- chưa từng gán ai.
create table if not exists travel.itinerary_child_assignments (
  id uuid primary key default gen_random_uuid(),
  itinerary_id uuid not null references travel.itineraries(id) on delete cascade,
  tourist_id uuid not null,
  child_count integer not null check (child_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (itinerary_id, tourist_id)
);

comment on table travel.itinerary_child_assignments is
  'Số trẻ em mỗi thành viên (tourist_id) phụ trách trong 1 lịch trình — dùng để chia childrenShare ở IncurredCostsService.distributeCosts() thay vì gán cứng 100% cho chủ lịch trình. Tổng child_count của các dòng cho 1 itinerary_id không bắt buộc phải bằng travel.itineraries.children_count; phần chưa gán mặc định thuộc về chủ lịch trình.';

create index if not exists itinerary_child_assignments_itinerary_id_idx
  on travel.itinerary_child_assignments (itinerary_id);
