-- Sửa lỗi tạo TRÙNG dòng "Chi phí kế hoạch" cho cùng 1 (itinerary_id,
-- place_id): trước đây recordVisitBaselineExpense()/recordOrderCompletedExpense()
-- (incurred-costs.service.ts) dedupe bằng SELECT-rồi-INSERT/UPDATE ở tầng
-- ứng dụng — không atomic, nên 2 lệnh ghi gần như đồng thời (vd đơn đặt món
-- hoàn tất TAY qua business.service.ts trùng lúc OrdersCompletionCron cũng
-- xử lý cùng đơn, hoặc nhiều người trong đoàn check-in cùng 1 địa điểm gần
-- như cùng lúc) đều SELECT thấy "chưa có" trước khi cái nào kịp INSERT, ra
-- 2 dòng cho cùng 1 địa điểm — khiến "Chi phí kế hoạch" của địa điểm đó bị
-- CỘNG DƯ khi computeActualSpending() tính tổng.

-- 1) Dọn dữ liệu trùng đang có: mỗi (itinerary_id, place_id) chỉ giữ lại
--    dòng 'Chi phí kế hoạch' CẬP NHẬT GẦN NHẤT (updated_at, rồi tới
--    created_at, rồi tới id để có thứ tự tuyệt đối) — đây luôn là giá trị
--    đúng nhất vì mọi lần ghi đè (đơn hàng mới hoàn tất, sửa giá) đều cập
--    nhật thẳng lên dòng, không tạo dòng mới.
delete from travel.incurred_costs t
where t.type = 'Chi phí kế hoạch'
  and exists (
    select 1
    from travel.incurred_costs newer
    where newer.type = 'Chi phí kế hoạch'
      and newer.itinerary_id = t.itinerary_id
      and newer.place_id = t.place_id
      and newer.id <> t.id
      and (newer.updated_at, newer.created_at, newer.id)
        > (t.updated_at, t.created_at, t.id)
  );

-- 2) Chặn triệt để ở tầng DB: 1 (itinerary_id, place_id) chỉ được có TỐI ĐA
--    1 dòng 'Chi phí kế hoạch'. Index PARTIAL (chỉ áp cho type này) vì các
--    type ad-hoc khác (Nước uống/Quà tặng/Mua sắm/Phí gửi xe/Khác) vẫn được
--    phép có nhiều dòng cho cùng 1 địa điểm (mỗi lần phát sinh 1 khoản mới).
create unique index if not exists incurred_costs_baseline_dedupe_idx
  on travel.incurred_costs (itinerary_id, place_id)
  where type = 'Chi phí kế hoạch';
