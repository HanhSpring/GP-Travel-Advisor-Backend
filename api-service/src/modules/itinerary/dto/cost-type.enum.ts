/**
 * "Điều chỉnh giá": correction to a place's system-estimated price.
 * Owner-only, always tied to a place, amount is a signed delta applied once
 * to the shared per-adult base cost — never charged to specific members.
 *
 * Everything else is an ad-hoc spend: any member logs it, positive amount
 * only, charged to whoever is ticked (empty = split evenly).
 *
 * Giá trị lưu trong DB/API là tiếng Việt có dấu — cả hệ thống (DB, API,
 * mobile) đều dùng chung 1 chuỗi này, không có bản dịch/slug tiếng Anh nào
 * khác đứng giữa.
 */
export enum CostType {
  DIEU_CHINH_GIA = 'Điều chỉnh giá',
  NUOC_UONG = 'Nước uống',
  QUA_TANG = 'Quà tặng',
  MUA_SAM = 'Mua sắm',
  PHI_GUI_XE = 'Phí gửi xe',
  KHAC = 'Khác',
  /** Dòng TỰ ĐỘNG khi 1 địa điểm/khách sạn được check-in (visited) — không
   * cho user tạo/sửa tay qua sheet. Luôn gắn place_id, amount > 0, tính theo
   * 1 người lớn (giống ý nghĩa basePlanCost). Xem
   * IncurredCostsService.recordVisitBaselineExpense(). */
  CHI_PHI_KE_HOACH = 'Chi phí kế hoạch',
  /** Điều chỉnh thủ công cho CẢ CHUYẾN (không gắn place_id/day_number) —
   * amount là delta có thể âm, giống DIEU_CHINH_GIA nhưng không cần anchor. */
  DIEU_CHINH_XANG_XE = 'Điều chỉnh xăng xe',
}
