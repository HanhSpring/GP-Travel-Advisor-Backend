// Category ID cho "ẩm thực" trong bảng travel.categories — dùng làm 1 trong
// các tín hiệu nhận diện restaurant ở resolvePlannerPlaceType() bên dưới.
export const FOOD_CATEGORY_ID = '97029cfb-069b-4dba-a152-dfb3d36634d3';

/**
 * Nguồn xác định DUY NHẤT "1 địa điểm có phải nhà hàng hay không" trong toàn
 * bộ api-service — dùng chung bởi RecommendationService (build candidate cho
 * planner) và ItineraryService (đối chiếu lại sau khi lưu, xem
 * annotateDaysMissingRestaurant()). Không viết lại logic này ở nơi khác
 * (kể cả ai-service/Python) để tránh 2 định nghĩa "thế nào là nhà hàng" lệch
 * nhau theo thời gian.
 */
export function resolvePlannerPlaceType(
  candidateCategory?: string | null,
  categoryId?: string | null,
  categoryName?: string | null,
  typeName?: string | null,
): 'hotel' | 'restaurant' | 'cafe' | 'entertainment' | 'attraction' {
  const category = (candidateCategory ?? '').toLowerCase();
  const name = (categoryName ?? '').toLowerCase();
  const type = (typeName ?? '').toLowerCase();
  if (category === 'accommodation' || category === 'hotel') {
    return 'hotel';
  }
  if (
    category === 'cafe' ||
    type.includes('cafe') ||
    type.includes('coffee')
  ) {
    return 'cafe';
  }
  if (category === 'entertainment') {
    return 'entertainment';
  }
  if (
    category === 'restaurant' ||
    categoryId === FOOD_CATEGORY_ID ||
    name.includes('ẩm thực') ||
    name.includes('am thuc')
  ) {
    return 'restaurant';
  }
  return 'attraction';
}
