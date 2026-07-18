-- Gộp chi phí về 1 nguồn duy nhất: incurred_costs giờ còn chứa cả "chi phí
-- kế hoạch" của các địa điểm/khách sạn ĐÃ CHECK-IN (tự động ghi bởi
-- IncurredCostsService.recordVisitBaselineExpense() ngay khi
-- itinerary-tracking.service.ts đánh dấu 1 detail là "visited"), thay vì
-- backend phải tính TƯƠI mỗi lần từ places/itinerary_details + lọc theo
-- geofence_visits. "Điều chỉnh giá" tiếp tục cộng dồn lên trên baseline này
-- y hệt trước — chỉ khác nguồn baseline giờ đã LƯU thay vì tính lại.
--
-- 2 type mới:
--   - 'Chi phí kế hoạch': dòng TỰ ĐỘNG, không cho user tạo/sửa tay qua sheet
--     — luôn gắn place_id (chính là địa điểm/khách sạn vừa check-in), amount
--     tính theo 1 người lớn (giống ý nghĩa basePlanCost hiện tại), không bao
--     giờ âm.
--   - 'Điều chỉnh xăng xe': điều chỉnh thủ công CHO CẢ CHUYẾN (không theo
--     ngày, không theo địa điểm) — amount là delta, có thể âm, giống hệt
--     'Điều chỉnh giá' nhưng không cần anchor nào cả.
--
-- day_number: gắn 1 khoản chi (loại ad-hoc thường) vào ngày thứ N khi không
-- gắn địa điểm cụ thể — để "Tổng quan ngày" ở Chi tiết lịch trình cộng đúng
-- cả những khoản không thuộc 1 địa điểm nào.

alter table travel.incurred_costs
  drop constraint if exists incurred_costs_type_check;
alter table travel.incurred_costs
  add constraint incurred_costs_type_check
  check (type in (
    'Điều chỉnh giá', 'Nước uống', 'Quà tặng', 'Mua sắm', 'Phí gửi xe', 'Khác',
    'Chi phí kế hoạch',
    'Điều chỉnh xăng xe'
  ));

-- 'Điều chỉnh xăng xe' cũng là delta có thể âm, giống 'Điều chỉnh giá'.
alter table travel.incurred_costs
  drop constraint if exists incurred_costs_amount_check;
alter table travel.incurred_costs
  add constraint incurred_costs_amount_check
  check (type in ('Điều chỉnh giá', 'Điều chỉnh xăng xe') or amount > 0);

alter table travel.incurred_costs
  add column if not exists day_number integer null;

-- 'Chi phí kế hoạch' luôn phải gắn place_id (không có ý nghĩa nếu không gắn
-- địa điểm/khách sạn nào) — constraint riêng, không đụng vào
-- incurred_costs_price_adjustment_place_check hiện có (vẫn chỉ áp cho
-- 'Điều chỉnh giá').
alter table travel.incurred_costs
  drop constraint if exists incurred_costs_baseline_place_check;
alter table travel.incurred_costs
  add constraint incurred_costs_baseline_place_check
  check (type <> 'Chi phí kế hoạch' or place_id is not null);

comment on column travel.incurred_costs.day_number is
  'Gắn khoản chi vào ngày thứ N (1-indexed) khi không gắn place_id cụ thể — dùng cho chi phí ad-hoc chung không thuộc 1 địa điểm nào. Không dùng cho ''Chi phí kế hoạch'' (luôn có place_id) hay ''Điều chỉnh xăng xe'' (áp dụng cả chuyến, không theo ngày).';
comment on column travel.incurred_costs.type is
  '''Chi phí kế hoạch'' = dòng tự động khi 1 địa điểm/khách sạn được check-in (place_id required, amount > 0, không cho user tạo/sửa tay). ''Điều chỉnh xăng xe'' = điều chỉnh thủ công cho cả chuyến (không anchor, amount là delta có thể âm). ''Điều chỉnh giá'' = owner-only correction cho 1 địa điểm (amount là delta, place_id required, charged_to forced empty). Còn lại (''Nước uống''/''Quà tặng''/''Mua sắm''/''Phí gửi xe''/''Khác'') là ad-hoc personal spend như cũ.';
