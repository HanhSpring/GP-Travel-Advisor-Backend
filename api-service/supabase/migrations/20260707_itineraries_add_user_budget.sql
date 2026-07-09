-- itineraries.estimated_cost is repurposed to hold the user's original input
-- budget (trip_budget_total), not a computed cost — the actual calculated
-- cost ("Chi phí ước tính") is now derived fresh at read time by summing
-- itinerary_details.estimated_cost (already group_total per row; hotel is a
-- single full-stay row), so it never goes stale after the user edits the
-- itinerary. No column rename needed since the type/semantics (nullable
-- money value) stay compatible — only the comment changes.
comment on column travel.itineraries.estimated_cost
  is 'Mức ngân sách người dùng nhập ban đầu (VND). "Chi phí ước tính" hiển thị cho người dùng được tính tươi từ SUM(itinerary_details.estimated_cost), không đọc từ cột này.';

alter table travel.itineraries
  add column if not exists proceeded_over_budget boolean not null default false;

comment on column travel.itineraries.proceeded_over_budget
  is 'True nếu người dùng xác nhận tiếp tục dù lịch trình vượt ngân sách đề xuất (bỏ qua cảnh báo BUDGET_CONFIRMATION_REQUIRED).';
